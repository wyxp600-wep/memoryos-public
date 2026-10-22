import { MEMORY_BODY_GUIDE, MEMORY_BODY_TEMPLATE } from './memory-body.js';
import {installFeedback,recordFeedback} from './feedback-events.js';
/**
 * MemoryOS — 规则强制注入（sync-rules）：
 * 把记忆库中 status=active 且 confidence≥MIN_CONF 的 rule，同步写进各智能体
 * 启动必读的约束文件，让新会话「必然看到」并遵守（不只是按需检索）。
 *
 * 当前目标：WorkBuddy（~/.workbuddy/MEMORY.md）。
 * 幂等段维护：用 HTML 注释标记段头/段尾，重复同步只替换段内内容，不覆盖用户正文。
 * 首次注入前自动备份目标文件（~/_backup_memoryos-rules-<ts>/）。
 *
 * 用法：dashboard 调 syncRules(db,{target})；CLI：node dist/sync-rules.js [workbuddy]
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, queryByType } from "./db.js";
/** 只同步高置信规则（默认 ≥0.6），低置信/待仲裁的不强塞给智能体。
 *  v0.4 token 减负（P2）：全局/项目注入段从「全量高置信规则平铺」收敛为「内置门禁层」。
 *  门禁 = 跨项目通用行为守则，稳定且少量；其余规则留库靠 memory_search 按需检索（JIT）。
 *  设 SYNC_ALL_RULES=1 可回退旧全量行为（保底/对照）。
 */
const MIN_CONF = Math.max(0, Math.min(1, Number(process.env.RULE_MIN_CONF ?? 0.6) || 0.6));
/** 内置门禁层：仅这 8 条常驻注入段（token 收益最大的低语义重复行为守则） */
const GATE_RULES = [
    { content: MEMORY_BODY_GUIDE+"\n\n标准模板（字段名与内容分行）：\n\n"+MEMORY_BODY_TEMPLATE, agent: "gate" },
    { content: "每条消息先读记忆（硬性·不可跳过·第一步）：收到用户任何消息后，第一件事必须是调用 memory_context（可带 focus=当前任务主题）注入当前项目高价值记忆，之后才能回复或调用其他工具；接着按需 memory_search 精确检索（关键词覆盖主题/模块/报错现象）；命中相关记忆须 memory_cite 标注来源，确无相关也须声明'已检索无相关'。若本机未安装或未连接 MemoryOS MCP，须先明确提示用户安装接入，不得跳过此步。禁止跳过直接回复或开干，修改核心模块或遇报错时尤其如此。", agent: "gate" },
    { content: "完成后沉淀：解决重要问题（>30min 修复/技术决策/踩坑/隐藏约定/阶段性结论）后，须 memory_write 沉淀一条核心结论+依据，与 memory_search/memory_cite 构成先查-命中-沉淀-回查闭环；未沉淀不得声明任务完成，且须在回复里报出本次沉淀的记忆编号（便于用户回查）。", agent: "gate" },
    { content: "实证后声明：完成声明必须附 build/curl/netstat 等实证日志，禁用 should/probably/basically 等模糊表述，坚持 docs before code、evidence before conclusions。", agent: "gate" },
    { content: "副本修改：严禁直接修改源文件，必须复制文件后在副本上修改，保留原始版本；修改文件前明确告知改动范围，避免污染原路径（修改产物统一放桌面/独立目录）。", agent: "gate" },
    { content: "最全+最优改动（范围由需求定、深度做满）：需求范围内一处不留——不留半成品、不留「待用户点一下」、不留已知未修；同类问题在别处出现则列清单报告，不越界、不动他人分区。方案在多条可行路径里挑收益最高者，不为省事挑最省事的；现有实现已非最优时允许替换，但换前先给权衡。可回滚仍是硬边界。", agent: "gate" },
    { content: "先方案后动手：提供方案须先陈述权衡分析（trade-off）再给明确建议，不可跳过对比直接给结论；改动前先读项目结构了解整体架构，遵循四步流程（root cause→solution→confirmation→implementation）。", agent: "gate" },
    { content: "敏感保护：严格保护敏感信息（.env、API Key、Token、凭据），绝不泄露或硬编码。", agent: "gate" },
    { content: "中文回复：所有面向用户的输出必须使用中文。", agent: "gate" },
];
/** 默认注入门禁；SYNC_ALL_RULES=1 回退全量高置信规则 */
const USE_GATE = process.env.SYNC_ALL_RULES !== "1";
/** ★ 2026-10-03 缺陷修（口径对齐 server.js:20-22 的「缺省只用生产库」拍板）：原缺省落**仓内 dev 库**，
 *  而 dev 库是空库 → CLI 同步只注入 8 条内置门禁、**静默丢掉**规则页 inject=1 的规则（实测：dev=8 / 生产=20，
 *  且 exit=0 无任何告警）。非 Windows（无 APPDATA）才回落仓内路径。 */
const DB_PATH = process.env.MEMORY_DB ?? (process.env.APPDATA
    ? path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db")
    : fileURLToPath(new URL("../data/memory.db", import.meta.url)));
/** 段标记：MD 渲染时 HTML 注释不可见，便于程序 grep 与幂等替换 */
export const SEG_START = "<!-- MEMORYOS-SYNC-RULES-START -->";
export const SEG_END = "<!-- MEMORYOS-SYNC-RULES-END -->";
/**
 * 注入目标清单（2026-09-06 本机实证）：
 *   workbuddy      → ~/.workbuddy/MEMORY.md          （存在）
 *   workbuddy-ai   → ~/.workbuddy-ai/MEMORY.md        （存在）
 *   codex          → ~/.codex/AGENTS.md               （存在）
 *   claude         → ~/.claude/CLAUDE.md              （新建）
 *   trae-cn        → ~/.trae-cn/user_rules/rule-memoryos.md（Trae 规则入口目录，新建固定名文件）
 *   opencode       → ~/.config/opencode/AGENTS.md     （★20261006 新增：OpenCode 官方全局规则文件，对所有会话生效）
 *   qoder          → ~/.qoder/AGENTS.md               （★20261006 新增：AGENTS.md 通用约定，待实测确认 Qoder 是否读取该全局文件）
 * 无明文入口、不注入：ZCode（仅会话目录）、智谱清言/MiniMax（Electron 壳，记忆在私有/云端）、Codex++（无独立配置目录）。
 * 无明文入口者仍有兜底通道：syncProjectRules 写项目根 AGENTS.md（打开该项目的 IDE 通用可见）。
 */
export function getSyncTargets() {
    const h = os.homedir();
    return [
        { id: "workbuddy", label: "WorkBuddy MEMORY.md", file: path.join(h, ".workbuddy", "MEMORY.md") },
        { id: "workbuddy-ai", label: "WorkBuddy AI MEMORY.md", file: path.join(h, ".workbuddy-ai", "MEMORY.md") },
        { id: "codex", label: "Codex AGENTS.md", file: path.join(h, ".codex", "AGENTS.md") },
        { id: "claude", label: "Claude Code CLAUDE.md", file: path.join(h, ".claude", "CLAUDE.md") },
        { id: "trae-cn", label: "Trae CN 用户规则", file: path.join(h, ".trae-cn", "user_rules", "rule-memoryos.md") },
        { id: "opencode", label: "OpenCode AGENTS.md（全局）", file: path.join(h, ".config", "opencode", "AGENTS.md") },
        { id: "qoder", label: "Qoder AGENTS.md（全局·待实测）", file: path.join(h, ".qoder", "AGENTS.md") },
    ];
}
/**
 * ★ 2026-10-06：把「扫描到的 agent」映射到「规则注入落点」，供自动接入（dist/auto-connect.js）复用。
 *  已知载体（有实证规则入口）→ 复用 getSyncTargets() 的落点（幂等段写入）；
 *  未知载体 → 仅当 hint 指向「家目录下的专属点目录」时，用 <dir>/AGENTS.md 作兜底落点
 *    （返回 verified:false，调用方须标注「待实测」）；凡落点 == 家目录本身 / 在家目录之外 /
 *    在 AppData / 系统目录下一律返回 null —— 宁可不写。
 *  @param {string} agentId 扫描出的 agent id（codex / traecode / vscode …）
 *  @param {string|null} hint 载体文件路径（configFile）或目录（configDir / autoWriteFile）
 *  @returns {{file:string,targetId:string|null,verified:boolean}|null}
 */
export function resolveAgentRuleTarget(agentId, hint = null) {
    const id = String(agentId || "").toLowerCase().trim();
    if (!id)
        return null;
    // 扫描 id → 注入目标 id 别名（同一智能体的多种叫法）
    const alias = { traecode: "trae-cn", traework: "trae-cn", trae: "trae-cn" };
    const targetId = alias[id] ?? id;
    const known = getSyncTargets().find((t) => t.id === targetId);
    if (known)
        return { file: known.file, targetId: known.id, verified: true };
    if (!hint)
        return null;
    let dir = path.resolve(String(hint));
    try {
        if (fs.statSync(dir).isFile())
            dir = path.dirname(dir);
    }
    catch {
        // 路径不存在：按目录处理，交由下面的守卫否决
    }
    const home = path.resolve(os.homedir());
    const rel = path.relative(home, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
        return null; // 家目录本身 / 家目录之外
    if (/(^|[\\/])appdata([\\/]|$)/i.test(dir))
        return null; // AppData（安装区 / 第三方配置区）不写
    if (/(^|[\\/])(windows|program files|program files \(x86\))([\\/]|$)/i.test(dir))
        return null; // 系统目录不写
    if (!path.basename(dir).startsWith("."))
        return null; // 只认「点目录」形态（~/.foo）
    // ★ 备份/临时/回收类目录不写：载体指纹会命中「用户把 ~/.codex 复制成 ~/.codex-session-delete」
    //   这类备份目录（实测该目录被扫成 connected），往里面写 AGENTS.md 属猜写、只会留垃圾。
    if (/(delete|backup|\bbak\b|old|copy|tmp|temp|archive|trash|pending)/i.test(path.basename(dir)))
        return null;
    return { file: path.join(dir, "AGENTS.md"), targetId: null, verified: false };
}
/** 目标文件是否已含 MemoryOS 注入段（幂等判据：有则跳过，不重复写） */
export function hasRuleSegment(file) {
    let txt = "";
    try {
        txt = fs.readFileSync(file, "utf8");
    }
    catch {
        return false; // 文件不存在 / 不可读 = 尚未注入
    }
    return txt.includes(SEG_START);
}
function buildSegment(rules) {
    const body = rules
        .map((r) => r.agent === 'gate' && r.content.includes(MEMORY_BODY_TEMPLATE)
            ? `- ${MEMORY_BODY_GUIDE}（来源：gate）\n\n\`\`\`text\n${MEMORY_BODY_TEMPLATE}\n\`\`\`\n`
            : `- ${r.content.replace(/\s+/g, " ").trim()}（来源：${r.agent}）`)
        .join("\n");
    return [
        "",
        SEG_START,
        "",
        "## MemoryOS 同步规则（自动维护，勿手改）",
        "",
        "以下规则由共享记忆库同步注入，对所有 AI Agent 会话生效，必须遵守：",
        "",
        body || "- （暂无高置信规则）",
        "",
        SEG_END,
        "",
    ].join("\n");
}
/** 幂等写入：文件含 SEG_START 则整段替换；否则备份后追加。返回是否新注入/是否备份 */
function writeSegment(file, seg) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let old = "";
    try {
        old = fs.readFileSync(file, "utf8");
    }
    catch {
        old = "";
    }
    const had = old.includes(SEG_START);
    let added = false;
    let backedUp = false;
    let next;
    if (had) {
        // 幂等替换：SEG_START..SEG_END 之间整段换新（含标记本身）
        const i0 = old.indexOf(SEG_START);
        const i1 = old.indexOf(SEG_END, i0);
        if (i1 < 0) {
            // 段头在但段尾丢了（被手改）：保守处理——只移除段头标记，不删 i0 之后的任何内容
            // （可能混有用户手写正文），新段追加到文件尾，避免误删用户数据
            old = old.slice(0, i0) + old.slice(i0 + SEG_START.length);
            next = old.trimEnd() + "\n" + seg + "\n";
            added = true;
        }
        else {
            next = old.slice(0, i0) + seg.trim() + old.slice(i1 + SEG_END.length);
        }
    }
    else {
        // 首次注入：先备份，再追加
        if (old.trim()) {
            const bk = path.join(os.homedir(), `_backup_memoryos-rules-${Date.now()}`);
            fs.mkdirSync(bk, { recursive: true });
            fs.writeFileSync(path.join(bk, path.basename(file)), old, "utf8");
            backedUp = true;
        }
        next = old.trimEnd() + "\n" + seg + "\n";
        added = true;
    }
    fs.writeFileSync(file, next, "utf8");
    return { added, backedUp };
}
/** 取注入用规则清单：
 *  门禁模式(默认)：只返回内置 8 条门禁（其余留库做 JIT 检索）。
 *  全量模式(SYNC_ALL_RULES=1)：旧行为，返回 active + conf≥MIN_CONF 的全部规则。
 */
/** ★ 批次⑦X2 + 批次⑧：门禁模式下注入段的「开关规则」选取 —— 按创建时间取最新 N 条。
 *  封顶动机：批次⑧ 每日反思产的规则自动 inject=1，不封顶会把注入段无限撑大，回退 v0.4 token 减负不变式。
 *  env RULE_INJECT_CAP 覆盖，默认 20（8 门禁 + ≤20 条开关规则 ≈ 段长有界）。 */
const INJECT_CAP = Math.max(1, Number(process.env.RULE_INJECT_CAP ?? 20) || 20);
function pickFlagged(db) {
    const flagged = queryByType(db, "rule", { status: "active" }).filter((r) => r.inject);
    flagged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)); // 新在前
    return flagged.slice(0, INJECT_CAP);
}
function pickRules(db) {
    if (USE_GATE) {
        // 门禁层 = 内置 8 条 + 打了「注入」开关的 active 规则（规则页手动勾选 + 批次⑧ 自动生产线，token 可控）
        return [...GATE_RULES, ...pickFlagged(db).map((r) => ({ content: r.content, agent: r.agent || "human:dashboard" }))];
    }
    const all = queryByType(db, "rule", { status: "active" });
    return all.filter((r) => (r.confidence ?? 0) >= MIN_CONF);
}
/** 当前 active 规则总数（独立 COUNT，避免 queryByType 的 limit 截断低估） */
export function currentRuleSegment(db) {
    const text=buildSegment(pickRules(db));return text.slice(text.indexOf(SEG_START),text.indexOf(SEG_END)+SEG_END.length);
}
function countActiveRules(db) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status='active' AND type='rule'`).get();
    return row.n;
}
/** 被排除在注入段之外的规则数（仅统计口径，用于日志）。
 *  门禁模式：注入段固定 8 条门禁，其余 active 规则都留在库内靠检索召回，故 = active 总数。
 */
function countSkipped(db, rules) {
    const active = countActiveRules(db);
    if (USE_GATE) {
        // ★ 批次⑦X2：门禁模式下已注入 = 内置门禁 + 开关勾选的规则，跳过数 = active − 勾选数
        const flagged = Math.max(0, rules.length - GATE_RULES.length);
        return Math.max(0, active - flagged);
    }
    return Math.max(0, active - rules.length);
}
export function syncRules(db, opts = {}) {
    installFeedback(db);
    const targets = getSyncTargets().filter((t) => !opts.target || t.id === opts.target);
    if (!targets.length) {
        recordFeedback(db,{agent:String(opts.target||'unknown'),tool:'rule_sync',status:'failed',code:'rules_failed'});
        throw new Error(`未知注入目标：${opts.target ?? ""}`);
    }
    const rules = pickRules(db);
    const skipped = countSkipped(db, rules);
    return targets.map((t) => {
        const file = t.file;
        const seg = buildSegment(rules);
        const actor=t.id==='trae-cn'?'traecode':t.id;
        let change;try{change=writeSegment(file,seg);recordFeedback(db,{agent:actor,tool:'rule_sync',status:'success',code:'rules_written'});}catch(e){recordFeedback(db,{agent:actor,tool:'rule_sync',status:'failed',code:'rules_failed'});throw e;}
        const { added, backedUp } = change;
        return { ok: true, target: t.id, rules: rules.length, skipped, file, added, backedUp, content: seg };
    });
}
/**
 * 项目级注入：把规则以幂等段写进 <dir>/AGENTS.md。
 * 任何打开该项目的 AI IDE（ZCode/Trae/Codex/Claude…）都会加载项目根 AGENTS.md，
 * 这是覆盖「无全局明文入口」桌面智能体的通用通道。
 */
export function syncProjectRules(db, dir) {
    installFeedback(db);
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        recordFeedback(db,{agent:'project-rules',tool:'rule_sync',status:'failed',code:'rules_failed'});
        throw new Error(`项目目录不存在或不可读：${dir}`);
    }
    const file = path.join(resolved, "AGENTS.md");
    const rules = pickRules(db);
    const skipped = countSkipped(db, rules);
    const seg = buildSegment(rules);
    let change;try{change=writeSegment(file,seg);recordFeedback(db,{agent:'project-rules',tool:'rule_sync',status:'success',code:'rules_written'});}catch(e){recordFeedback(db,{agent:'project-rules',tool:'rule_sync',status:'failed',code:'rules_failed'});throw e;}
    const { added, backedUp } = change;
    return { ok: true, target: "project", rules: rules.length, skipped, file, added, backedUp, content: seg };
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    // GATE_PREVIEW=1: 只生成注入段打印统计(token/条数)，不写任何目标文件；用于验证门禁瘦身收益
    if (process.env.GATE_PREVIEW === "1") {
        // 门禁模式不查库（直接返回 GATE_RULES）；全量模式才需要打开 DB
        // 门禁模式也走 pickRules：与生产 syncRules 同一取数口径（内置门禁 + 规则页 inject=1 的规则）
        const rules = pickRules(openDb(DB_PATH));
        const seg = buildSegment(rules);
        const body = seg.replace(/<!--[\s\S]*?-->/g, "").replace(/[#\-\n─]/g, "");
        const tok = Math.round(body.length * 0.75);
        console.log(`[gate-preview] mode=${USE_GATE ? "gate(8条)" : "all"}`);
        console.log(`[gate-preview] rules=${rules.length}`);
        console.log(`[gate-preview] chars=${seg.length} estTokens≈${tok}`);
        console.log("---- 注入段 ----");
        console.log(seg);
        process.exit(0);
    }
    const target = process.argv[2] ?? ""; // 空=全部
    const db = openDb(DB_PATH);
    try {
        const rs = syncRules(db, { target: target || undefined });
        for (const r of rs) {
            console.log(`[sync-rules] ${r.ok ? "OK" : "FAIL"} target=${r.target} rules=${r.rules} skipped=${r.skipped} added=${r.added} backedUp=${r.backedUp}`);
            console.log(`[sync-rules]   file=${r.file}`);
        }
    }
    catch (e) {
        console.error(`[sync-rules] FAIL: ${e}`);
        process.exit(1);
    }
}
