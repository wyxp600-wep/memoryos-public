/**
 * MemoryOS — knowledge 域领域逻辑（架构重构第 2 条「统一操作注册表，消除双传输层」· 批次 D1 / D2a · 2026-10-15）
 *
 * ── 单一真相源 ──────────────────────────────────────────────────────
 *   本模块承载 REST knowledge 域（dashboard-reg-knowledge.js）的领域语义，**逐字自 registerKnowledge 原实现搬出，
 *   行为逐字节不变**（原实现见 git 历史 dashboard-reg-knowledge.js 中对应 handler 段）。
 *   注册表（ops-registry.js）与 REST 路由都指向本模块 —— 领域逻辑只有一份。
 *
 *   批次 D1（7 条 · 知识库 + 只读查询）：
 *     笔记 CRUD（`GET/POST /api/notes`、`PUT/DELETE /api/notes/:id`）· 反向链接 `/api/backlinks` ·
 *     知识图谱 `/api/graph` · 事件手册 `/api/runbook` → op `notes.*` / `runbook.read`。
 *   批次 D2a（10 条 · Agent 域只读 + 简单配置写）：
 *     `GET /api/agents` · `GET /api/agent/status` · `GET /api/agent/runs` · `GET /api/agent/runs/:id` ·
 *     `GET /api/agent/sessions` · `GET /api/agent/sessions/:id` · `GET /api/export/memories` ·
 *     `GET /api/export/audit` · `POST /api/agent/config` · `POST /api/agent/exec-toggle`
 *     → op `agent.*` / `export.*`（domain `agent` / `export`，与 `knowledge` 分开以免动到 D1 的「7 条」口径）。
 *   批次 D2b（17 条 · Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛）：
 *     `POST /api/agent/chat` · `POST /api/agent/runs` · `GET /api/agent/runs/:id/stream` ·
 *     `POST /api/agent/runs/:id/abort` · `GET /api/agent/runs/:id/chain` ·
 *     `POST /api/agent/runs/:id/steps/:sid/rollback` · `GET /api/agent/runs/:id/steps/:sid/output` ·
 *     `POST /api/agent/runs/:id/steps/:sid/approval` · `POST/PUT/DELETE /api/agent/sessions[/:id]` ·
 *     `POST /api/agent/sessions/:id/compact` · `POST /api/agent/sessions/:id/summarize` ·
 *     `GET /api/artifacts/:id` · `POST /api/agent/mcp/restart` ·
 *     `POST /api/agent/plan/decompose` · `POST /api/cards/:id/complete-deps`
 *     → op `agent.*`（15）/ `plan.decompose`（domain `plan`）/ `cards.completeDeps`（domain `task`）。
 *     本批把 registerKnowledge 里的 **run 编排内存模型**（队列 / pumpQueue / startRun / startAgentRun /
 *     abort）也收进 `createAgentRuntime`（同文件），重依赖（agent-core 的 runAgent/buildSystemPrompt/callLlm、
 *     LLM 解析、secret 解密、MCP 句柄）全经 deps 注入。
 *
 * ── ★ 边界（本批刻意，勿越界"统一"）──────────────────────────────────
 *   · handler 契约 = `(ctx, args) => 裸领域值`（ops-registry.js 定死）：**不含** HTTP 状态码 / reply 对象 /
 *     `{ ok }` 信封 / 错误文案。`reply.code(400/404/500/503)`、RESTRICTED 门禁、`{ ok:true, ... }` 包装、
 *     附件头（content-disposition/content-length）与流式写出一律留在传输层（dashboard-reg-knowledge.js）。
 *   · 未找到 / 校验不过用**裸哨兵**回传（不带状态码）：不存在 → `null`；内容为空 → `{ empty: true }`。
 *     ★ 两项校验的**先后顺序与改前逐字一致**：先查笔记在不在（404），再验内容非空（400）——
 *     PUT 路由原实现在查到笔记后才判空，若在传输层提前判空会改变「不存在 + 空内容」的返回码。
 *   · ctx 取**实际用到的最小集**（见各函数）；**不静态 import** obsidian-sync.js / embed.js / agent-core.js /
 *     llm.js / skill-sync.js 等重依赖（ML/IO/进程层）—— 由传输层经 ctx 注入（与 task-domain.js 的 `getEmbedder`
 *     同口径），避免 ops-registry.js 被加载时把 543MB ONNX 运行时或 MCP 子进程面拖进 MCP 工具面。
 *   · D1 这 7 条与 D2a 的 10 条**均不使用调用方身份**（写入方恒为 `human:dashboard`），故无「调用时解析身份」的
 *     accessor —— 「身份严禁在注册期冻成常量」的坑在此不适用（无身份可冻）。
 *     D2a 唯一需要「调用时求值」的进程态是 `RESTRICTED`（出现在 `/api/agent/status` 的**响应体数据**里，非门禁）：
 *     由传输层注入 accessor `isRestricted: () => RESTRICTED`，在调用时才取（不以布尔值冻结进 ctx）。
 *   · D2a 的 `getAgentMcp` / `resetAgentMcp` / `runs`（per-registration 内存 run 注册表）同样是**经 ctx 注入**，
 *     本模块不 import agent-core.js（MCP 客户端）与 agent-runs.js（内存模型）。
 *   · `GET /api/notes` 兼作单条详情（`?id=`）与列表（同一路由、同一领域函数 listNotes 的两个分支）。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────
 *   node:fs / node:path（内置模块，无副作用）；数据访问一律走 ctx.db。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// ★ 批次 D2b：`agent-runs.js` 是**纯模块**（仅 node:fs/path/crypto，无 ML/MCP/进程面）——
//   只静态取三个纯函数（读 artifact 全文 / 行级 diff / 用户消息里的任务号），不吃「不静态 import 重依赖」的边界。
import { readArtifact, simpleDiff, extractArtifactPath, extractTaskHint } from "./agent-runs.js";

/* ══════════════════════════════════════════════════════════════════════
 * 笔记 CRUD（知识库核心）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * `GET /api/notes` —— 笔记列表 / 单条详情。
 * @returns 单条命中 → `{ note }`；不存在 → `null`；列表 → `{ notes }`（行数组）
 * ctx 最小集：`{ db }`
 */
export function listNotes(ctx, args = {}) {
    const db = ctx.db;
    // ?id= 单条详情（含正文，notes.body 由 syncNotesIndex 落全文）——前端编辑器/详情页取正文用
    if (args.id) {
        const one = db
            .prepare(`SELECT id, vault_root, rel_path, title, aliases, tags, sector, body, origin, memory_id, mtime_ms, updated_at FROM notes WHERE id=?`)
            .get(Number(args.id));
        if (!one)
            return null;
        return { note: one };
    }
    const where = [];
    const params = [];
    if (args.vault) {
        where.push("vault_root=?");
        params.push(args.vault);
    }
    if (args.origin) {
        where.push("origin=?");
        params.push(args.origin);
    }
    const rows = (where.length
        ? db.prepare(`SELECT id, vault_root, rel_path, title, tags, sector, origin, mtime_ms FROM notes WHERE ${where.join(" AND ")} ORDER BY mtime_ms DESC LIMIT 500`).all(...params)
        : db.prepare(`SELECT id, vault_root, rel_path, title, tags, sector, origin, mtime_ms FROM notes ORDER BY mtime_ms DESC LIMIT 500`).all());
    return { notes: rows };
}

/**
 * `POST /api/notes` —— 用户自建笔记：写盘（MemoryOS 写入/）+ 同步记忆库 + notes 镜像 + links + M5 回填。
 * 入参校验（vault/title 必填 → 400）与 RESTRICTED 门禁留在传输层；本函数只在合法入参下执行。
 * 失败（vault 不存在等）**直接抛出** —— 由传输层映射为 500 并沿用原错误文案。
 * @returns 裸领域值 `{ file, note_path, memory_id, created }`
 * ctx 最小集：`{ db, getEmbedder, writeNoteToVault }`
 */
export async function createNote(ctx, args = {}) {
    const { db, getEmbedder, writeNoteToVault } = ctx;
    const b = args ?? {};
    const vault = String(b.vault ?? "").trim();
    const title = String(b.title ?? "").trim();
    const content = String(b.content ?? "").trim();
    const embedder = await getEmbedder();
    const r = await writeNoteToVault(db, embedder, {
        vaultPath: vault,
        title,
        content: content || title,
        type: String(b.type ?? ""),
        agent: "human:dashboard",
    });
    return { file: r.file, note_path: r.notePath, memory_id: r.memoryId, created: r.created };
}

/**
 * `PUT /api/notes/:id` —— 编辑笔记（写盘 + 索引同步 + 记忆行联动）。
 * @returns 笔记不存在 → `null`；内容为空 → `{ empty: true }`；成功 → `{ id }`
 * ctx 最小集：`{ db, mapType, syncNotesIndex, updateMemory, logDaemon }`
 */
export function updateNote(ctx, args = {}) {
    const { db, mapType, syncNotesIndex, updateMemory, logDaemon } = ctx;
    const id = Number(args.id);
    const n = db.prepare(`SELECT * FROM notes WHERE id=?`).get(id);
    if (!n)
        return null;
    const content = String(args.content ?? "").trim();
    if (!content)
        return { empty: true };
    const filePath = path.join(n.vault_root, n.rel_path);
    // R4-7：写盘前读 hash，不一致（用户在外改过）→ 写 merge 副本，不覆盖
    const onDisk = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "") : null;
    const bodyMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(onDisk ?? "");
    const diskBody = bodyMatch ? bodyMatch[1].trim() : (onDisk ?? "").trim();
    if (onDisk !== null && diskBody !== content && n.origin === "user") {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const mergePath = `${filePath.slice(0, -3)}.memoryos-merge-${ts}.md`;
        fs.writeFileSync(mergePath, `---\ntitle: ${n.title}\n---\n\n${diskBody}\n`, "utf8");
    }
    // 类型：优先取 body.type（编辑器换类型），否则保留磁盘 frontmatter 原类型，均缺省回落 experience——
    //   改为硬编码 experience 会把 decision/pitfall 笔记在编辑一次后降级（2026-10-02 笔记类型贯通修复）
    const fmType = /^type:\s*(.+)$/m.exec(onDisk ?? "");
    const noteType = mapType(String(args.type ?? fmType?.[1] ?? ""));
    const fm = ["---", `title: ${n.title}`, `type: ${noteType}`, "source: memoryos", "---"].join("\n");
    fs.writeFileSync(filePath, `${fm}\n\n${content}\n`, "utf8");
    syncNotesIndex(db, n.vault_root);
    // ★ 2026-10-02 笔记→记忆联动：写回原文件后同步更新生成时的记忆行（内容+类型）。
    //   updateMemory 置 embedding_stale=1 由 daemon 异步重算向量，FTS/2-gram 同步内置；
    //   联动失败不阻断笔记写回（主操作已成功，留痕排查）。
    if (n.memory_id) {
        try {
            updateMemory(db, n.memory_id, { content, type: noteType });
            logDaemon(db, { task: "manual-edit", op: "edit", memory_id: n.memory_id, operator: "human:dashboard", detail: `笔记编辑联动更新记忆（${n.rel_path}）` });
        }
        catch (e) {
            console.error(`[notes] 记忆联动更新失败 (#${n.memory_id}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { id };
}

/**
 * `DELETE /api/notes/:id` —— 软删：移入 `.trash`（文件）+ 链接退化为未解析（M5）。
 * @returns 笔记不存在 → `null`；成功 → `{ id }`
 * ctx 最小集：`{ db, demoteNoteLinks }`
 */
export function deleteNote(ctx, args = {}) {
    const { db, demoteNoteLinks } = ctx;
    const id = Number(args.id);
    const n = db.prepare(`SELECT * FROM notes WHERE id=?`).get(id);
    if (!n)
        return null;
    // 软删：移入 .trash（文件）+ 链接退化为未解析（M5）
    const trashDir = path.join(n.vault_root, ".trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const filePath = path.join(n.vault_root, n.rel_path);
    try {
        if (fs.existsSync(filePath))
            fs.renameSync(filePath, path.join(trashDir, path.basename(filePath)));
    }
    catch (e) {
        // 注：existsSync 已排除「文件不存在」，此处命中即真实 IO 错误（权限/占用），必须留痕
        console.error(`[notes] 软删移入 .trash 失败（${filePath}）: ${e instanceof Error ? e.message : String(e)}`);
    }
    demoteNoteLinks(db, id);
    db.prepare(`DELETE FROM notes WHERE id=?`).run(id);
    db.prepare(`DELETE FROM links WHERE src_kind='note' AND src_id=?`).run(id);
    return { id };
}

/* ══════════════════════════════════════════════════════════════════════
 * 只读查询（反向链接 / 知识图谱 / 事件手册）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * `GET /api/backlinks` —— 反向链接（linked/unlinked/outgoing/unresolved）。
 * `id 必填` 的 400 属 HTTP 协议行为，留在传输层；本函数在已校验的 id 上执行。
 * @returns 裸领域值 `{ linked, unlinked, outgoing, unresolved }`（与改前响应体的键序一致）
 * ctx 最小集：`{ db }`
 */
export function readBacklinks(ctx, args = {}) {
    const db = ctx.db;
    const kind = String(args.kind ?? "note").trim() || "note";
    const id = Number(args.id);
    const outgoing = db
        .prepare(`SELECT dst_kind, dst_id, dst_title, kind, anchor, alias, context FROM links WHERE src_kind=? AND src_id=?`)
        .all(kind, id);
    const linked = db
        .prepare(`SELECT src_kind, src_id, context FROM links WHERE dst_kind=? AND dst_id=?`)
        .all(kind, id);
    const unresolved = outgoing.filter((l) => l.dst_id === null);
    // unlinked mentions（简化：note 目标按标题 LIKE 检索正文含标题但无 [[ ]] 的候选）
    let unlinked = [];
    if (kind === "note") {
        const me = db.prepare(`SELECT title, vault_root FROM notes WHERE id=?`).get(id);
        if (me) {
            const title = me.title;
            unlinked = db
                .prepare(`SELECT id, body FROM notes WHERE vault_root=? AND id<>? AND body LIKE ? LIMIT 10`)
                .all(me.vault_root, id, `%${title}%`).map((r) => {
                const i = r.body.indexOf(title);
                return { note_id: r.id, snippet: r.body.slice(Math.max(0, i - 40), i + 60) };
            });
        }
    }
    return { linked, unlinked, outgoing, unresolved };
}

/**
 * `GET /api/graph` —— 知识图谱（H1 统一图 + H4 secret 折叠 + R2-1 上限 200 + focus/depth BFS）。
 * 入参归一（scope/depth/focus/sector）随领域逻辑一并搬入本函数（改前即在 handler 内完成）。
 * @returns 裸领域值 `{ nodes, edges, truncated, secret_folded }`
 * ctx 最小集：`{ db }`
 */
export function readGraph(ctx, args = {}) {
    const db = ctx.db;
    const scope = String(args.scope ?? "all").trim() || "all";
    const depth = Math.min(Math.max(Number(args.depth) || 1, 1), 3);
    const focusRaw = String(args.focus ?? "").trim();
    const sectorFilter = String(args.sector ?? "").trim();
    const kinds = scope === "note" ? ["note"] : scope === "memory" ? ["memory"] : scope === "card" ? ["card"] : ["note", "memory", "card"];
    const nodes = [];
    const edges = [];
    const nodeMap = new Map();
    const keyOf = (kind, id) => `${kind}:${id}`;
    const addNode = (kind, id, label, sector) => {
        const k = keyOf(kind, id);
        if (!nodeMap.has(k)) {
            nodeMap.set(k, nodes.length);
            nodes.push({ id: k, kind, label: String(label).slice(0, 60), sector, degree: 0 });
        }
        return nodeMap.get(k);
    };
    // 节点池（secret 记忆折叠为占位节点，R5-4）
    let secretCount = 0;
    if (kinds.includes("note")) {
        const notes = db.prepare(`SELECT id, title, sector FROM notes`).all();
        for (const n of notes)
            addNode("note", n.id, n.title, n.sector);
    }
    if (kinds.includes("memory")) {
        const mems = db
            .prepare(`SELECT id, content, sector, sensitivity FROM memories WHERE status='active' AND sensitivity != 'secret'`)
            .all();
        for (const m of mems)
            addNode("memory", m.id, m.content.slice(0, 60), m.sector);
        secretCount = Number(db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active' AND sensitivity='secret'`).get().c);
    }
    if (kinds.includes("card")) {
        const cards = db.prepare(`SELECT id, title, kind FROM cards WHERE status NOT IN ('archived','cancelled')`).all();
        for (const c of cards)
            addNode("card", c.id, `${c.title.slice(0, 50)}`, c.kind);
    }
    if (secretCount > 0)
        addNode("memory", -1, `secret ×${secretCount}`, "secret");
    // 边：links 表（note/memory/card 互通）
    const linkRows = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, kind FROM links WHERE dst_id IS NOT NULL`).all();
    for (const l of linkRows) {
        const s = nodeMap.get(keyOf(l.src_kind, l.src_id));
        const t = nodeMap.get(keyOf(l.dst_kind, l.dst_id));
        if (s === undefined || t === undefined)
            continue;
        edges.push({ source: nodes[s].id, target: nodes[t].id, kind: l.kind });
    }
    // focus/depth BFS 过滤（内存图）
    if (focusRaw) {
        const fk = nodeMap.get(focusRaw);
        if (fk !== undefined) {
            const adj = new Map();
            for (const e of edges) {
                const s = nodeMap.get(e.source);
                const t = nodeMap.get(e.target);
                (adj.get(s) ?? adj.set(s, []).get(s)).push(t);
                (adj.get(t) ?? adj.set(t, []).get(t)).push(s);
            }
            const keep = new Set([fk]);
            let frontier = [fk];
            for (let d = 0; d < depth && frontier.length; d++) {
                const next = [];
                for (const n of frontier)
                    for (const m of adj.get(n) ?? [])
                        if (!keep.has(m)) {
                            keep.add(m);
                            next.push(m);
                        }
                frontier = next;
            }
            const keepNodes = nodes.filter((_, i) => keep.has(i));
            const keepSet = new Set(keepNodes.map((n) => n.id));
            const keepEdges = edges.filter((e) => keepSet.has(e.source) && keepSet.has(e.target));
            return { nodes: keepNodes, edges: keepEdges, truncated: false, secret_folded: secretCount > 0 };
        }
    }
    // 全局图：按度数截断到 200
    const degreeMap = new Map();
    for (const e of edges) {
        degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
        degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
    }
    nodes.forEach((n, i) => { n.degree = degreeMap.get(n.id) ?? 0; });
    let finalNodes = nodes;
    let truncated = false;
    if (nodes.length > 200) {
        finalNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 200);
        truncated = true;
    }
    const keepIds = new Set(finalNodes.map((n) => n.id));
    const finalEdges = edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
    if (sectorFilter) {
        const kept = finalNodes.filter((n) => n.sector === sectorFilter);
        const keptIds = new Set(kept.map((n) => n.id));
        return { nodes: kept, edges: finalEdges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)), truncated, secret_folded: secretCount > 0 };
    }
    return { nodes: finalNodes, edges: finalEdges, truncated, secret_folded: secretCount > 0 };
}

/**
 * `GET /api/runbook` —— 事件手册（治理合规）：结构化 runbook（处置步骤）+ 近期真实事件（daemon_log + exec_audit 失败/拒绝）。
 * @returns 裸领域值 `{ runbook, recentDaemon, recentExec }`（与改前响应体的键序一致）
 * ctx 最小集：`{ db }`
 */
export function readRunbook(ctx) {
    const db = ctx.db;
    const daemon = db.prepare(`SELECT task, op, detail, operator, created_at FROM daemon_log ORDER BY id DESC LIMIT ?`).all(10);
    const exec = db.prepare(`SELECT tool, agent, risk, approval, detail, created_at FROM exec_audit WHERE approval LIKE '%denied%' OR detail LIKE '%失败%' OR detail LIKE '%error%' ORDER BY id DESC LIMIT ?`).all(10);
    return {
        runbook: [
            { title: "写被门禁拒绝（write_denied / gate-denied）", steps: ["确认操作人/agent 是否有写授权", "受限模式下由系统统一派发，勿手动放行", "查 exec_audit 的 approval 字段定位拦截点"] },
            { title: "agent 执行失败 / LLM 不可达", steps: ["查 /api/agent/status 的 mcp.error 与 llm 端点", "本地 Ollama 需 ollama serve；或在设置页改 llmUrl/llmModel", "MCP 工具面异常点「重启 MCP」"] },
            { title: "记忆治理告警（daemon）", steps: ["查 /api/daemon-health 最近运行时间", "低价值/僵尸记忆走归档（zombies 页）", "冲突记忆走仲裁队列（arbitrate 页）"] },
            { title: "执行面副作用（file_write/exec_run）", steps: ["查 exec_audit 全量（导出审计）", "用「回滚」还原写前快照（≤50KB 工作区内步骤）", "高风险命令默认需人工确认，勿放开 L1 预授权"] },
        ],
        recentDaemon: daemon,
        recentExec: exec,
    };
}

/* ══════════════════════════════════════════════════════════════════════
 * 批次 D2a（2026-10-15）· Agent 域只读 + 简单配置写（10 条 REST 路由）
 *   逐字自 registerKnowledge 原实现搬出，行为逐字节不变；重依赖全经 ctx 注入。
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * `GET /api/agents` —— Agent 画像（泳道 + 负载）：本机已装/已连 agent 清单 + 各自 running/ready 卡片负载。
 * @returns 裸领域值 `{ agents: [{ id, load }] }`（与改前响应体的键序一致；本路由无 `{ ok }` 信封）
 * ctx 最小集：`{ db, detectSkillTargets }`（scanAgents 属进程/磁盘探测层，经 ctx 注入）
 */
export function listAgents(ctx) {
    const { db, detectSkillTargets } = ctx;
    const targets = detectSkillTargets();
    const loadRows = db.prepare(`SELECT assignee, COUNT(*) c FROM cards WHERE status IN ('running','ready') AND assignee IS NOT NULL GROUP BY assignee`).all();
    const load = new Map(loadRows.map((r) => [r.assignee, r.c]));
    return {
        agents: (Array.isArray(targets) ? targets : []).map((a) => ({
            id: a?.name ?? a?.id ?? String(a),
            load: load.get(a?.name ?? a?.id ?? String(a)) ?? 0,
        })),
    };
}

/**
 * `GET /api/agent/status` —— agent 状态：模型端点 + 工具面 + 写门禁（前端页头直接展示）。
 * RESTRICTED 在此是**响应体数据**（writeMode），非门禁 —— 经 ctx.isRestricted() 调用时求值（不冻结常量）。
 * MCP 工具面取不到时本函数内 `resetAgentMcp()` 清坏句柄（副作用属领域语义，与改前同处）。
 * @returns 裸领域值 `{ agent, llm, mcp, writeMode, tuning }`（`ok` 信封由传输层补，键序不变）
 * ctx 最小集：`{ readDiskConfig, unprotectSecret, resolveLlm, getAgentMcp, resetAgentMcp, getLogLevel, agentTuning, runs, isRestricted }`
 */
export async function readAgentStatus(ctx) {
    const { readDiskConfig, unprotectSecret, resolveLlm, getAgentMcp, resetAgentMcp, getLogLevel, agentTuning, runs, isRestricted } = ctx;
    const RESTRICTED = isRestricted();
    const disk = readDiskConfig();
    // 密钥：env 优先，否则解 config.json 的 DPAPI 密文（与 llm.js 同口径）
    const key = process.env.LLM_API_KEY || process.env.INGEST_KEY || (disk.llmKeyEnc ? await unprotectSecret(disk.llmKeyEnc) : null);
    const llm = resolveLlm({ baseUrl: disk.llmUrl || undefined, model: disk.llmModel || undefined, apiKey: key || undefined });
    let tools = null;
    let mcpError = null;
    try {
        tools = (await (await getAgentMcp()).tools()).map((t) => t.name);
    }
    catch (e) {
        resetAgentMcp(); // 拉起失败不缓存坏句柄，下次请求重试
        mcpError = e instanceof Error ? e.message : String(e);
    }
    return {
        agent: "dashboard-agent",
        llm: {
            model: llm.model,
            baseUrl: llm.baseUrl,
            endpoint: `${llm.baseUrl}/chat/completions`,
            source: disk.llmUrl ? "config.json（设置页）" : "默认本地 Ollama",
            keySet: !!key,
        },
        mcp: { tools: tools ?? [], toolCount: tools?.length ?? 0, error: mcpError },
        writeMode: {
            allowed: !RESTRICTED,
            restricted: RESTRICTED,
            hint: RESTRICTED
                ? "受限模式：由系统统一派发，agent 仅可读"
                : "默认只读；勾选「允许写入记忆库」后本次对话内 agent 的写类工具才会执行",
        },
        // ★ 驾驶舱调优项现值（前端各旋钮初始化用；running/queued 为内存实时值）
        tuning: {
            ...agentTuning(),
            logLevelNow: getLogLevel(),
            running: runs.runningCount(),
            queued: runs.queuedCount(),
            execTools: (tools ?? []).filter((n) => n === "file_read" || n === "file_write" || n === "exec_run").length,
        },
    };
}

/**
 * `GET /api/agent/runs` —— run 列表（活动 + 终态，内存保留最近 50）。
 * @returns 裸领域值 `{ runs, total }`（`ok` 信封由传输层补）
 * ctx 最小集：`{ runs }`（per-registration 内存 run 注册表，agent-runs.js 经传输层注入）
 */
export function listAgentRuns(ctx) {
    const list = ctx.runs.allRuns();
    return { runs: list, total: list.length };
}

/**
 * `GET /api/agent/runs/:id` —— 单 run 全量（steps + 事件回放 + 答案）。
 * @returns 不存在 → `null`；命中 → `{ ...list, answer, events }`（`ok` 信封与 404 由传输层处理）
 * ctx 最小集：`{ runs }`
 */
export function readAgentRun(ctx, args = {}) {
    const h = ctx.runs.getRun(args.id);
    if (!h)
        return null;
    const l = h.list();
    return { ...l, answer: h.run.answer, events: h.run.events };
}

/**
 * `GET /api/agent/sessions` —— Agent 会话列表（agent_sessions 表）。
 * @returns 裸领域值 `{ sessions }`（`ok` 信封由传输层补）
 * ctx 最小集：`{ db, listAgentSessions }`
 */
export function listAgentSessions(ctx) {
    return { sessions: ctx.listAgentSessions(ctx.db) };
}

/**
 * `GET /api/agent/sessions/:id` —— 单会话详情（含 messages）。
 * @returns 不存在 → `null`；命中 → 会话对象（`ok` 信封与 404 由传输层处理）
 * ctx 最小集：`{ db, getAgentSession }`
 */
export function readAgentSession(ctx, args = {}) {
    const s = ctx.getAgentSession(ctx.db, args.id);
    return s ?? null;
}

/**
 * `GET /api/export/memories` —— 全量记忆导出（JSON 附件；复用 /api/all SQL 口径）。
 * 只产出**行数组**；附件头（content-disposition/content-length）、`{ exportedAt, count, rows }` 信封与
 * 流式写出一律留在传输层（HTTP 协议行为）。
 * @returns 裸领域值 `{ rows }`
 * ctx 最小集：`{ db }`
 */
export function exportMemories(ctx, args = {}) {
    const db = ctx.db;
    const limit = Math.min(Math.max(Number(args.limit ?? 5000) || 5000, 1), 20000);
    const status = (args.status ?? "").trim();
    const where = status ? `WHERE status=?` : "";
    const rows = db
        .prepare(`SELECT id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence,
                      conflict_with, superseded_by, derived_from, hit_count, created_at
           FROM memories ${where} ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`)
        .all(...(status ? [status, limit] : [limit]));
    return { rows };
}

/**
 * `GET /api/export/audit` —— 执行审计导出（JSON 附件；全量 exec_audit 只读）。
 * @returns 裸领域值 `{ rows }`（信封 / 附件头 / 流式写出留在传输层）
 * ctx 最小集：`{ db, allExecAudit }`
 */
export function exportAudit(ctx, args = {}) {
    const limit = Math.min(Math.max(Number(args.limit ?? 5000) || 5000, 1), 5000);
    const rows = ctx.allExecAudit(ctx.db, limit);
    return { rows };
}

/**
 * `POST /api/agent/config` —— 调优旋钮：缓存开关 / token 预算 / 并行数 / 日志级别（config.json 顶层键，即时生效）。
 * 入参校验（budgetTokens 0..1e7 / maxConcurrent 1..8 / logLevel 枚举 / 无可更新字段 → 400）与错误文案
 * 属 HTTP 协议行为，留在传输层；本函数只在**已通过校验**的入参上执行（逐字保留改前的应用顺序与 changed 文案，
 * 含 logLevel 走 setLogLevel 的即时生效位置）。
 * 写盘失败**直接抛出** —— 由传输层映射为 500 并沿用原错误文案。
 * @returns 裸领域值 `{ changed, tuning }`（`ok` 信封由传输层补）
 * ctx 最小集：`{ readDiskConfig, writeDiskConfig, setLogLevel, agentTuning }`
 */
export function setAgentConfig(ctx, args = {}) {
    const { readDiskConfig, writeDiskConfig, setLogLevel, agentTuning } = ctx;
    const b = args ?? {};
    const cfg = readDiskConfig();
    const changed = [];
    if (b.cache !== undefined) {
        cfg.llmCache = b.cache === true;
        changed.push("llmCache=" + cfg.llmCache);
    }
    if (b.budgetTokens !== undefined) {
        const n = Math.floor(Number(b.budgetTokens));
        cfg.tokenBudget = n;
        changed.push("tokenBudget=" + n);
    }
    if (b.maxConcurrent !== undefined) {
        const n = Math.floor(Number(b.maxConcurrent));
        cfg.maxConcurrent = n;
        changed.push("maxConcurrent=" + n);
    }
    if (b.logLevel !== undefined) {
        cfg.logLevel = b.logLevel;
        setLogLevel(b.logLevel);   // 内核内存级即时生效（5xx 诊断门控）
        changed.push("logLevel=" + b.logLevel);
    }
    writeDiskConfig(cfg);
    return { changed, tuning: agentTuning() };
}

/**
 * `POST /api/agent/exec-toggle` —— 执行工具开关：设 MEMORYOS_EXEC_ON + 持久化 execOn + 重 spawn MCP。
 * 入参校验（on 须为 boolean → 400）与 403/503 状态码留在传输层；重启失败时本函数内 `resetAgentMcp()` 清句柄后
 * **抛出** —— 由传输层映射为 503 并沿用原错误文案（execOn 由传输层从入参带回）。
 * @returns 裸领域值 `{ execOn, toolCount, execTools }`（`ok` 信封由传输层补）
 * ctx 最小集：`{ readDiskConfig, writeDiskConfig, setAgentMcpEnv, getAgentMcp, resetAgentMcp }`
 */
export async function toggleExecFace(ctx, args = {}) {
    const { readDiskConfig, writeDiskConfig, setAgentMcpEnv, getAgentMcp, resetAgentMcp } = ctx;
    const on = args.on;
    const cfg = readDiskConfig();
    cfg.execOn = on;
    writeDiskConfig(cfg);
    setAgentMcpEnv({ MEMORYOS_EXEC_ON: on ? "1" : "0" });
    try {
        const prev = await getAgentMcp().catch(() => null);
        try { await prev?.close(); } catch { /* 已坏/未起 */ }
        resetAgentMcp();
        const fresh = await getAgentMcp();
        const tools = await fresh.tools();
        const execTools = tools.filter((t) => ["file_read", "file_write", "exec_run"].includes(t.name)).map((t) => t.name);
        return { execOn: on, toolCount: tools.length, execTools };
    }
    catch (e) {
        resetAgentMcp();
        throw e;
    }
}

/* ══════════════════════════════════════════════════════════════════════
 * 批次 D2b（2026-10-15）· Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛（17 条 REST 路由）
 *   逐字自 registerKnowledge 原实现搬出，行为逐字节不变；重依赖与进程态全经 ctx 注入，
 *   RESTRICTED / 卡片收口以 accessor（调用时求值）注入。
 *   ★ 未找到 / 校验不过 / 协议失败一律用**裸哨兵**回传（不带状态码）：不存在 → `null`；
 *     其余分支用布尔键（`noStep` / `notRollbackable` / `llmConfigError` …），状态码与文案留传输层。
 * ══════════════════════════════════════════════════════════════════════ */

/** 读「本 run 内存模型」写文件步骤的写前快照（与改前 registerKnowledge 的 readSnapshot 逐字同源）。 */
function readSnapshotFile(absOrNull) {
    if (!absOrNull) return null;
    try { return fs.existsSync(absOrNull) ? fs.readFileSync(absOrNull, "utf8") : ""; }
    catch { return null; }
}

/**
 * run 编排内存模型工厂（`POST /api/agent/runs` 起 run / 并发排队 pumpQueue / `abort` 中止的领域语义）。
 * ★ 全部进程态与重依赖经 deps 注入 —— 本函数**不** spawn 子进程、**不**静态 import agent-core / llm。
 * ★ `isRestricted` / `finalizeCardDispatch` 是 **accessor（调用时求值）**：RESTRICTED 属运行时策略，
 *   绝不能在注册期冻成常量。
 * @returns { startAgentRun, abortRun, resolveLlmCfg }
 */
export function createAgentRuntime(deps) {
    const {
        db, readDiskConfig, unprotectSecret, resolveLlm, buildSystemPrompt, runAgent,
        getAgentMcp, resetAgentMcp, agentTuning, runs,
        appendAgentSession, renewCardLease,
        finalizeCardDispatch, isRestricted, workspaceRoot, resolveInside,
    } = deps;
    const WORKSPACE_ROOT = workspaceRoot;
    const runQueue = [];
    const dispatchRuns = new Map();

    /** 解析 file_write 参数里的路径 → 工作区内真实路径（resolveInside 边界校验：越界/UNC 拒绝，防符号链接逃逸） */
    function safeSnapshotPath(p) {
        try { return resolveInside(WORKSPACE_ROOT, String(p || "")); }
        catch { return null; }
    }
    /** 解析当前可用 LLM（与 startRun 同口径：env > config.json 的 llmKeyEnc 解密 > 默认 Ollama）
     *  ★ env 在**调用时**读取（不冻结成注册期常量）。 */
    async function resolveLlmCfg() {
        const disk = readDiskConfig();
        const key = process.env.LLM_API_KEY || process.env.INGEST_KEY || (disk.llmKeyEnc ? await unprotectSecret(disk.llmKeyEnc) : null);
        const llm = resolveLlm({ baseUrl: disk.llmUrl || undefined, model: disk.llmModel || undefined, apiKey: key || undefined });
        return { llm, key };
    }
    /* ★ 驾驶舱「并行数」排队：超并发上限的 run 以 queued 建入 runQueue，空位腾出（任一 run finish）
     * 由 pumpQueue 依次 markRunning + startRun。mcp 每次 pump 现取（getAgentMcp 单例，exec-toggle 重启后拿到新句柄）。 */
    async function pumpQueue() {
        const cap = agentTuning().maxConcurrent;
        while (runQueue.length) {
            if (runs.runningCount() >= cap) break;
            const item = runQueue.shift();
            // 该 run 在排队期间被 abort（状态已终态）→ 跳过不启动
            if (!item.handle.markRunning()) continue;
            try {
                const mcp = await getAgentMcp();
                startRun(item.handle, item.b, mcp).catch(() => { });   // 启动失败 startRun 内 catch → finish("failed") → 再 pump
            }
            catch (e) {
                item.handle.finish("failed", { error: "排队启动失败：" + (e instanceof Error ? e.message : String(e)) });
            }
        }
    }
    /** 跑一轮后台 agent run：共享 /chat 的 LLM 解析与 MCP 获取口径；onStep 喂 run 事件流。
     *  writeGate 规则与 /chat 完全一致：allowWrites=true 且非受限 才放行写。 */
    async function startRun(handle, b, mcp) {
        const { llm } = await resolveLlmCfg();
        const message = String(b.message ?? "").trim();
        const messages = [{ role: "system", content: buildSystemPrompt("dashboard-agent") }];
        for (const h of (Array.isArray(b.history) ? b.history.slice(-12) : [])) {
            const role = h?.role === "assistant" ? "assistant" : h?.role === "user" ? "user" : null;
            const content = String(h?.content ?? "").trim().slice(0, 3000);
            if (role && content)
                messages.push({ role, content });
        }
        messages.push({ role: "user", content: message });
        const allowWrites = b.allowWrites === true && !isRestricted();
        const maxSteps = Math.min(Math.max(Number(b.maxSteps) || 8, 1), 16);
        // ★ 驾驶舱调优项：LLM 缓存开关 + token 预算上限（现读 config.json，即时生效）
        const tuning = agentTuning();
        // 任务联动：用户消息里的「任务 #N」→ run 的 taskHint（呈现层 join 用，不自动 claim，B1）
        const taskHint = b.taskHint != null ? Number(b.taskHint) : extractTaskHint(message);
        handle.run.taskHint = taskHint ?? null;
        // ★ A1 一键派发：本 run 绑定的卡片（无绑定 = 普通对话 run，下面三条派发逻辑全部不触发）
        const cd = b.cardDispatch?.cardId ? b.cardDispatch : null;
        let doneSeen = false; // agent 是否已自行 task_done（没做 → 终态前强制收尾轮补一枪）
        const touchedFiles = new Set(); // ★ P4 详版交接：本次 run 改动过的文件路径
        // 写文件类步骤的前后快照（diff 数据源在路由层注入；路径经 resolveInside 边界校验，越界不快照）
        // ★ 并行池：一轮可能含多个 file_write（L1 独占串行跑，但 tool_call 事件在前置门禁里先批量发）——
        //   快照按 FIFO 队列逐条配对（tool_result 按模型序到达，与创建序一致），单槽会被后一次覆盖而错配。
        const snapshotQueue = [];
        const onStep = (s) => {
            if (s.type === "tool_call" && s.tool === "file_write") {
                const p = safeSnapshotPath(s.args?.path);
                snapshotQueue.push({ path: p, before: readSnapshotFile(p) });
            }
            if (s.type === "tool_result" && s.tool === "file_write") {
                if (s.artifactPath)
                    touchedFiles.add(String(s.artifactPath)); // ★ P4 详版交接：收集改动文件清单
                const snap = snapshotQueue.shift();
                const sid = handle.run.steps.find((x) => x.tool === "file_write" && x.state === "pending")?.stepId;
                if (sid != null && snap) {
                    const after = readSnapshotFile(snap.path);
                    const diff = simpleDiff(snap.before ?? "", after ?? "", String(snap.path ?? ""));
                    diff.beforeText = snap.before != null && snap.before.length <= 50000 ? snap.before : null;
                    diff.beforePath = snap.before != null && snap.before.length <= 50000 ? snap.path : null;
                    handle.setStepDiff(sid, diff);
                }
            }
            handle.onStep(s);
            // 大输出：从工具结果全文提取 artifact 路径（exec-tools 截断时回传「完整输出：<abs>」）
            if (s.type === "tool_result" && s.tool === "file_edit" && s.artifactPath)
                touchedFiles.add(String(s.artifactPath));
            if (s.type === "tool_result" && s.result) {
                const ap = extractArtifactPath(s.result);
                if (ap) handle.run.steps[handle.run.steps.length - 1].artifactPath = ap;
            }
            // 任务联动事件：task_done 成功 → 推 task_done（前端任务看板 join）
            const lastStep = handle.run.steps[handle.run.steps.length - 1];
            if (s.type === "tool_result" && s.tool === "task_done" && s.ok && lastStep?.taskDone) {
                handle.ev("task_done", { taskId: lastStep.taskDone });
            }
            // ★ A1 派发 run：记下 agent 已收口。租约打卡改为 60s 定时器（时间驱动）——
            //   原绑定 onStep 节奏：单轮长生成（无工具调用）超 10 分钟租约即过期被 reaper 误杀。
            if (cd) {
                if (s.type === "tool_result" && s.tool === "task_done" && s.ok)
                    doneSeen = true;
            }
        };
        let runHeartbeat = null; // 派发 run 的租约定时器（终态后清除）
        const startRunHeartbeat = (cd) => {
            if (!cd || runHeartbeat)
                return;
            runHeartbeat = setInterval(() => {
                try {
                    renewCardLease(db, cd.cardId, cd.dispatchId);
                }
                catch { /* 打卡失败不阻断 run */ }
            }, 60000);
        };
        let runAnswer = ""; // ★ P4：run 最终回复（try 块内赋值，收口处生成交接卡用）
        startRunHeartbeat(cd); // 派发 run 的租约续期（仅 cd 生效；定时器在收口 finally 清除）
        try {
            // ★ A1：中止运行 —— 传 AbortSignal（agent-core 轮次间 + LLM fetch 可中断；
            //   进行中的 mcp.callTool 跑完，不硬杀进程）。
            const r = await runAgent({
                llm, mcp, messages, maxSteps,
                onStep,
                writeGate: allowWrites ? (() => true) : () => false,
                signal: handle.run.abortCtrl.signal,
                cache: tuning.llmCache,                  // ★ 驾驶舱「缓存」：同历史轮次命中 LLM 响应缓存
                budgetTokens: tuning.tokenBudget,        // ★ 驾驶舱「预算上限」：超预算即中止本 run
                stream: true,                            // ★ 批次①（2026-09-23）：各轮流式 answer_delta；cacheOn 时 runAgent 内自动降级非流式（互斥）
            });
            // ★ A1 强制收尾轮（对标 dist/agent.js:216 CLI 同款）：绑定任务却忘了 task_done →
            //   只给 task_done 一个工具补一枪（toolsFilter 最小权限）；收尾失败不覆盖主结果。
            if (cd && cd.taskId && !doneSeen && allowWrites && !handle.run.abortCtrl.signal.aborted) {
                try {
                    await runAgent({
                        llm, mcp,
                        messages: [...messages, { role: "user", content: `现在只用 task_done 结项：调用 task_done(memory_id=${cd.taskId}, conclusion="<你上面给出的结论摘要，≤200字>", dispatch_key="${cd.dispatchKey}")。不要再调用其它工具。` }],
                        maxSteps: 2, toolsFilter: ["task_done"],
                        onStep, writeGate: () => true,
                        signal: handle.run.abortCtrl.signal,
                    });
                }
                catch (e) { console.error(`[dispatch] 强制收尾轮失败：${e instanceof Error ? e.message : e}`); }
            }
            handle.finish("done", { answer: r.answer, usage: r.usage, estimatedTokens: r.estimatedTokens, cache: r.cache || null });
            runAnswer = String(r.answer ?? ""); // ★ P4：带出 try 块供收口交接卡使用（r 为块内局部量）
            // 会话持久化：把本轮 user/assistant 追加进 agent_sessions（写入方截断纪律）
            if (b.sessionKey) {
                try {
                    appendAgentSession(db, { sessionKey: b.sessionKey, role: "user", content: message.slice(0, 3000), title: b.title });
                    appendAgentSession(db, { sessionKey: b.sessionKey, role: "assistant", content: r.answer.slice(0, 3000), title: b.title });
                }
                catch { /* 会话写失败不阻断 run */ }
            }
        }
        catch (e) {
            handle.finish("failed", { error: e instanceof Error ? e.message : String(e) });
        }
        // ★ A1 派发收口：run 终态 → 回写卡片状态机 + 结算工作证（幂等；收口异常不改 run 终态）
        if (cd) {
            dispatchRuns.delete(handle.run.id);
            try {
                const ok = handle.run.status === "done";
                finalizeCardDispatch({
                    ...cd, ok, runId: handle.run.id,
                    answer: ok ? runAnswer.slice(0, 2400) : undefined, // ★ P4 详版交接：最终回复（上限放宽到 2400）
                    files: ok ? [...touchedFiles].slice(0, 50) : undefined, // ★ P4 详版交接：改动文件清单
                    durationMs: Date.now() - handle.run.startedAt, channel: "queue",
                    detail: ok
                        ? `一键派发完成（run ${handle.run.id}）`
                        : `一键派发失败（run ${handle.run.id}）：${handle.run.error ?? "未知错误"}`,
                });
            }
            catch (e) { console.error(`[dispatch] 收口失败：${e instanceof Error ? e.message : e}`); }
            finally { if (runHeartbeat) { clearInterval(runHeartbeat); runHeartbeat = null; } }
        }
        // 本轮 run 终态 → 空出并发位，启动排队的下一个（★ 驾驶舱「并行数」）
        await pumpQueue();
    }
    /**
     * ★ A1 一键派发：把「起 run」的能力交给 cards 域复用（dashboard.js 先 registerCards 后
     * registerKnowledge，请求期两个挂载点均已就位）。与 POST /api/agent/runs 同一路径：
     * 建 handle → 超并发排队 / 直接开跑；b.cardDispatch 存反查表供 abort 收口。
     */
    async function startAgentRun(b) {
        const message = String(b.message ?? "").trim();
        if (!message)
            throw new Error("message 不能为空");
        if (message.length > 4000)
            throw new Error("message 过长（上限 4000 字）");
        let mcp;
        try {
            mcp = await getAgentMcp();
        }
        catch (e) {
            resetAgentMcp();
            throw new Error("MCP 工具面不可用：" + (e instanceof Error ? e.message : String(e)));
        }
        const cap = agentTuning().maxConcurrent;
        const deferred = runs.runningCount() >= cap;
        const handle = runs.createRun({ sessionId: b.sessionKey || undefined, title: b.title || message.slice(0, 60), taskHint: b.taskHint }, { deferred });
        if (b.cardDispatch?.cardId) {
            if (dispatchRuns.size > 200)
                dispatchRuns.delete(dispatchRuns.keys().next().value); // ★ 删最旧而非 clear()：清空会让排队 run 中止时补收口失效
            dispatchRuns.set(handle.run.id, b.cardDispatch);
        }
        if (deferred) {
            runQueue.push({ handle, b });
            return { runId: handle.run.id, status: "queued", queueAhead: runQueue.length - 1, cap };
        }
        startRun(handle, b, mcp).catch(() => { }); // 错误在 startRun 内 catch → finish("failed")
        return { runId: handle.run.id, status: "running", cap };
    }
    /**
     * ★ A1 中止运行：触发 AbortSignal（轮次间 + LLM fetch 可中断；进行中工具调用跑完）。
     * queued 状态亦可中止（取消排队）；中止后空出的并发位由 pumpQueue 启动排队下一个。
     * @returns `{ notFound:true }`（无此 run）/ `{ terminal:<status> }`（已终态）/ `{ runId, status:"aborted" }`
     */
    async function abortRun(id, reason) {
        const h = runs.getRun(id);
        if (!h)
            return { notFound: true };
        if (h.run.status !== "running" && h.run.status !== "queued")
            return { terminal: h.run.status };
        const wasQueued = h.run.status === "queued";
        h.abort(String(reason || "用户手动中止"));
        if (wasQueued) {
            const qi = runQueue.findIndex((x) => x.handle.run.id === h.run.id);
            if (qi !== -1)
                runQueue.splice(qi, 1);
            // ★ A1：排队中的派发 run 被中止 → startRun 永远不会跑，这里补收口（否则卡片永远 running）
            const cdQ = dispatchRuns.get(h.run.id);
            if (cdQ) {
                dispatchRuns.delete(h.run.id);
                try { finalizeCardDispatch({ ...cdQ, ok: false, runId: h.run.id, detail: `派发 run 排队中被中止（${h.run.status}）` }); }
                catch { /* 收口失败不影响中止响应 */ }
            }
        }
        await pumpQueue();   // running 被中止 → 空出并发位
        return { runId: h.run.id, status: "aborted" };
    }

    return { startAgentRun, abortRun, resolveLlmCfg };
}

/* ── `POST /api/agent/chat`：跑一轮 agent（返回答案 + 工具轨迹）——LLM/MCP/写门禁经 ctx 注入 ── */
export async function agentChat(ctx, args = {}) {
    const { readDiskConfig, unprotectSecret, resolveLlm, getAgentMcp, resetAgentMcp, buildSystemPrompt, runAgent, isRestricted } = ctx;
    const b = args ?? {};
    const message = String(b.message ?? "").trim();
    const disk = readDiskConfig();
    const key = process.env.LLM_API_KEY || process.env.INGEST_KEY || (disk.llmKeyEnc ? await unprotectSecret(disk.llmKeyEnc) : null);
    const llm = resolveLlm({ baseUrl: disk.llmUrl || undefined, model: disk.llmModel || undefined, apiKey: key || undefined });
    let mcp;
    try {
        mcp = await getAgentMcp();
    }
    catch (e) {
        resetAgentMcp();
        return { mcpUnavailable: e instanceof Error ? e.message : String(e) };
    }
    const messages = [{ role: "system", content: buildSystemPrompt("dashboard-agent") }];
    for (const h of (Array.isArray(b.history) ? b.history.slice(-12) : [])) {
        const role = h?.role === "assistant" ? "assistant" : h?.role === "user" ? "user" : null;
        const content = String(h?.content ?? "").trim().slice(0, 3000);
        if (role && content)
            messages.push({ role, content });
    }
    messages.push({ role: "user", content: message });
    const allowWrites = b.allowWrites === true && !isRestricted();
    const toolLog = [];
    const denied = [];
    const t0 = Date.now();
    const steps = Math.min(Math.max(Number(b.maxSteps) || 8, 1), 16);
    try {
        const r = await runAgent({
            llm, mcp, messages, maxSteps: steps,
            onStep: (s) => {
                if (s.type === "tool_call")
                    toolLog.push({ tool: s.tool, args: JSON.stringify(s.args ?? {}).slice(0, 240), ok: null });
                if (s.type === "tool_result") {
                    const last = toolLog[toolLog.length - 1];
                    if (last && last.tool === s.tool)
                        last.ok = s.ok;
                }
                if (s.type === "write_denied")
                    denied.push(s.tool);
            },
            // 未获同意 → 写门禁一律拒绝（agent 收到拒绝提示后改为只读作答，不会硬重试）
            writeGate: allowWrites ? (() => true) : () => false,
        });
        return {
            answer: r.answer, steps: r.steps,
            toolLog, deniedWrites: denied, allowWrites, elapsedMs: Date.now() - t0,
            llm: { model: llm.model, baseUrl: llm.baseUrl },
        };
    }
    catch (e) {
        // ★ 失败分支不带状态码/文案：原始 msg 与 baseUrl 交传输层拼 502 文案（含 hint 判定）
        return { chatFailed: true, msg: e instanceof Error ? e.message : String(e), toolLog, elapsedMs: Date.now() - t0, baseUrl: llm.baseUrl };
    }
}

/* ── `POST /api/agent/runs`：起 run（`startAgentRun` 经 ctx 注入；排队/并发/派发反查表在 runtime 内） ── */
export async function createAgentRun(ctx, args = {}) {
    return await ctx.startAgentRun(args);
}

/* ── `POST /api/agent/runs/:id/abort` ── */
export async function abortAgentRun(ctx, args = {}) {
    return await ctx.abortRun(args.id, args.reason);
}

/* ── `GET /api/agent/runs/:id/chain`：把某 run 的工具调用串成机器可读 trace ── */
export function readAgentRunChain(ctx, args = {}) {
    const h = ctx.runs.getRun(args.id);
    if (!h)
        return null;
    const l = h.list();
    const chain = (l.steps || []).map((s, i) => ({
        n: i + 1,
        tool: s.tool,
        state: s.state,
        ok: s.ok ?? null,
        ms: s.elapsedMs ?? 0,
        outChars: s.outChars ?? 0,
        hasArtifact: !!s.artifactPath,
        hasDiff: !!s.hasDiff,
        taskDone: s.taskDone ?? null,
        feedsNext: i < (l.steps.length - 1),   // 线性 agent 循环：每步结果喂下一轮 LLM
    }));
    return {
        runId: l.runId, status: l.status, title: l.title,
        llmRounds: l.maxSteps, toolCalls: l.toolCalls,
        usage: l.usage, estimatedTokens: l.estimatedTokens,
        startMs: l.startedAt, endMs: l.finishedAt,
        chain,
    };
}

/* ── `GET /api/agent/runs/:id/steps/:sid/output`：大输出按段拉取（无 artifact 步骤返回内联预览） ── */
export function readAgentStepOutput(ctx, args = {}) {
    const h = ctx.runs.getRun(args.id);
    if (!h)
        return { noRun: true };
    const step = h.run.steps.find((x) => x.stepId === Number(args.sid));
    if (!step)
        return { noStep: true };
    if (!step.artifactPath)
        return { inline: step.preview, totalLines: 0, from: 0, to: 0 };
    const dataDir = ctx.dataDirOf() || "";
    const r = readArtifact(dataDir, step.artifactPath, args.range ? [Number(args.range[0]), Number(args.range[1])] : null);
    if (!r.ok)
        return { artifactError: r.error };
    // 键序与改前 readArtifact 返回体一致（去掉其 ok 字段，信封由传输层补）
    return { lines: r.lines, totalLines: r.totalLines, from: r.from, to: r.to, totalBytes: r.totalBytes };
}

/* ── `POST /api/agent/runs/:id/steps/:sid/approval`：审批三键端点（B1：未启用一律 501 占位）── */
export function readAgentStepApproval(ctx, args = {}) {
    const h = ctx.runs.getRun(args.id);
    if (!h)
        return null;
    return { approval: "pending" };
}

/* ── `POST /api/agent/runs/:id/steps/:sid/rollback`：把某 file_write 步骤的写前快照写回原路径 ── */
export function rollbackAgentStep(ctx, args = {}) {
    const { runs, workspaceRoot, resolveInside, logExecAudit } = ctx;
    const h = runs.getRun(args.id);
    if (!h)
        return { noRun: true };
    const step = h.run.steps.find((x) => x.stepId === Number(args.sid));
    if (!step)
        return { noStep: true };
    if (!step.hasDiff)
        return { notRollbackable: true };
    const beforeText = step.diff?.beforeText;
    const beforePath = step.diff?.beforePath;
    if (beforeText == null || !beforePath)
        return { noSnapshot: true };
    // 路径边界再校验（resolveInside），防 run 内存被污染后写任意路径
    let target = null;
    try { target = resolveInside(workspaceRoot, beforePath); } catch { target = null; }
    if (!target)
        return { pathEscaped: true };
    try {
        fs.writeFileSync(target, beforeText, "utf8");
    }
    catch (e) {
        console.error(`[rollback] 步骤写回失败（${target}）: ${e instanceof Error ? e.message : String(e)}`);
        return { writeFailed: true, error: e instanceof Error ? e.message : String(e) };
    }
    logExecAudit(ctx.db, {
        tool: "file_write", agent: "dashboard-rollback", risk: "L1", approval: "gate-allowed",
        argsDigest: `rollback step#${step.stepId} → ${beforePath}`,
        detail: `已还原写前快照（${Buffer.byteLength(beforeText, "utf8")} 字节）`, durationMs: 0,
    });
    // 重算该步 diff（现为「当前 vs 快照」，标记已回滚）
    const now = readSnapshotFile(target);
    step.diff = { ...step.diff, rolledBack: true, rolledBackAt: Date.now() };
    h.ev("rollback", { stepId: step.stepId, file: beforePath, bytes: Buffer.byteLength(beforeText, "utf8") });
    return { runId: h.run.id, stepId: step.stepId, file: beforePath, restoredBytes: Buffer.byteLength(beforeText, "utf8"), nowMatchesSnapshot: now === beforeText };
}

/**
 * `GET /api/agent/runs/:id/stream`（SSE）—— ★ **只产事件序列，不写响应**。
 * 返回 null（无此 run）或 `{ status(), replay(), subscribe() }`：
 *   · `status()` 取当前 run 状态（终态判定用，**调用时求值**）；
 *   · `replay()` 取 `seq > sinceSeq` 的历史事件（Last-Event-ID 回补窗口）；
 *   · `subscribe(onEvent)` 注册订阅并内置「seq > sinceSeq 才推」去重；**返回退订函数**
 *     （HTTP 端的 `req.raw.on("close", unsub)` 就是「客户端断开清理」的接线点）。
 * ★ HTTP 头（text/event-stream / no-cache / keep-alive）、`: agent-run stream` 注释行、
 *   `reply.raw.write`、`error` 监听与 `end()` 全部留在传输层。
 * ctx 最小集：`{ runs }`
 */
export function openAgentRunStream(ctx, args = {}) {
    const h = ctx.runs.getRun(args.id);
    if (!h)
        return null;
    return {
        status: () => h.run.status,
        replay: () => {
            const out = [];
            h.evSince(h.run, args.sinceSeq, out);
            return out.map((e) => ({ seq: e.seq, event: e.event, data: e.data }));
        },
        subscribe: (onEvent) => {
            let sent = args.sinceSeq;
            return h.subscribe({
                onEvent: (type, data, seq) => {
                    if (seq > sent) {
                        sent = seq;
                        onEvent({ seq, event: type, data });
                    }
                },
            });
        },
    };
}

/* ── Agent 会话 CRUD（agent_sessions 表）── */
export function createAgentSession(ctx, args = {}) {
    const b = args ?? {};
    const sessionKey = String(b.sessionKey || crypto.randomUUID()).slice(0, 64);
    ctx.saveAgentSession(ctx.db, { sessionKey, title: String(b.title || "").slice(0, 200), messages: [] });
    return { sessionKey };
}
export function updateAgentSession(ctx, args = {}) {
    const { db, getAgentSession, saveAgentSession } = ctx;
    const cur = getAgentSession(db, args.id);
    if (!cur)
        return null;
    saveAgentSession(db, { sessionKey: args.id, title: args.title ?? cur.title, messages: Array.isArray(args.messages) ? args.messages : cur.messages });
    return { saved: true };
}
export function removeAgentSession(ctx, args = {}) {
    return { deleted: ctx.deleteAgentSession(ctx.db, args.id) };
}

/* ── `POST /api/agent/sessions/:id/compact`：会话压缩（纯截断无损，非 LLM）── */
export function compactAgentSessionOp(ctx, args = {}) {
    const keep = Number(args.keepRecent ?? 20);
    const r = ctx.compactAgentSession(ctx.db, args.id, keep);
    return r ?? null;
}

/* ── `POST /api/agent/sessions/:id/summarize`：上下文摘要（LLM 有损压缩）── */
export async function summarizeAgentSession(ctx, args = {}) {
    const { db, getAgentSession, saveAgentSession, resolveLlmCfg, callLlm } = ctx;
    const keep = Math.min(Math.max(Number(args.keepRecent ?? 6), 1), 50);
    const cur = getAgentSession(db, args.id);
    if (!cur)
        return null;
    const msgs = cur.messages || [];
    if (msgs.length <= keep)
        return { before: msgs.length, after: msgs.length, summaryLen: 0, note: "会话 ≤ keepRecent，无需摘要" };
    const older = msgs.slice(0, msgs.length - keep);
    const recent = msgs.slice(msgs.length - keep);
    let llm;
    try {
        ({ llm } = await resolveLlmCfg());
    }
    catch (e) {
        return { llmConfigError: e instanceof Error ? e.message : String(e) };
    }
    const convo = older.map((m, i) => `${m.role === "user" ? "用户" : "助手"}: ${String(m.content ?? "").slice(0, 1500)}`).join("\n");
    try {
        const { msg } = await callLlm(llm, [
            { role: "user", content: `把以下对话压缩成一段 ≤500 字的摘要，保留关键结论、决定、数字与待办，去掉寒暄与过程。只输出摘要正文。\n\n${convo}` },
        ], null, undefined, false);
        const summary = String(msg?.content ?? "").trim();
        if (!summary)
            return { llmEmpty: true };
        const newMsgs = [{ role: "user", content: `【早期对话摘要】${summary}` }, ...recent];
        saveAgentSession(db, { sessionKey: args.id, title: cur.title, messages: newMsgs });
        return { before: msgs.length, after: newMsgs.length, summaryLen: summary.length, kept: keep };
    }
    catch (e) {
        return { summarizeFailed: e instanceof Error ? e.message : String(e) };
    }
}

/* ── `GET /api/artifacts/:id`：artifact 下载（只读；basename 白名单 + realpath 边界校验防越界）── */
export async function readArtifactFile(ctx, args = {}) {
    const name = String(args.name || "").slice(0, 200);
    const dataDir = ctx.dataDirOf() || "";
    const abs = path.join(dataDir, "artifacts", name);
    try {
        const real = await fs.promises.realpath(abs);
        const root = await fs.promises.realpath(path.join(dataDir, "artifacts"));
        if (real !== root && !real.startsWith(root + path.sep))
            return { escaped: true };
        const buf = await fs.promises.readFile(real);
        return { buffer: buf, name };
    }
    catch {
        return null;   // 不存在 / 读取失败（404 由传输层映射）
    }
}

/* ── `POST /api/agent/mcp/restart`：close 现有句柄 + reset + 惰性重 spawn（进程生命周期经 ctx 注入）── */
export async function restartAgentMcp(ctx) {
    const { getAgentMcp, resetAgentMcp } = ctx;
    try {
        const prev = await getAgentMcp().catch(() => null);
        try { await prev?.close(); } catch { /* 已坏/未起 */ }
        resetAgentMcp();
        const fresh = await getAgentMcp();
        const tools = (await fresh.tools()).length;
        return { restarted: true, toolCount: tools };
    }
    catch (e) {
        resetAgentMcp();
        return { restartFailed: e instanceof Error ? e.message : String(e) };
    }
}

/* ── `POST /api/agent/plan/decompose`：自动拆解（LLM planner；纯推理不写库）── */
export async function decomposePlan(ctx, args = {}) {
    const { resolveLlmCfg, callLlm } = ctx;
    const b = args ?? {};
    const goal = String(b.goal ?? "").trim();
    const maxSub = Math.min(Math.max(Number(b.maxSubtasks) || 5, 1), 10);
    let llm;
    try {
        ({ llm } = await resolveLlmCfg());
    }
    catch (e) {
        return { llmConfigError: e instanceof Error ? e.message : String(e) };
    }
    const prompt = [
        `把下面的目标拆解成 ${maxSub} 条以内、可独立派发给 agent 执行的子任务。`,
        `要求：每条一行、以「- 」开头、动词开头、可验收（有明确产出物）；按依赖顺序排列；不重复、不空泛。`,
        `只输出子任务列表，不要解释。`,
        ``,
        `目标：${goal}`,
    ].join("\n");
    try {
        const { msg } = await callLlm(llm, [{ role: "user", content: prompt }], null, undefined, false);
        const plan = String(msg?.content ?? "").trim();
        if (!plan)
            return { llmEmpty: true };
        const subtasks = plan.split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean).slice(0, maxSub + 2);
        return { goal: goal.slice(0, 200), plan, subtasks, llm: { model: llm.model } };
    }
    catch (e) {
        return { decomposeFailed: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * `POST /api/cards/:id/complete-deps`：任务卡被依赖拦着派不出去时，LLM 读目标 + 未完成依赖，
 * 给出「可判定满足的前置」(complete) 与「尚缺的前置子任务」(create)；副作用见原注释（置 done + 建卡连线）。
 * ★ RESTRICTED 门禁（restricted(reply,"cardCreate")）留在传输层；本函数在**已过门禁**的入参上执行。
 * @returns 卡片不存在 → `null`；无未完成依赖 → `{ id, completed:[], created:[], remaining:[], note }`；
 *          成功 → `{ id, completed, created, remaining, readyToDispatch, llm }`
 * ctx 最小集：`{ db, resolveLlmCfg, callLlm }`
 */
export async function completeCardDeps(ctx, args = {}) {
    const { db, resolveLlmCfg, callLlm } = ctx;
    const id = Number(args.id);
    const main = db.prepare(`SELECT id, title, body, status FROM cards WHERE id=?`).get(id);
    if (!main)
        return null;
    // 主卡未完成的前置依赖（card→card depends，src=主卡，dst=前置；done/archived 视为已满足）
    const deps = db
        .prepare(`SELECT l.dst_id d, c.status s, c.title t, c.kind k FROM links l JOIN cards c ON c.id=l.dst_id
                  WHERE l.src_kind='card' AND l.src_id=? AND l.dst_kind='card' AND l.kind='depends'`)
        .all(id);
    const pending = deps.filter(d => !['done', 'archived'].includes(String(d.s)));
    if (!pending.length)
        return { id, completed: [], created: [], remaining: [], note: "没有未完成的依赖，可直接派发" };
    let llm;
    try {
        ({ llm } = await resolveLlmCfg());
    }
    catch (e) {
        return { llmConfigError: e instanceof Error ? e.message : String(e) };
    }
    // ★ 收窄：只有「task 类」依赖卡可被 LLM 判定补全（置 done）；智能体/交接/辅助类卡不能靠补全完成，
    //   它们该由对应动作处置（如给智能体卡派活）。非 task 依赖即使 LLM 列出也一律忽略。
    const completableIds = new Set(pending.filter(d => String(d.k) === "task").map(d => Number(d.d)));
    const goal = `${String(main.title || "").trim()}\n${String(main.body || "").trim()}`.trim();
    const prompt = [
        "你是任务调度助手。下面是一张待派发的任务卡，以及它当前「未完成」的前置依赖卡。",
        "请给出补全方案，严格输出 JSON（不要解释、不要 markdown 代码块）：",
        `{ "complete": [ {"id": 数字, "note": "一句话判定理由"} ], "create": [ {"title": "新前置子任务", "body": "产出物说明"} ] }`,
        "规则：",
        "- complete：只从标注了「可补全」的依赖里挑出「此刻可判定为前置已满足」的填 id；不可补全的依赖（智能体/交接/辅助卡）不要填，改在 create 里给出它们对应的前置任务；没有就留空数组 []。",
        "- create：目标还需要、但目前没有对应卡片的前置步骤，最多 3 条，可验收；没有就留空数组 []。",
        "",
        `任务目标：${goal.slice(0, 2000)}`,
        "未完成依赖：",
        ...pending.map(d => `- id=${d.d} 「${String(d.t || "").slice(0, 40)}」 状态=${d.s} ${completableIds.has(Number(d.d)) ? "" : "（不可补全：" + d.k + " 类）"}`),
        "只输出 JSON。",
    ].join("\n");
    let plan;
    try {
        const { msg } = await callLlm(llm, [{ role: "user", content: prompt }], null, undefined, false);
        const raw = String(msg?.content ?? "").trim();
        const m = raw.match(/\{[\s\S]*\}/);
        plan = m ? JSON.parse(m[0]) : {};
        if (typeof plan !== "object" || plan === null) plan = {};
    }
    catch (e) {
        return { llmFail: e instanceof Error ? e.message : String(e) };
    }
    const now = () => new Date().toISOString();
    const evt = (cid, action, from, to, detail) => db
        .prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
        .run(cid, "human:dashboard", action, from ?? null, to ?? null, detail ?? null);
    const pendingIds = new Set(pending.map(d => Number(d.d)));
    const completed = [];
    for (const item of Array.isArray(plan.complete) ? plan.complete : []) {
        const cid = Number(item?.id);
        if (!cid || !pendingIds.has(cid) || !completableIds.has(cid))
            continue; // ★ 非 task 类依赖卡（智能体/交接/辅助）不靠补全置 done
        const cur = db.prepare(`SELECT status FROM cards WHERE id=?`).get(cid)?.status;
        if (!['done', 'archived'].includes(String(cur))) {
            db.prepare(`UPDATE cards SET status='done', updated_at=? WHERE id=?`).run(now(), cid);
            evt(cid, "status_changed", cur, "done", "LLM 补全依赖：判定前置已满足 → done（" + String(item?.note || "").slice(0, 80) + "）");
            completed.push(cid);
        }
    }
    const created = [];
    for (const item of Array.isArray(plan.create) ? plan.create : []) {
        const title = String(item?.title ?? "").trim().slice(0, 120);
        if (!title)
            continue;
        // ★ 根治（2026-10-06）：按标题去重 —— 重复点「补全依赖」不再无限建卡：
        //   已有同名 task 卡（含归档）→ 直接复用，未连线才补连线。
        let nid;
        const exist = db.prepare(`SELECT id, status FROM cards WHERE kind='task' AND title=? ORDER BY id LIMIT 1`).get(title);
        if (exist) {
            nid = Number(exist.id);
            if (!['done', 'archived'].includes(String(exist.status))) {
                db.prepare(`UPDATE cards SET status='done', updated_at=? WHERE id=?`).run(now(), nid);
                evt(nid, "status_changed", exist.status, "done", "LLM 补全依赖：复用既有前置卡 → done");
            }
        }
        else {
            const ins = db.prepare(`INSERT INTO cards(board,kind,title,body,status,meta) VALUES ('default','task',?,?,'done',?)`)
                .run(title, String(item?.body ?? "").trim() || null, JSON.stringify({ completed_by: "complete-deps" }));
            nid = Number(ins.lastInsertRowid);
            evt(nid, "create", null, "done", "LLM 补全依赖：新建前置子任务并连线");
        }
        const linked = db.prepare(`SELECT 1 x FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id=? AND kind='depends'`).get(id, nid);
        if (!linked)
            db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind) VALUES (NULL,'card',?,'card',?,'depends')`).run(id, nid);
        created.push(nid);
    }
    // 复查仍有多少依赖未完成（排除刚置 done 的 + 刚建的 done）；带 kind 供前端区分「可补全/死线」
    const remaining = db
        .prepare(`SELECT l.dst_id d, c.title t, c.kind k FROM links l JOIN cards c ON c.id=l.dst_id
                  WHERE l.src_kind='card' AND l.src_id=? AND l.dst_kind='card' AND l.kind='depends'
                    AND c.status NOT IN ('done','archived')`)
        .all(id)
        .map(r => ({ id: Number(r.d), title: String(r.t || ""), kind: String(r.k || "task") }));
    return {
        id,
        completed,
        created,
        remaining,
        readyToDispatch: remaining.length === 0,
        llm: { model: llm.model },
    };
}
