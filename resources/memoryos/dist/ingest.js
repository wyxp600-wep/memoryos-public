/**
 * MemoryOS — 采集消化（ingest）：读取本机各 AI Agent 的明文记忆/规则/对话，提炼入库。
 * 流程：源发现 → 读文本 → 分块 → 本地嵌入 → 库内相似去重 → LLM 提炼 → writeMemory 入库。
 * 只覆盖「明文可读」的知识源；不可读（私有/加密/沙箱）如实不采。
 * 用法：getSources() 枚举可采源；ingestAll(db,{dryLimit}) 执行。
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { getEmbedder, cosine } from "./embed.js";
import { writeMemory, logUsage, logDaemon, getVectorsOnProject, getIngestStates, setIngestState } from "./db.js";
import { extractFromSource } from "./llm.js";
const MAX_CALLS = Math.max(1, Number(process.env.INGEST_MAX_CALLS ?? 80) || 80); // 单轮 LLM 提炼总次数上限（默认80，覆盖环境变量）
const BLOCKS_PER_SOURCE = 12; // 每源最多提炼块数（防单源吃掉全部预算）
const home = os.homedir();
/** 明文知识源清单：以「真实存在」为准，运行时可读才返回 */
const SOURCE_SPECS = [
    { id: "codex-rules", agent: "codex", name: "Codex 规则 default.rules", kind: "rule", exp: (h) => [`${h}/.codex/rules/default.rules`] },
    { id: "codex-agents", agent: "codex", name: "Codex 全局约束 AGENTS.md", kind: "rule", exp: (h) => [`${h}/.codex/AGENTS.md`] },
    { id: "codex-mem-raw", agent: "codex", name: "Codex 原始记忆 raw_memories", kind: "memory", exp: (h) => [`${h}/.codex/memories/raw_memories.md`] },
    { id: "codex-mem-diff", agent: "codex", name: "Codex 工作区差异记忆", kind: "memory", exp: (h) => [`${h}/.codex/memories/phase2_workspace_diff.md`] },
    { id: "codex-mem-rollout", agent: "codex", name: "Codex 会话摘要(rollout)", kind: "memory", exp: (h) => glob(`${h}/.codex/memories/rollout_summaries/*.md`, { maxFiles: 15, includeFilter: (n) => /report-summary|session-summary/i.test(n) }) },
    { id: "zcode-mem", agent: "zcode", name: "ZCode 记忆", kind: "memory", exp: (h) => glob(`${h}/.zcode/cli/memories/**`, { maxFiles: 20, maxDepth: 2 }) },
    { id: "zcode-log", agent: "zcode", name: "ZCode 对话日志 jsonl", kind: "convo", exp: (h) => glob(`${h}/.zcode/cli/log/*.jsonl`, { maxFiles: 8, includeFilter: (n) => /\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) }) },
    { id: "zcode-agents", agent: "zcode", name: "ZCode 会话 agents", kind: "convo", exp: (h) => glob(`${h}/.zcode/cli/agents/sess_*/transcript.jsonl`, { maxFiles: 8, maxDepth: 2, includeFilter: (n) => n === "transcript.jsonl" }) },
    { id: "claude-config", agent: "claude", name: "Claude 配置 config.json", kind: "rule", exp: (h) => [`${h}/.claude/config.json`] },
    { id: "claude-settings", agent: "claude", name: "Claude 设置 settings.json", kind: "rule", exp: (h) => [`${h}/.claude/settings.json`] },
    { id: "wb-memory", agent: "workbuddy", name: "WorkBuddy MEMORY", kind: "rule", exp: (h) => [`${h}/.workbuddy/MEMORY.md`] },
    { id: "wb-user", agent: "workbuddy", name: "WorkBuddy USER", kind: "memory", exp: (h) => [`${h}/.workbuddy/USER.md`] },
    { id: "wb-soul", agent: "workbuddy", name: "WorkBuddy SOUL", kind: "rule", exp: (h) => [`${h}/.workbuddy/SOUL.md`] },
    { id: "wb-identity", agent: "workbuddy", name: "WorkBuddy IDENTITY", kind: "memory", exp: (h) => [`${h}/.workbuddy/IDENTITY.md`] },
    { id: "wbai-memory", agent: "workbuddy-ai", name: "WorkBuddy AI UUID 记忆", kind: "memory", exp: (h) => glob(`${h}/.workbuddy-ai/memory/*_memory.md`, { maxFiles: 20, maxDepth: 1, includeFilter: (n) => /_memory\.md$/.test(n) && !n.endsWith(".bak") }) },
    // Trae CN 记忆系统（~/.trae-cn/memory/）
    { id: "trae-user-profile", agent: "trae", name: "Trae 用户画像 user_profile", kind: "memory", exp: (h) => [`${h}/.trae-cn/memory/user_profile.md`] },
    { id: "trae-project-mem", agent: "trae", name: "Trae 项目记忆 project_memory", kind: "memory", exp: (h) => glob(`${h}/.trae-cn/memory/projects/*/project_memory.md`, { maxFiles: 10, maxDepth: 3, includeFilter: (n) => n === "project_memory.md" }) },
    { id: "trae-topics", agent: "trae", name: "Trae 会话主题 topics", kind: "convo", exp: (h) => glob(`${h}/.trae-cn/memory/projects/**/topics.md`, { maxFiles: 30, maxDepth: 4, includeFilter: (n) => n === "topics.md" }) },
    { id: "trae-session-jsonl", agent: "trae", name: "Trae 会话明细 session_memory", kind: "convo", transform: "trae-learned", exp: (h) => glob(`${h}/.trae-cn/memory/projects/**/session_memory_*.jsonl`, { maxFiles: 20, maxDepth: 4, includeFilter: (n) => n.startsWith("session_memory_") && n.endsWith(".jsonl") }) },
    // ── 2026-09-11 补采：审计日志风险事件 + 各 Agent 会话记录（实测这些源此前完全未采）──
    { id: "wb-audit", agent: "workbuddy", name: "WorkBuddy 审计日志(风险/决策事件)", kind: "convo", transform: "audit-jsonl", exp: (h) => glob(`${h}/.workbuddy/audit-log/*.jsonl`, { maxFiles: 8, maxDepth: 1, includeFilter: (n) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(n) }) },
    { id: "wbai-audit", agent: "workbuddy-ai", name: "WorkBuddy AI 审计日志(风险/决策事件)", kind: "convo", transform: "audit-jsonl", exp: (h) => glob(`${h}/.workbuddy-ai/audit-log/*.jsonl`, { maxFiles: 8, maxDepth: 1, includeFilter: (n) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(n) }) },
    { id: "claude-sessions", agent: "claude", name: "Claude Code 会话记录", kind: "convo", exp: (h) => glob(`${h}/.claude/projects/*/*.jsonl`, { maxFiles: 6, maxDepth: 2, includeFilter: (n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n) }) },
    { id: "codex-archived", agent: "codex", name: "Codex 归档会话", kind: "convo", exp: (h) => glob(`${h}/.codex/archived_sessions/*.jsonl`, { maxFiles: 4, maxDepth: 1 }) },
];
/**
 * L1 源（内容本身已是「提炼好的结论」）→ 免 LLM 直读入库。
 * 判据：文件本身就是人/Agent 写下的结论，而非过程记录。对这类内容再跑一次 LLM 提炼
 * 属于「二次蒸馏」——只会丢信息、不会增价值，还白白消耗提炼预算。
 */
const L1_SOURCE_IDS = new Set([
    // 规则 / 约束类
    "codex-rules", "codex-agents", "wb-memory", "wb-user", "wb-soul", "wb-identity",
    // 已沉淀记忆类
    "codex-mem-raw", "codex-mem-diff", "codex-mem-rollout", "zcode-mem", "wbai-memory",
    // 已加工摘要类（learned[] / topics / project_memory / 用户画像）
    "trae-user-profile", "trae-project-mem", "trae-topics", "trae-session-jsonl",
]);
export function customSourcesPath() {
    if (process.env.MEMORY_SOURCES)
        return process.env.MEMORY_SOURCES;
    // APPDATA 优先；缺失时按平台回退到家目录（CLI / 非 Electron 启动场景，APPDATA 可能未注入）
    const appdata = process.env.APPDATA ||
        (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : path.join(os.homedir(), ".config"));
    return appdata ? path.join(appdata, "MemoryOS", "sources.json") : "";
}
/** 读用户自定义源；文件不存在 / 解析失败 → 返回空数组（绝不影响内置源） */
export function loadCustomSpecs() {
    const p = customSourcesPath();
    if (!p)
        return [];
    try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const arr = Array.isArray(j) ? j : j?.sources;
        if (!Array.isArray(arr))
            return [];
        return arr.filter((s) => s && typeof s.id === "string" && typeof s.path === "string");
    }
    catch {
        return [];
    }
}
/** 校验单个自定义源：路径合法性 + 展开后的文件数/总大小/样例（不写盘，供前端预检）
 *  只接受绝对路径（`C:\…` / `/…`）或 `~` 开头的家目录路径，拒绝相对路径（避免 cwd 歧义）。 */
export function validateCustomSource(spec) {
    const raw = String(spec.path ?? "").trim();
    if (!raw)
        return { ok: false, error: "路径不能为空", files: 0, totalBytes: 0, samples: [] };
    if (!/^~[/\\]/.test(raw) && !/^[a-zA-Z]:[/\\]/.test(raw) && !raw.startsWith("/")) {
        return { ok: false, error: "请填绝对路径（如 C:\\Users\\you\\notes）或以 ~ 开头的家目录路径", files: 0, totalBytes: 0, samples: [] };
    }
    const maxFiles = Math.min(Math.max(Number(spec.maxFiles ?? 50) || 50, 1), 200);
    const maxDepth = Math.min(Math.max(Number(spec.maxDepth ?? 3) || 3, 0), 6);
    let re;
    if (spec.includeFilter) {
        try {
            re = new RegExp(spec.includeFilter, "i");
        }
        catch {
            return { ok: false, error: "includeFilter 不是合法正则", files: 0, totalBytes: 0, samples: [] };
        }
    }
    // 统一为正斜杠：glob 内部用 lastIndexOf("/") 取 pattern 尾部，反斜杠会导致尾部判定失效
    const expanded = raw.replace(/^~(?=[/\\])/, home).replace(/\\/g, "/");
    const filter = re ? (n) => re.test(n) : undefined;
    let files = [];
    try {
        if (expanded.includes("*")) {
            files = glob(expanded, { maxFiles, maxDepth, includeFilter: filter });
        }
        else if (fs.existsSync(expanded)) {
            const st = fs.statSync(expanded);
            if (st.isDirectory())
                files = glob(`${expanded.replace(/\/+$/, "")}/**`, { maxFiles, maxDepth, includeFilter: filter });
            else if (st.isFile())
                files = [expanded];
        }
    }
    catch (e) {
        return { ok: false, error: `路径展开失败：${e instanceof Error ? e.message : String(e)}`, files: 0, totalBytes: 0, samples: [] };
    }
    if (!files.length) {
        return {
            ok: false,
            error: "该路径下未找到可采集的文本文件（仅收 .md/.txt/.rules/.jsonl；请检查路径是否存在、或 includeFilter 是否把文件全过滤掉了）",
            files: 0,
            totalBytes: 0,
            samples: [],
        };
    }
    let totalBytes = 0;
    for (const f of files) {
        try {
            totalBytes += fs.statSync(f).size;
        }
        catch {
            /* 单个文件不可读 → 跳过统计 */
        }
    }
    return { ok: true, files: files.length, totalBytes, samples: files.slice(0, 3), truncated: files.length >= maxFiles };
}
/** 写用户自定义源（整表覆盖，写入 `sources.json`）；写前备份原文件。
 *  安全约束：只写 customSourcesPath() 指向的文件，绝不动内置 SOURCE_SPECS。 */
export function saveCustomSpecs(specs) {
    const p = customSourcesPath();
    if (!p)
        return { ok: false, error: "无法定位 sources.json（APPDATA 不可用且未设 MEMORY_SOURCES）", path: "" };
    let backupPath;
    try {
        if (fs.existsSync(p)) {
            backupPath = `${p}.bak-${Date.now()}`;
            fs.copyFileSync(p, backupPath);
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ sources: specs }, null, 2), "utf8");
        return { ok: true, path: p, backupPath };
    }
    catch (e) {
        console.error(`[sources] sources.json 保存失败（${p}）: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, error: e instanceof Error ? e.message : String(e), path: p, backupPath };
    }
}
/** 枚举真实存在、非空、可读的源文件（同一物理文件仅归属首个匹配的 spec，避免重复采集） */
export function getSources() {
    const out = [];
    const seen = new Set();
    for (const spec of SOURCE_SPECS) {
        for (const f of spec.exp(home)) {
            try {
                if (!f)
                    continue;
                const st = fs.statSync(f);
                if (!st.isFile() || st.size <= 0)
                    continue;
                // 按规范化路径去重：同一文件只归首个 spec 所有
                const norm = f.replace(/\\/g, "/");
                if (seen.has(norm))
                    continue;
                seen.add(norm);
                out.push({ id: spec.id, agent: spec.agent, name: spec.name, kind: spec.kind, path: f, size: st.size, transform: spec.transform, level: L1_SOURCE_IDS.has(spec.id) ? "L1" : "L2" });
            }
            catch {
                /* 不可读/不存在，跳过 */
            }
        }
    }
    // ── 用户自定义源（sources.json）：追加语义，与内置源按规范化路径去重 ──
    for (const c of loadCustomSpecs()) {
        // 停用状态（enabled=false）→ 不参与采集，但保留在配置里供前端展示与重新启用
        if (c.enabled === false)
            continue;
        // 统一正斜杠：glob 内部用 lastIndexOf("/") 判定 pattern 尾部，反斜杠会失效
        const expanded = c.path.replace(/^~(?=[/\\])/, home).replace(/\\/g, "/");
        const maxFiles = Math.min(Math.max(Number(c.maxFiles ?? 50) || 50, 1), 200);
        const maxDepth = Math.min(Math.max(Number(c.maxDepth ?? 3) || 3, 0), 6);
        let filter;
        if (c.includeFilter) {
            try {
                const re = new RegExp(c.includeFilter, "i");
                filter = (n) => re.test(n);
            }
            catch {
                continue; // 正则非法 → 跳过该源，不影响其他源
            }
        }
        let files = [];
        try {
            if (expanded.includes("*")) {
                files = glob(expanded, { maxFiles, maxDepth, includeFilter: filter });
            }
            else if (fs.existsSync(expanded)) {
                const st = fs.statSync(expanded);
                // 目录：递归展开（此前只认 glob 与单文件，导致用户填目录时静默无源）
                if (st.isDirectory())
                    files = glob(`${expanded.replace(/\/+$/, "")}/**`, { maxFiles, maxDepth, includeFilter: filter });
                else if (st.isFile())
                    files = [expanded];
            }
        }
        catch {
            continue;
        }
        for (const f of files) {
            try {
                const st = fs.statSync(f);
                if (!st.isFile() || st.size <= 0)
                    continue;
                const norm = f.replace(/\\/g, "/");
                if (seen.has(norm))
                    continue;
                seen.add(norm);
                out.push({
                    id: c.id,
                    agent: c.agent,
                    name: c.name,
                    kind: c.kind ?? "memory",
                    path: f,
                    size: st.size,
                    transform: c.transform,
                    level: c.level ?? (L1_SOURCE_IDS.has(c.id) ? "L1" : "L2"),
                });
            }
            catch { /* ignore */ }
        }
    }
    return out;
}
/** 安全 glob：递归但带深度/文件数上限，跳过 .git 等内部目录，仅收文本扩展名。
 *  includeFilter(filename) 可进一步过滤文件名（如只收 project_memory.md）。
 *  未显式传 includeFilter 时，用 pattern 尾部 glob 段（最后一个 / 之后）生成默认过滤器：
 *  如 `*.md` → 只收 .md 结尾；`*_memory.md` → 收该模式；`project_memory.md` → 精确名。
 *  避免"写了 *.md 却收进 json/txt"的宽 glob 噪声。 */
function glob(pattern, opts = {}) {
    const { maxFiles = 300, maxDepth = 3, includeFilter } = opts;
    const results = [];
    let count = 0;
    let defaultFilter;
    if (pattern.includes("*")) {
        const tail = pattern.slice(pattern.lastIndexOf("/") + 1);
        if (tail !== "**") {
            if (tail.includes("*")) {
                const re = new RegExp("^" + tail.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
                defaultFilter = (n) => re.test(n);
            }
            else {
                defaultFilter = (n) => n === tail;
            }
        }
    }
    const walk = (dir, depth) => {
        // ★ 2026-09-22（A 分区跨区最小修复）：此处原为 `depth > maxDepth || results.length >= maxFiles`，
        //   在 for 循环内也有一次同样的提前 return。maxFiles 是**整棵目录树的全局上限**，
        //   一达上限即中止后续**所有**目录遍历，且收集顺序取 readdirSync 遍历序（非日期序）
        //   → 先遍历到的项目/日期吃光预算，其余目录永不访问。实测后果：trae session_memory
        //   磁盘 71 个文件只解析出最早的 20 个，该通道自 09-13 起停摆。现改为遍历不截断，
        //   收集后在函数尾部按 mtime 倒序取最近 maxFiles 个（见下方 statted 段）。
        if (depth > maxDepth)
            return;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (e.name === ".git")
                    continue;
                walk(path.join(dir, e.name), depth + 1);
            }
            else if (/\.(md|txt|rules|jsonl)$/i.test(e.name)) {
                const hit = includeFilter ?? defaultFilter;
                if (hit && !hit(e.name))
                    continue;
                results.push(path.join(dir, e.name));
                count++;
            }
        }
    };
    if (pattern.includes("*")) {
        const star = pattern.indexOf("*");
        const base = pattern.slice(0, star).replace(/[\/\\]+$/, "");
        // 归一化分隔符：Windows 混合路径（如 C:\Users\WYX/.trae-cn/...）会导致 lastIndexOf 截断错误
        const normBase = base.replace(/\\/g, "/");
        // 如果 base 本身就是一个已存在的目录，直接用它作为起点，否则取父目录
        const dir = fs.existsSync(normBase) && fs.statSync(normBase).isDirectory()
            ? normBase
            : (normBase.includes("/") ? normBase.slice(0, normBase.lastIndexOf("/")) : ".");
        walk(dir, 0);
    }
    else if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
        results.push(pattern);
    }
    // ★ 2026-09-22（A 分区跨区最小修复）：收集完成后按 mtime 倒序取最近 maxFiles 个。
    //   语义变化：maxFiles 由「遍历序前 N 个」改为「最近修改的 N 个」——后者才符合
    //   「同步最新会话/笔记」的意图，且不会因新目录加入而永久停摆。
    //   同时把原先的 isFile() 过滤合并进来（只 stat 一次，避免二次 I/O）。
    const statted = [];
    for (const f of results) {
        try {
            const st = fs.statSync(f);
            if (st.isFile())
                statted.push({ f, mtimeMs: st.mtimeMs });
        }
        catch { /* 取不到 stat 的跳过 */ }
    }
    statted.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return statted.slice(0, maxFiles).map((x) => x.f);
}
/** 读文件全文（失败返回 ''） */
export function readText(f, maxBytes = 1_000_000) {
    try {
        const buf = fs.readFileSync(f);
        if (buf.length > maxBytes)
            return buf.subarray(0, maxBytes).toString("utf8") + "\n[已截断]";
        return buf.toString("utf8");
    }
    catch {
        return "";
    }
}
/**
 * 审计日志文本化（transform=audit-jsonl）。
 * 实测 WorkBuddy/WBAI 的 audit-log 中 96%+ 是 `command-safety.sandbox-executed / decision=allowed`
 * 的普通命令放行记录（`ls`/`cd` 之类），整份送 LLM 纯属浪费预算。
 * 只保留「风险/决策类」事件：被拒/被拦/失败/需审批/已审批/策略变更/命令被排除。
 * 无风险事件时返回空串（调用方会跳过该源）。
 */
function auditJsonlToText(raw, label) {
    const keep = [];
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            continue;
        }
        const ev = String(o.eventType ?? "");
        const dec = String(o.decision ?? "");
        const interesting = /rejected|blocked|failed|denied/.test(dec) ||
            /needs-approval|rejected|blocked|failed|denied|updated|excluded|auto-approved|system-tool-confirm/.test(ev);
        if (!interesting)
            continue;
        let ts = "";
        const raw_ts = o.timestamp;
        if (raw_ts != null) {
            const n = Number(raw_ts);
            const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(String(raw_ts));
            if (!Number.isNaN(d.getTime()))
                ts = d.toISOString().slice(0, 19).replace("T", " ");
        }
        const cmd = String(o.commandPreview ?? "").replace(/\s+/g, " ").slice(0, 200);
        const params = o.messageParams ? JSON.stringify(o.messageParams).slice(0, 160) : "";
        const key = o.messageKey ? String(o.messageKey).split(".").pop() : "";
        keep.push(`[${ts}] ${ev} (${dec})${key ? " " + key : ""}${cmd ? " | " + cmd : ""}${params ? " | " + params : ""}`.trim());
    }
    if (!keep.length)
        return "";
    return `# ${label} —— 风险/决策事件 ${keep.length} 条（已过滤普通放行记录）\n` + keep.join("\n");
}
/** 从 Trae session_memory jsonl 抽取 learned[] 结论（免 LLM；与 shared-sync 同源同义） */
function traeLearnedToText(raw) {
    const uniq = new Set();
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            continue;
        }
        const arr = o?.learned;
        if (!Array.isArray(arr))
            continue;
        for (const l of arr) {
            const t = typeof l === "string" ? l.trim() : "";
            if (t.length >= 20)
                uniq.add(t);
        }
    }
    return [...uniq].join("\n\n");
}
/**
 * L1 条目切分：以 markdown 列表项 / 小节标题为界聚合成「一条一记忆」。
 * 不用 1500 字硬切 —— L1 内容本身是结论，硬切会把一条完整结论劈成两半。
 */
function splitL1Items(text, max = 1200) {
    const clean = text.replace(/<!--[\s\S]*?-->/g, ""); // 去 HTML 注释（规则段标记）
    const out = [];
    let cur = "";
    const flush = () => { const t = cur.trim(); if (t.length >= 20)
        out.push(t); cur = ""; };
    for (const ln of clean.split(/\r?\n/)) {
        const isBoundary = /^\s*(?:[-*+]\s|\d+[.、)]\s|#{1,6}\s)/.test(ln);
        if (isBoundary && cur.trim())
            flush();
        if (cur && (cur + "\n" + ln).length > max)
            flush();
        cur = cur ? cur + "\n" + ln : ln;
    }
    flush();
    return out;
}
/**
 * L1 轻量门禁：只挡真正不可用的内容。
 * 注意：这里**刻意不用 garbledRatio** —— 它的白名单不含 `\ | > * + = % ~ @ # $ ^ <` 等符号，
 * 而 L1 源多为规则/路径密集的 markdown（表格、加粗、Windows 路径 `C:\...`），
 * 用它会误杀大量正常内容（首次实跑 513 块被拒 320 条，62%）。改用控制字符判定「真乱码」。
 */
function l1Gate(content) {
    const t = content.trim();
    if (t.length < 20)
        return false;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufff0-\uffff]/.test(t))
        return false; // 控制字符 / 特殊区
    if (/^#{1,6}\s*$/.test(t))
        return false; // 纯标题行
    return true;
}
/** 按源的 transform 规则取文本；返回空串表示该源本轮无有效内容 */
export function readSourceText(src) {
    const raw = readText(src.path);
    if (!raw)
        return "";
    if (src.transform === "audit-jsonl")
        return auditJsonlToText(raw, src.name);
    if (src.transform === "trae-learned")
        return traeLearnedToText(raw);
    return raw;
}
/** 记录采集水位（源处理完成后调用）。
 *  ⚠️ L1 分支与 L2 分支都要调 —— L1 用 `continue` 提前跳出，会跳过循环末尾的统一写法，
 *  否则 L1 永远不写水位、每轮全量重读（实测：41 个 L1 文件全部缺水位的根因）。 */
function markIngestState(db, src) {
    try {
        const st = fs.statSync(src.path);
        setIngestState(db, src.path, st.size, Math.floor(st.mtimeMs));
    }
    catch { /* 文件消失则忽略 */ }
}
/** 按段落分块，每块约 ~1500 字符；单段落超长按 size 硬切，避免块膨胀 */
/** 成本治理·渐进压缩（P1 CostGuard「渐进式压缩-降级-终止」第一级）：
 * 预算吃紧时把输入块压缩到 ≤45% 再送 LLM（省 token），保留句首与结论性句子。 */
function compressBlock(block, ratio = 0.45) {
    const lines = String(block).split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 4)
        return lines.join("\n");
    // 启发式：保留含结论/数值/路径/命令的句子（信息密度高），丢过程性叙述
    const keep = lines.filter((l) => /(。|结论|原因|解法|路径|命令|http|\.js|\.md|exit=|错误|踩坑|决策)/.test(l));
    const pool = keep.length ? keep : lines;
    const cap = Math.max(2, Math.round(pool.length * ratio));
    // 头部 + 尾部双端保留（中段截断），与 agent-core 截断口径一致
    const head = pool.slice(0, Math.ceil(cap / 2));
    const tail = pool.slice(-Math.ceil(cap / 2));
    const seen = new Set(head);
    for (const t of tail)
        if (!seen.has(t))
            head.push(t);
    return head.join("\n").slice(0, 700);
}
function chunk(text, size = 1500) {
    const blocks = [];
    let cur = "";
    for (const para of text.split(/\n{2,}|\r?\n/)) {
        let p = para.trim();
        if (!p)
            continue;
        // 单段超长：按 size 硬切
        while (p.length > size) {
            if (cur) {
                blocks.push(cur.trim());
                cur = "";
            }
            blocks.push(p.slice(0, size));
            p = p.slice(size);
        }
        if ((cur + "\n" + p).length > size && cur) {
            blocks.push(cur.trim());
            cur = p;
        }
        else {
            cur = cur ? cur + "\n" + p : p;
        }
    }
    if (cur.trim())
        blocks.push(cur.trim());
    return blocks;
}
/** 非中英文/常用标点/空白字符占比——专治 "CONFI ICT" / "fail-e nfiumf" 类乱码 */
function garbledRatio(text) {
    const chars = [...text];
    if (!chars.length)
        return 1;
    const bad = chars.filter((ch) => !/[\u4e00-\u9fff\u3400-\u4dbf\w\s，。；：、（）【】《》""''！？…—·,.?!;:()\-{}\[\]]/u.test(ch)).length;
    return bad / chars.length;
}
function hardGate(content) {
    if (content.length < 20)
        return { verdict: "reject", reason: "过短<20字信息量不足" };
    if (content.length > 800)
        return { verdict: "review", reason: "过长>800字" };
    if (garbledRatio(content) >= 0.02)
        return { verdict: "reject", reason: `乱码占比${(garbledRatio(content) * 100).toFixed(1)}%` };
    if (/MemoryOS|记忆系统|memoryhub/i.test(content))
        return { verdict: "meta", reason: "Meta自指路由meta scope" };
    const t = content.toLowerCase();
    if (/^(闲聊|聊天|你好|谢谢|再见|开心|难过)/.test(t))
        return { verdict: "reject", reason: "闲聊前缀" };
    if (/心情|日常|人设|性格|爱好|兴趣|喜欢.+?不喜欢/.test(t))
        return { verdict: "reject", reason: "闲聊词" };
    if (/^[①②③④⑤⑥⑦⑧⑨⑩一二三四五六七八九十]/.test(content))
        return { verdict: "reject", reason: "序号流水账" };
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufff0-\uffff]/.test(content))
        return { verdict: "reject", reason: "控制字符" };
    if (/(正在|即将|下一步|待办|今天|明天|收尾|进行中)/.test(t))
        return { verdict: "review", reason: "过程性词转审查" };
    if (/(可能|也许|大概|应该是|猜测)/.test(t))
        return { verdict: "review", reason: "猜测性转审查" };
    return { verdict: "pass", reason: "ok" };
}
/** 执行一轮采集：读全部源 → 分块 → 嵌入 → 库内去重 → LLM 提炼 → 入库。
 *  dryLimit>0 时只处理前 dryLimit 个源（调试用）；出错单源跳过不中断。 */
export async function ingestAll(db, dryLimit = 0, opts = {}) {
    const stats = { sources: 0, files: 0, chunks: 0, skippedDup: 0, skippedUnchanged: 0, l1Inserted: 0, l1Files: 0, llmFail: 0, inserted: 0, qualityReject: 0, gateReview: 0, gateMeta: 0, items: [], errors: [] };
    const sources = getSources();
    stats.sources = sources.length;
    const all = dryLimit > 0 ? sources.slice(0, dryLimit) : sources;
    // l1Only：只跑免 LLM 的 L1 源（快速通道，用于验证 / 定时轻量跑）
    const picked = opts.l1Only ? all.filter((s) => (s.level ?? "L2") === "L1") : all;
    // 增量模式：已有水位的源，若 (size, mtime) 未变则跳过 —— 定时采集的空跑成本降到 stat 级
    const states = opts.incremental ? getIngestStates(db) : null;
    let embedder;
    try {
        embedder = (await getEmbedder());
    }
    catch (e) {
        stats.errors.push(`嵌入器不可用：${String(e)}`);
        return stats;
    }
    // 库内现有向量缓存（global scope，去重比较用）
    const existing = getVectorsOnProject(db, "global");
    let calls = 0; // 本轮 LLM 提炼次数，达 MAX_CALLS 停止后续源
    let budgetExhausted = false;
    // ★ P1 成本治理·三级渐进（CostGuard）：按已耗预算比例切档，不是一刀切 break
    //   L1 正常（<50% 预算）；L2 压缩（50–80%，输入块压缩到 45% 省 token，统计记 budgetCompress）；
    //   L3 降级+终止（≥80% 或 LLM 连续失败，剩余源跳过不再调 LLM，统计记 budgetDowngrade/budgetExhausted）。
    const budgetLevel = () => {
        const frac = calls / MAX_CALLS;
        if (frac >= 0.8 || (srcLlmFailStreak >= 3))
            return "downgrade";
        if (frac >= 0.5)
            return "compress";
        return "normal";
    };
    let srcLlmFailStreak = 0; // LLM 连续失败计数（触发降级的信号之一）
    let budgetCompress = 0;   // 预算治理统计
    let budgetDowngrade = 0;
    let budgetTerminated = 0;
    stats.budgetLevel = "normal"; // 最终档位（dashboard 展示）
    for (const src of picked) {
        // ★ P1 成本治理·三级渐进（CostGuard）：按已耗预算切档，不一刀切
        const level = budgetLevel();
        stats.budgetLevel = level; // 持续更新最终档位
        if (level === "downgrade") {
            // L3 降级+终止：剩余源跳过不再调 LLM（只放行 L1 免 LLM 源）
            budgetDowngrade++;
            if ((src.level ?? "L2") === "L2")
                budgetTerminated++;
        }
        if (budgetExhausted)
            break;
        if (calls >= MAX_CALLS) {
            budgetExhausted = true;
            break;
        }
        // 增量：size+mtime 未变 → 跳过（本轮零读取成本）
        if (states) {
            try {
                const st = fs.statSync(src.path);
                const prev = states.get(src.path);
                if (prev && prev.size === st.size && prev.mtime_ms === Math.floor(st.mtimeMs)) {
                    stats.skippedUnchanged++;
                    continue;
                }
            }
            catch {
                continue; // 文件已消失/不可读
            }
        }
        let srcLlmFail = 0; // 本源 LLM 失败次数；>0 则不写水位，下轮重试
        const text = readSourceText(src);
        if (!text) {
            // 本源无有效内容（如审计日志过滤后没有风险事件）→ 同样要记水位，
            // 否则这类源每轮都被重读一遍（大文件如 12MB 的会话 transcript 尤其浪费）。
            if (states)
                markIngestState(db, src);
            continue;
        }
        stats.files++;
        // ── L1：内容本身已是结论 → 免 LLM 直读入库（省掉二次蒸馏与提炼预算）──
        if ((src.level ?? "L2") === "L1") {
            stats.l1Files++;
            const l1items = splitL1Items(text);
            if (!l1items.length)
                continue;
            let l1vecs;
            try {
                l1vecs = await embedder.embedTexts(l1items);
            }
            catch (e) {
                stats.errors.push(`${src.name} 嵌入失败：${String(e)}`);
                srcLlmFail++;
                continue;
            }
            const l1type = src.kind === "rule" ? "rule" : "experience";
            for (let i = 0; i < l1items.length; i++) {
                stats.chunks++;
                const it = l1items[i];
                const vec = l1vecs[i];
                if (existing.length && vec && existing.some((ex) => cosine(ex.vec, vec) > 0.92)) {
                    stats.skippedDup++;
                    continue;
                }
                if (!l1Gate(it)) {
                    stats.qualityReject++;
                    continue;
                }
                try {
                    const row = writeMemory(db, {
                        content: it,
                        type: l1type,
                        agent: src.agent,
                        agent_fpath: src.path,
                        project: "global",
                        embedding: vec ?? undefined,
                        confidence: 0.7,
                        status: "trial",
                        // ★ 2026-10-14（③）：采集来源标记 —— 外部文件内容不得进规则反思候选（见 rule-reflection.js）
                        source: "ingest",
                    });
                    if (vec)
                        existing.push({ id: row.id, vec });
                    logUsage(db, { memory_id: row.id, event: "write", reader_agent: src.agent, writer_agent: src.agent, project: row.project });
                    stats.inserted++;
                    stats.l1Inserted++;
                    stats.items.push({ id: row.id, type: row.type, content: row.content.slice(0, 80), agent: row.agent });
                }
                catch (e) {
                    stats.errors.push(`${src.name} 写入失败：${String(e)}`);
                }
            }
            // ⚠️ 必须在此写水位：continue 会跳过循环末尾的统一写法，否则 L1 每轮全量重跑
            if (states && srcLlmFail === 0)
                markIngestState(db, src);
            continue; // 关键：L1 不消耗 LLM 预算
        }
        const blocks = chunk(text).slice(0, BLOCKS_PER_SOURCE);
        if (!blocks.length)
            continue;
        let vecs;
        try {
            vecs = await embedder.embedTexts(blocks);
        }
        catch (e) {
            stats.errors.push(`${src.name} 嵌入失败：${String(e)}`);
            continue;
        }
        for (let i = 0; i < blocks.length; i++) {
            stats.chunks++;
            let block = blocks[i];
            const vec = vecs[i];
            // 库内去重：与已有向量 cos>0.92 视为重复跳过
            if (existing.length && vec) {
                const hit = existing.some((ex) => cosine(ex.vec, vec) > 0.92);
                if (hit) {
                    stats.skippedDup++;
                    continue;
                }
            }
            // LLM 提炼（受全局预算约束）
            if (calls >= MAX_CALLS)
                break;
            // ★ P1 成本治理 L2 压缩档：预算 50–80% 时压缩输入块（省 token），统计 budgetCompress
            const lvl = budgetLevel();
            if (lvl === "compress") {
                block = compressBlock(block);
                budgetCompress++;
            }
            calls++;
            let items;
            try {
                items = await extractFromSource(block, src.kind, `${src.agent}:${src.path}`);
                srcLlmFailStreak = 0; // 一次成功即清零连续失败
            }
            catch (e) {
                stats.llmFail++;
                srcLlmFail++;
                srcLlmFailStreak++;
                stats.errors.push(`${src.name} 提炼失败：${String(e)}`);
                continue;
            }
            if (!items.length)
                continue;
            for (const it of items) {
                // P2 硬门禁：pass 直入；review 降置信走 trial；meta 路由 meta scope；reject 拒收（管道一律 status='trial' 由 daemon 考核）
                const gate = hardGate(it.content);
                if (gate.verdict === "reject") {
                    stats.qualityReject++;
                    // reject 也要落日志，否则"门控拦截量"无法从 daemon_log 观测（review/meta 走下方 write 已可见）
                    logDaemon(db, { task: "ingest", op: "reject", operator: `ingest:${src.agent}`, detail: `门控拒收 ${src.name}: ${gate.reason}` });
                    continue;
                }
                if (gate.verdict === "review")
                    stats.gateReview++;
                if (gate.verdict === "meta")
                    stats.gateMeta++;
                const project = gate.verdict === "meta" ? "meta" : "global";
                const confidence = gate.verdict === "review" ? 0.5 : 0.7; // review 低置信，trial 淘汰兜底
                let row;
                try {
                    // ★ M10（R4 裁决）：LLM 提炼的情绪信号落库 —— |valence|≥0.5 归入 affective 扇区（自动提炼写入路径）
                    const affective = it.valence !== undefined && Math.abs(it.valence) >= 0.5;
                    row = writeMemory(db, {
                        content: it.content,
                        type: it.type,
                        agent: src.agent,
                        agent_fpath: src.path,
                        project,
                        embedding: vec ?? undefined,
                        confidence,
                        status: "trial",
                        // ★ 2026-10-14（③）：采集来源标记（同上）
                        source: "ingest",
                        sector: affective ? "affective" : undefined,
                        valence: it.valence,
                        arousal: it.arousal,
                    });
                    // 同步补进去重缓存：同一轮内后续源再命中相同内容也能去重，避免重复入库
                    if (vec)
                        existing.push({ id: row.id, vec });
                    // 写入必须落 usage（漏斗 write 基线）；仅 logDaemon 会被"只写不搜"触发率高估
                    logUsage(db, { memory_id: row.id, event: "write", reader_agent: src.agent, writer_agent: src.agent, project: row.project });
                    logDaemon(db, {
                        task: "ingest",
                        op: "write",
                        memory_id: row.id,
                        operator: `ingest:${src.agent}`,
                        detail: `采集自 ${src.name} (gate=${gate.verdict}${gate.verdict === "pass" ? "" : `:${gate.reason}`})`,
                    });
                }
                catch (e) {
                    stats.errors.push(`${src.name} 写入失败：${String(e)}`);
                    continue;
                }
                stats.inserted++;
                stats.items.push({ id: row.id, type: row.type, content: row.content.slice(0, 80), agent: row.agent });
            }
        }
        // 全部块处理完且无 LLM 失败 → 记录水位（下一轮跳过该文件）
        if (states && srcLlmFail === 0)
            markIngestState(db, src);
    }
    // ★ P1 成本治理：最终档位 + 三级统计（normal/compress 次数、downgrade 终止数），供 dashboard 展示
    stats.budgetLevel = budgetLevel();
    stats.budgetCompress = budgetCompress;
    stats.budgetDowngrade = budgetDowngrade;
    stats.budgetTerminated = budgetTerminated;
    return stats;
}
