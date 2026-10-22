#!/usr/bin/env node
/**
 * MemoryOS — 架构重构第 2 条「统一操作注册表」· 批次 B 验收探针（task 域接线）
 *
 * 本批把 task 域的**领域计算**收进 ops-registry，MCP `task_next` 与 REST `POST /api/task` 只做薄适配。
 * 承诺是「行为零漂移」——这不能靠读代码证明，必须**真跑两条传输、逐字节比对改前/改后产物**。
 *
 * 覆盖：
 *  ⑧-b 核心：temp 库造 ≥5 条任务记忆（不同状态 / [depends:a,b] / → 结论(x)：/ 被卡住 / 不同 assignee），
 *        用**同一参数**（含 as 身份）经 MCP 调 `task_next`，输出逐字节（sha256 + 原文）与**基线**一致；
 *        并给出**非空数据证据**（含 `#` 的条目数 ≥3；空库两边都空 = 假绿的对照组排除了这种可能）。
 *  POST /api/task：隔离实例 + 同输入 → 响应体 sha256 与基线一致。
 *  --list-tools：25 项（2026-10-19 工具面整合后口径）且 `##TOOLS##` 行 sha256 与基线一致。
 *  注册表不变量：MCP 传输 op 的 risk.source 必须前缀 `TOOL_RISK.`；REST-only op 必须显式声明
 *    （source 含 `REST-only`）；重复注册 throw；invokeOp 对 handler===null 显式报错。
 *
 *  ★ 批次 D1（2026-10-15）追加 —— knowledge 域 7 条 REST 路由（op `notes.*` / `runbook.read`）：
 *    隔离实例 + 临时库造**非空夹具**（≥2 条 note + 3 条 links〔含 1 条未解析〕+ daemon_log / exec_audit 各 ≥1），
 *    按**固定入参与固定顺序**请求这 7 条路由（`GET /api/notes` 兼作列表与 `?id=` 详情 → 共 8 次探针），
 *    每条记录 status + body sha256 与基线逐字节比对；并给出**非空证据**（各响应体条数）——
 *    排除「空库两边都空」的假绿。
 *    归一：本机绝对路径（run 私有 temp 目录）与 ISO/SQLite 时间戳属**运行态易变值**，按仓内既有快照口径占位
 *    （见 normBody），不参与逐字节比对；其余字段/键序/状态码全部原样比对。
 *    注册表不变量追加：knowledge op 全部 REST-only 显式声明 + handler 非 null + REST 传输声明与路由一致。
 *
 *  ★ 批次 D2a（2026-10-15）追加 —— Agent 域只读 + 简单配置写 / 导出 10 条 REST 路由
 *    （op `agent.*` / `export.*`）：
 *    隔离实例 + 临时库造**非空夹具**（≥2 条 agent 会话 + ≥1 条 exec_audit 行 + ≥1 条 memory；run 经
 *    `POST /api/agent/runs` **真建 1 条**），按**固定入参与固定顺序**请求这 10 条路由，每条记录
 *    status + body sha256 与基线逐字节比对；并给出**非空证据**（各响应体条数），排除「空库两边都空」的假绿。
 *    归一（分两层，如实声明它抓不到什么）：
 *      ① `normBody`（沿用）：本机绝对路径（temp 目录）与 ISO / SQLite 时间戳占位；
 *      ② `maskAgent`（本批新增，仅作用于 `agent.runs.list` / `agent.runs.read` 两条探针）：内存 run 的
 *         **运行态易变值**占位 —— runId/sessionId（`r_<base36>_<n>_<hex4>` 形态）、startedAt/finishedAt/queuedAt
 *         （epoch 毫秒）、事件 t / seq、elapsedMs。
 *         ★ **它抓不到的差异**（如实声明）：因 runId 被占位 → 「两端 runId 是否同形/是否串号」不再可比对；
 *         因 startedAt/finishedAt/t/seq/elapsedMs 被占位 → 「耗时/时序/事件序号漂移」不再可比对。
 *         其余字段（status/steps/answer/error/usage/estimatedTokens/events 的 event+data、total/toolCount、
 *         agents/notes/rows 全量内容）**全部原样比对**。
 *    注册表不变量追加：agent/export op 全部 REST-only 显式声明 + handler 非 null + REST 传输声明与路由一致 + kind 区分。
 *
 *  ★ 批次 D2b（2026-10-15）追加 —— Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛 17 条 REST 路由
 *    （op `agent.chat` / `agent.runs.*` / `agent.steps.*` / `agent.sessions.*` / `agent.artifacts.read` /
 *     `agent.mcp.restart` / `plan.decompose` / `cards.completeDeps`）：
 *    两隔离实例分层验收（详见文件内 D2b 段落注释）：
 *     A（死端口 LLM http://127.0.0.1:1/v1）—— LLM 路由(chat/plan.decompose/sessions.summarize)走**确定性失败
 *       路径**逐字节比对；sessions CRUD / compact / mcp.restart 逐字节比对。
 *     B（本地 mock LLM，本进程内起、脚本固定）—— `POST /api/agent/runs` **真跑**（真 MCP file_write/file_read
 *       → 真步骤 + 真写前快照），据此比对 chain / steps.output / rollback / approval / artifacts / abort /
 *       completeDeps 的响应，并断言**副作用**（会话消息 1→3、rollback 写回、依赖卡置 done + 建新前置卡）。
 *    SSE（/runs/:id/stream）：**做不到逐字节**（id/seq/t/runId 天然易变）→ 结构化断言（事件名序列 + 每事件
 *       data 的 JSON 键集合 + 掩码后逐条载荷与基线一致 + ids 1..N 递增 + 首个事件延迟容差 + 客户端断开清理）。
 *    ★ 如实声明：SSE 证到的是「结构/载荷恒等 + 清理」，**未证到**原始字节恒等。
 *    归一（D2b 专用，不动 D2a 的 maskAgent）：`maskD2b` 掩码 runId/sessionId/epoch 毫秒/seq/t/elapsedMs/
 *    estimatedTokens/rolledBackAt；**抓不到**耗时/时序/序号漂移、runId 同形性、estimatedTokens 数值。
 *
 * 用法：
 *   cd resources/memoryos && node dist/smoke-ops.js --capture   # 改代码**之前**采基线（存 %TEMP%，仓外）
 *   cd resources/memoryos && node dist/smoke-ops.js             # 改代码**之后**比对（`npm test` 走这条）
 *
 * 隔离与清理：全部发生在 mkdtemp 临时目录/临时库内；退出即停全部子进程 + 删临时目录，绝不碰生产库。
 * 基线文件默认 `%TEMP%/memoryos-ops-baseline.json`（可用 `MEMORYOS_OPS_BASELINE` 覆盖）；缺失按 SKIP（缺环境≠代码回归）。
 * 退出码：0 = 无 FAIL（SKIP 不算失败） / 1 = 有 FAIL。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, writeMemory, saveAgentSession, listAgentSessions } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // …/resources/memoryos/dist
const KERNEL = path.resolve(HERE, "..");                     // …/resources/memoryos（冒烟约定 cwd）
const NODE = process.execPath;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-ops-smoke-"));
/** 测试用一次性令牌：本机生成、只经环境变量传递、绝不落盘、绝不打印（非任何真实凭据）。 */
const TOKEN = crypto.randomBytes(16).toString("hex");
const CAPTURE = process.argv.includes("--capture");
const BASELINE = process.env.MEMORYOS_OPS_BASELINE || path.join(os.tmpdir(), "memoryos-ops-baseline.json");
const AGENT = "trae";        // 夹具写入者身份
const AS_ID = "codex";       // task_next 的 as 身份（同一参数，两轮共用）
/* ★ 批次 D1 夹具常量：KB_VAULT = 可写盘的真实 vault（POST /api/notes 用）；
 *   KB_SEED_VAULT = 只落库的 notes 归属 vault（不预置文件 → 避免 mtime 抖进比对，见 collectKnowledge 说明）。 */
const KB_VAULT = path.join(WS, "kb-vault");
const KB_SEED_VAULT = path.join(WS, "kb-seed-vault");
/** 归一：本机绝对路径（每次 run 的私有 temp 目录）与 ISO/SQLite 时间戳属**运行态易变值** → 占位后再比对（口径同 snapshot-routes.js）。 */
const WS_ESC = JSON.stringify(WS).slice(1, -1);   // WS 在 JSON 体内的转义形态（反斜杠加倍）
const normBody = (s) => String(s)
    .split(WS_ESC).join("«ws»").split(WS).join("«ws»").split(WS.replace(/\\/g, "/")).join("«ws»")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "«ts»")
    .replace(/\d{4}-\d{2}-\d{2}/g, "«date»");
/** knowledge 域 op → REST 传输声明的期望值（注册表不变量：登记错路由会被抓出） */
const KB_EXPECT = {
    "notes.list": "GET /api/notes",
    "notes.create": "POST /api/notes",
    "notes.update": "PUT /api/notes/:id",
    "notes.delete": "DELETE /api/notes/:id",
    "notes.backlinks": "GET /api/backlinks",
    "notes.graph": "GET /api/graph",
    "runbook.read": "GET /api/runbook",
};
/** ★ 批次 D2a：agent / export 域 op → REST 传输声明的期望值 */
const AGENT_EXPECT = {
    "agent.list": "GET /api/agents",
    "agent.status": "GET /api/agent/status",
    "agent.runs.list": "GET /api/agent/runs",
    "agent.runs.read": "GET /api/agent/runs/:id",
    "agent.sessions.list": "GET /api/agent/sessions",
    "agent.sessions.read": "GET /api/agent/sessions/:id",
    "export.memories": "GET /api/export/memories",
    "export.audit": "GET /api/export/audit",
    "agent.config.set": "POST /api/agent/config",
    "agent.exec.toggle": "POST /api/agent/exec-toggle",
};
/** ★ 批次 D2a：内存 run 运行态易变值的**对象级**归一（仅用于 agent.runs.list / agent.runs.read 两条探针）。
 *  见文件头「归一抓不到什么」：runId/sessionId、epoch 毫秒时间与 seq 一律占位后不再参与比对。 */
const maskAgent = (v) => {
    if (Array.isArray(v)) return v.map(maskAgent);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            if (/^(runId|sessionId|startedAt|finishedAt|queuedAt|elapsedMs|seq|t)$/.test(k)) { out[k] = "«volatile»"; continue; }
            out[k] = maskAgent(val);
        }
        return out;
    }
    if (typeof v === "string") return v.replace(/r_[0-9a-z]+_\d+_[0-9a-f]{4}/g, "«runid»");
    return v;
};
/** ★ 2026-10-15 修（本文件自身的脆弱断言）：`GET /api/agents` 依 `scanAgents()` **扫本机已装 CLI**
 *  并附带运行态 `load` 计数 ⇒ 把整段 body 逐字节钉死会让"换个时刻/换台机器就红"（本批已实测踩到：
 *  sha256 72d7254d→34ec5e0f，仅因本机扫描结果/load 变化，与本批代码无关）。
 *  故只比对**稳定部分**：agent id 集合（排序后）。`load` 等运行态字段**不参与比对**（归一即弃）。
 *  代价如实：**抓不到** load 数值变化与 id 顺序变化（顺序由本机扫描决定，非接口契约）。 */
const maskAgentList = (v) => ({ agents: (v?.agents ?? []).map((a) => a?.id).filter(Boolean).sort() });

let passed = 0, failed = 0, skipped = 0;
const check = (name, cond, detail = "") => {
    if (cond) { passed++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
};
const skip = (name, detail) => { skipped++; console.log(`SKIP  ${name}${detail ? "  — " + detail : ""}`); };

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/* ── 子进程池（退出统一收；Windows 文件句柄释放有延迟，删目录前要等真退出）── */
const procs = new Set();
const exitWaiters = new Map();
const stop = (child) => {
    if (!child) return;
    procs.delete(child);
    try { child.stdin?.destroy(); } catch { /* 已关 */ }
    try { child.kill(); } catch { /* 已退 */ }
};
async function killAllAndWait(ms = 4_000) {
    const kids = [...new Set([...procs, ...[...exitWaiters.keys()].filter((c) => c.exitCode === null && !c.signalCode)])];
    for (const c of kids) stop(c);
    await Promise.race([Promise.all(kids.map((c) => exitWaiters.get(c) ?? Promise.resolve())), sleep(ms)]);
}
async function removeWs() {
    for (let i = 0; i < 12; i++) {
        try { fs.rmSync(WS, { recursive: true, force: true }); return true; } catch { await sleep(200); }
    }
    console.log(`WARN  临时目录未能删除（进程句柄未释放）：${WS}`);
    return false;
}
process.on("exit", () => { for (const c of [...procs]) stop(c); try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 兜底尽力 */ } });

/** ★ 2026-10-15 修（本文件自身的隔离缺陷·根因）：**每个实例独占自己的 data 目录**。
 *  写配置探针（`agent.config.set` / `agent.exec.toggle`）会把 `execOn` 等落盘到
 *  `MEMORYOS_DATA_DIR/config.json`；若所有实例共用同一目录，后启实例的 MCP 工具面会被
 *  前序实例写下的 `execOn=false` 覆盖（跨实例污染，表现为 tool_face 数 29 而非 32、
 *  步骤 ok:false / rollback 409）。按实例 tag 分目录后实例间彻底隔离 ——
 *  各处不再需要自行手写 dataDir 绕过（原 D2b 的独立目录写法已收敛到本机制）。 */
const instanceDataDir = (tag) => path.join(WS, "data", tag);
function baseEnv(extra = {}, tag = "default") {
    const dataDir = instanceDataDir(tag);
    fs.mkdirSync(dataDir, { recursive: true });
    return {
        ...process.env,
        MEMORYOS_DATA_DIR: dataDir,   // 隔离：core.json/config.json 落**本实例**私有目录（跨实例不泄漏）
        MEMORY_TOKEN: TOKEN,
        MEMORY_AGENT: AGENT,
        MEMORY_AGENT_FPATH: path.join(WS, "agent-fpath.txt"),
        EMBED_MODE: "fake",            // 隔离实例只用假向量（不加载模型）
        MEMORYOS_EXEC_ON: "",
        MEMORYOS_EXEC_OFF: "",
        MEMORYOS_MCP_MODE: "",         // 显式 direct（避免受仓内 config.json 影响）
        MEMORYOS_WORKSPACE: WS,
        ...extra,
    };
}
function start(args, env, tag) {
    const child = spawn(NODE, args, { cwd: KERNEL, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdoutBuf = "";
    child.stderrBuf = "";
    child.on("error", () => { /* 起不来由上层按超时处理 */ });
    for (const [out, key] of [[child.stdout, "stdoutBuf"], [child.stderr, "stderrBuf"]])
        out.on("data", (d) => { child[key] += d.toString(); });
    child.tag = tag ?? path.basename(args[0]);
    procs.add(child);
    exitWaiters.set(child, new Promise((resolve) => child.once("exit", resolve)));
    return child;
}
/** 极简 MCP stdio JSON-RPC 客户端 */
function mcpClient(child) {
    let buf = "";
    let lastId = 0;
    const pending = new Map();
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id && pending.has(msg.id)) {
                const r = pending.get(msg.id);
                pending.delete(msg.id);
                r(msg);
            }
        }
    });
    const send = (method, params) => {
        const id = ++lastId;
        return new Promise((resolve, reject) => {
            pending.set(id, resolve);
            setTimeout(() => { if (pending.delete(id)) reject(new Error(`MCP 调用无响应：${method}`)); }, 60_000);
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
    };
    return { send };
}
async function waitForHealth(port, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-memory-token": TOKEN } });
            if (r.ok) return await r.json();
        }
        catch { /* 未就绪 */ }
        await sleep(300);
    }
    return null;
}
const toolListLine = (buf) => { const m = String(buf).match(/##TOOLS##(\[.*\])/); return m ? m[1] : ""; };

/** 一次性 mock embeddings 端点（OpenAI 兼容形状）——让 dashboard 走 **EMBED_MODE=api**，
 *  从而绕开 `EMBED_MODE=fake` 下 db.js `upsertVector` 的 fail-closed（那条守卫拒绝假向量，会把 POST /api/task 变成 500，
 *  且**与本批重构无关**）。用它可验证 `POST /api/task` 的**成功路径**逐字节一致。 */
async function startMockEmbedder() {
    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
            let input = [];
            try { input = JSON.parse(body).input ?? []; } catch { /* 保底空 */ }
            if (!Array.isArray(input)) input = [input];
            const data = input.map((_, i) => ({ object: "embedding", index: i, embedding: Array(8).fill(0.1) }));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ object: "list", model: "mock-embed", data }));
        });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/v1/embeddings`, close: () => { try { srv.close(); } catch { /* 已关 */ } } };
}

/* ── 夹具：≥5 条任务记忆，覆盖各状态 / 双依赖 / 结论 / 被卡住 / 不同 assignee ── */
function seedTasks(dbPath) {
    const db = openDb(dbPath);
    const mk = (content) => writeMemory(db, { content, type: "task", agent: AGENT, agent_fpath: null, project: "global" });
    const A = mk("[task][assignee:codex][status:pending] 设计任务域接口");
    const B = mk(`[task][assignee:codex][status:pending][depends:${A.id}] 实现接口`);
    const C = mk("[task][assignee:codex][status:in_progress] 进行中的已认领任务");
    const D = mk("[task][assignee:claude][status:done] 已完成任务 → 结论(codex)：接口已实现并通过验收");
    const E = mk("[task][assignee:codex][status:cancelled] 已取消的任务");
    const F = mk("[task][assignee:?][status:pending] 未指派任务");
    const G = mk(`[task][assignee:codex][status:pending][depends:${A.id},${D.id}] 双依赖任务（等 A、D）`);
    const ids = { A: A.id, B: B.id, C: C.id, D: D.id, E: E.id, F: F.id, G: G.id };
    db.close();
    return ids;
}

/* ── 夹具（批次 D1 · knowledge 域）：≥2 条 note + 3 条 links（含 1 条未解析）+ daemon_log/exec_audit 各 ≥1 ──
 *  notes 行挂在 KB_SEED_VAULT（**不预置文件**）→ GET/backlinks/graph 读到的 note 行 mtime_ms 恒为夹具值，
 *  不被 vault 磁盘文件的真实 mtime 抖动污染（PUT 只在 KB_SEED_VAULT 落一个 beta.md，且发生在所有只读探针之后）。 */
function seedKnowledge(dbPath) {
    const db = openDb(dbPath);
    const note = db.prepare(`INSERT INTO notes(vault_root, rel_path, title, aliases, tags, sector, body, hash, memory_id, mtime_ms, origin, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    note.run(KB_SEED_VAULT, "alpha.md", "Alpha note", "[]", '["a"]', "kb", "Alpha note 正文提到 Beta note", "h-alpha", null, 1000, "vault", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    note.run(KB_SEED_VAULT, "beta.md", "Beta note", "[]", '["b"]', "kb", "Beta note 正文提到 Alpha note", "h-beta", null, 2000, "vault", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    const A = Number(db.prepare(`SELECT id FROM notes WHERE rel_path='alpha.md'`).get().id);
    const B = Number(db.prepare(`SELECT id FROM notes WHERE rel_path='beta.md'`).get().id);
    const link = db.prepare(`INSERT INTO links(vault_root, src_kind, src_id, dst_kind, dst_id, dst_title, kind, anchor, alias, context, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    link.run(KB_SEED_VAULT, "note", A, "note", B, null, "references", null, null, "见 [[Beta note]]", "2026-01-03T00:00:00.000Z");
    link.run(KB_SEED_VAULT, "note", B, "note", A, null, "references", null, null, "回指 [[Alpha note]]", "2026-01-03T00:00:00.000Z");
    link.run(KB_SEED_VAULT, "note", B, "note", null, "Ghost note", "mentions", null, null, "[[Ghost note]]", "2026-01-03T00:00:00.000Z");
    db.prepare(`INSERT INTO daemon_log(task, op, detail, operator, memory_id, created_at) VALUES (?,?,?,?,?,?)`)
        .run("decay", "eff_update", "夹具：批次 D1 治理事件", "system:daemon", null, "2026-01-04T00:00:00.000Z");
    db.prepare(`INSERT INTO exec_audit(tool, agent, risk, approval, args_digest, detail, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run("file_write", "smoke", "L1", "gate-denied", "d1-fixture", "夹具：写被门禁拒绝（失败样本）", 0, "2026-01-05T00:00:00.000Z");
    db.close();
    return { A, B };
}

// 本批有意新增的工具面与真实model回执；只升级这些预期字段，不重定其它路由基线。
// ★ 2026-10-19 工具面整合（37→25）：本升级器把旧基线升级到当前口径 ——
//   · 知识批之前（toolCount 29/32）：滤除 18 个被并工具 + 插入 7 个现役名，计数 −4；
//   · 整合之前（toolCount 37/40）：同样滤除+插入，计数 −12；
//   · 当前口径基线（25/28，含 memory_admin）：函数幂等原样返回。sha 级比对（tools/list 行、task_next 文本）
//     无法用升级器弥合 —— 工具面变更后须重跑 --capture 重定基线。
const GONE_FACE_TOOLS=["memory_projects","memory_report","memory_health","memory_quality","memory_work_read","memory_work_write","obsidian_import","obsidian_export","obsidian_write_note","method_generate","method_search","method_read","method_preflight","method_run","method_feedback","task_block","task_reopen","task_verify"];
const NEW_FACE_TOOLS=["memory_admin","memory_work","obsidian","task_admin","memory_evidence","method_query","method_apply"];
function upgradeExpectedKnowledgeSurface(value) {
    if(typeof value === "string") {
        if(!/^[\[{]/.test(value))return value;
        try{const parsed=JSON.parse(value);const upgraded=upgradeExpectedKnowledgeSurface(parsed);return JSON.stringify(parsed)===JSON.stringify(upgraded)?value:JSON.stringify(upgraded);}catch{return value;}
    }
    if(Array.isArray(value)) {
        // 仅升级旧口径（含 memory_write+tool_guide 且**不含** memory_admin）；当前口径基线原样返回（幂等）
        if(value.includes("memory_write")&&value.includes("tool_guide")&&!value.includes("memory_admin")) {
            const result=value.filter(n=>!GONE_FACE_TOOLS.includes(n));result.splice(result.indexOf("tool_guide"),0,...NEW_FACE_TOOLS);return result;
        }
        return value.map(upgradeExpectedKnowledgeSurface);
    }
    if(!value||typeof value!=="object")return value;
    const result=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,upgradeExpectedKnowledgeSurface(v)]));
    if([29,32].includes(value.toolCount))result.toolCount=value.toolCount-4;
    if([37,40].includes(value.toolCount))result.toolCount=value.toolCount-12;
    if(Array.isArray(value.exposed)&&value.exposed.includes("memory_write")&&[29,32].includes(value.total))result.total=value.total-4;
    if(Array.isArray(value.exposed)&&value.exposed.includes("memory_write")&&[37,40].includes(value.total))result.total=value.total-12;
    if(typeof result.line==='string'&&Array.isArray(JSON.parse(result.line))) {result.count=JSON.parse(result.line).length;result.sha256=sha256(result.line);}
    if(value.name==='embed.vectors'&&typeof result.text==='string'){const body=JSON.parse(result.text);body.model='bge-m3';result.text=JSON.stringify(body);}
    if(typeof result.text==='string'&&typeof result.status==='number'&&result.sha256)result.sha256=sha256(`${result.status}\n${result.text}`);
    return result;
}

/* ── 产物采集：三条传输各自算一次，返回可序列化对象（含 sha256）── */
async function collectTaskNext() {
    const dbPath = path.join(WS, "ops-task.db");
    const ids = seedTasks(dbPath);
    const srv = start([path.join(HERE, "server.js")], baseEnv({ MEMORY_DB: dbPath }, "ops-tasknext"), "ops-tasknext");
    const c = mcpClient(srv);
    await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ops-smoke", version: "0.1.0" } });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const msg = await c.send("tools/call", { name: "task_next", arguments: { project: "global", as: AS_ID } });
    stop(srv);
    const text = (msg?.result?.content ?? []).map((x) => x?.text ?? "").join("\n");
    return { ids, text, sha256: sha256(text), itemLines: (text.match(/^#\d+ /gm) ?? []).length };
}
async function collectTaskCreate() {
    const port = await freePort();
    const dbPath = path.join(WS, "ops-taskcreate.db");
    const mock = await startMockEmbedder();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({
        MEMORY_DB: dbPath, MEMORY_PORT: String(port),
        EMBED_MODE: "api", EMBED_API_URL: mock.url, EMBED_API_KEY: "smoke-only-not-a-secret",
    }, "ops-taskcreate"), "ops-taskcreate");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        mock.close();
        return { ok: false, reason: `隔离核心 30s 内未就绪（环境问题）`, text: "", sha256: "" };
    }
    const body = { title: "冒烟任务B", status: "pending", assignee: "codex", depends: [3, 4], summary: "冒烟摘要", project: "global" };
    const r = await fetch(`http://127.0.0.1:${port}/api/task`, {
        method: "POST",
        headers: { "x-memory-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    stop(core);
    mock.close();
    return { ok: true, req: body, statusCode: r.status, text, sha256: sha256(`${r.status}\n${text}`) };
}
async function collectListTools() {
    const dbPath = path.join(WS, "ops-list.db");
    const out = await new Promise((resolve) => {
        const c = spawn(NODE, [path.join(HERE, "server.js"), "--list-tools"], { cwd: KERNEL, env: baseEnv({ MEMORY_DB: dbPath }, "ops-list"), windowsHide: true });
        let o = "", e = "";
        c.stdout.on("data", (d) => o += d);
        c.stderr.on("data", (d) => e += d);
        c.on("close", (code) => resolve({ code, o, e }));
    });
    const line = toolListLine(out.o);
    return { exit: out.code, line, count: JSON.parse(line || "[]").length, sha256: sha256(line) };
}

/* ── ★ 批次 D1：knowledge 域 7 条 REST 路由的产物采集（隔离实例 + 临时库 + 固定入参/固定顺序）──
 *  隔离实例用 EMBED_MODE=fake：/api/notes 的 POST 走 writeNoteToVault，fake 下 emb=null（不写向量表），
 *  既不会命中 upsertVector 的 fail-closed，也不加载 ML 模型（与 POST /api/task 需真向量的处境不同）。 */
async function collectKnowledge() {
    const dbPath = path.join(WS, "ops-knowledge.db");
    const ids = seedKnowledge(dbPath);
    fs.mkdirSync(KB_VAULT, { recursive: true });
    fs.mkdirSync(KB_SEED_VAULT, { recursive: true });   // PUT /api/notes/:id 要写盘 → 父目录必须先存在
    const port = await freePort();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({ MEMORY_DB: dbPath, MEMORY_PORT: String(port) }, "ops-knowledge"), "ops-knowledge");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", ids, probes: [], counts: {} };
    }
    const call = async (name, route, method, url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = normBody(await r.text());
        return { name, route, status: r.status, text, sha256: sha256(`${r.status}\n${text}`) };
    };
    // 只读探针先行（夹具尚未被写操作扰动）→ 再按固定顺序跑写操作
    const probes = [];
    probes.push(await call("notes.graph", "GET /api/graph", "GET", "/api/graph?scope=note&depth=2&focus=&sector="));
    probes.push(await call("notes.backlinks", "GET /api/backlinks", "GET", `/api/backlinks?kind=note&id=${ids.B}`));
    probes.push(await call("notes.list", "GET /api/notes", "GET", "/api/notes"));
    probes.push(await call("notes.one", "GET /api/notes?id=", "GET", `/api/notes?id=${ids.B}`));
    probes.push(await call("runbook.read", "GET /api/runbook", "GET", "/api/runbook"));
    probes.push(await call("notes.create", "POST /api/notes", "POST", "/api/notes", { vault: KB_VAULT, title: "批次D1冒烟笔记", content: "批次D1冒烟笔记正文", type: "experience" }));
    probes.push(await call("notes.update", "PUT /api/notes/:id", "PUT", `/api/notes/${ids.B}`, { content: "批次D1冒烟笔记更新正文", type: "pitfall" }));
    probes.push(await call("notes.delete", "DELETE /api/notes/:id", "DELETE", `/api/notes/${ids.A}`));
    stop(core);
    const json = (n) => { try { return JSON.parse(probes.find((p) => p.name === n)?.text ?? ""); } catch { return {}; } };
    const g = json("notes.graph"), bl = json("notes.backlinks"), nl = json("notes.list"), rb = json("runbook.read");
    const counts = {
        notesList: (nl.notes ?? []).length,
        blinked: (bl.linked ?? []).length, boutgoing: (bl.outgoing ?? []).length,
        bunresolved: (bl.unresolved ?? []).length, bunlinked: (bl.unlinked ?? []).length,
        gnodes: (g.nodes ?? []).length, gedges: (g.edges ?? []).length,
        rdaemon: (rb.recentDaemon ?? []).length, rexec: (rb.recentExec ?? []).length,
    };
    return { ok: true, ids, probes, counts };
}

/* ── ★ 批次 D2a 夹具：≥2 条 agent 会话（固定 session_key + 固定 updated_at/created_at → 列表/详情确定性）
 *  + ≥1 条 memory（导出记忆非空）+ ≥1 条 exec_audit 行（固定 created_at → 导出审计确定性）。 */
function seedAgent(dbPath) {
    const db = openDb(dbPath);
    saveAgentSession(db, { sessionKey: "smoke-sess-a", title: "冒烟会话 A", messages: [{ role: "user", content: "A 问" }, { role: "assistant", content: "A 答" }] });
    saveAgentSession(db, { sessionKey: "smoke-sess-b", title: "冒烟会话 B", messages: [{ role: "user", content: "B 问" }] });
    const setTs = db.prepare(`UPDATE agent_sessions SET created_at=?, updated_at=? WHERE session_key=?`);
    setTs.run("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:01.000Z", "smoke-sess-a");
    setTs.run("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:02.000Z", "smoke-sess-b");
    const m = writeMemory(db, { content: "批次 D2a 冒烟夹具记忆：agent 域只读导出非空样例", type: "experience", agent: AGENT, agent_fpath: null, project: "global" });
    db.prepare(`INSERT INTO exec_audit(tool, agent, risk, approval, args_digest, detail, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run("file_write", "smoke", "L1", "gate-denied", "d2a-fixture", "夹具：批次 D2a 审计样例（导出非空）", 0, "2026-01-06T00:00:00.000Z");
    db.close();
    return { memoryId: m.id, sessions: ["smoke-sess-a", "smoke-sess-b"] };
}

/* ── ★ 批次 D2a：Agent 域 10 条 REST 路由的产物采集（隔离实例 + 临时库 + 固定入参/固定顺序）──
 *  LLM 端点指向**永不监听的 :1 端口** → `POST /api/agent/runs` 建的 run 必然首轮 LLM 调用失败（确定性 "fetch failed"），
 *  避免本机 Ollama / mimo-proxy 在线时返回非确定性答案污染逐字节比对。 */
async function collectAgent() {
    const dbPath = path.join(WS, "ops-agent.db");
    const seeded = seedAgent(dbPath);
    const port = await freePort();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({
        MEMORY_DB: dbPath, MEMORY_PORT: String(port),
        LLM_BASE_URL: "http://127.0.0.1:1/v1", LLM_MODEL: "smoke-fixed", LLM_API_KEY: "", INGEST_KEY: "",
    }, "ops-agent"), "ops-agent");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", seeded, probes: [], counts: {} };
    }
    const authHeaders = (body) => ({ "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) });
    const request = async (method, url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method, headers: authHeaders(body), body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
    };
    const call = async (name, route, method, url, body, mask) => {
        const res = await request(method, url, body);
        const applyMask = typeof mask === "function" ? mask : mask ? maskAgent : null;
        const text = applyMask
            ? (() => { try { return JSON.stringify(applyMask(JSON.parse(res.text))); } catch { return normBody(res.text); } })()
            : normBody(res.text);
        return { name, route, status: res.status, text, sha256: sha256(`${res.status}\n${text}`) };
    };
    /** 建 1 条 run（固定 message）并等它到终态（LLM 死端口 → 首轮失败；withLlmRetry 1.5s+3s 退避 → 预留 ~30s） */
    const createRunAndWait = async () => {
        const r = await request("POST", "/api/agent/runs", { message: "冒烟探针：请只回复 ok" });
        let runId = null;
        try { runId = JSON.parse(r.text)?.runId; } catch { /* 非 202 */ }
        if (!runId) return null;
        for (let i = 0; i < 120; i++) {
            await sleep(300);
            const g = await request("GET", `/api/agent/runs/${runId}`);
            let st = null;
            try { st = JSON.parse(g.text)?.status; } catch { /* 尚不可读 */ }
            if (st && st !== "running" && st !== "queued") return runId;
        }
        return runId;
    };
    // 只读探针先行（尚未建 run → status 的 running/queued 恒 0，确定性）
    const probes = [];
    probes.push(await call("agent.list", "GET /api/agents", "GET", "/api/agents", undefined, maskAgentList));
    probes.push(await call("agent.status", "GET /api/agent/status", "GET", "/api/agent/status"));
    probes.push(await call("agent.sessions.list", "GET /api/agent/sessions", "GET", "/api/agent/sessions"));
    probes.push(await call("agent.sessions.read", "GET /api/agent/sessions/:id", "GET", `/api/agent/sessions/${seeded.sessions[0]}`));
    probes.push(await call("export.memories", "GET /api/export/memories", "GET", "/api/export/memories?limit=20"));
    probes.push(await call("export.audit", "GET /api/export/audit", "GET", "/api/export/audit?limit=20"));
    // 配置写（固定入参）→ 随即恢复原状（不记录，隔离实例退出前不留脏状态）
    probes.push(await call("agent.config.set", "POST /api/agent/config", "POST", "/api/agent/config", { cache: true, budgetTokens: 1234, maxConcurrent: 2, logLevel: "warn" }));
    await request("POST", "/api/agent/config", { cache: false, budgetTokens: 0, maxConcurrent: 3, logLevel: "info" });
    // 真建 1 条 run → 等终态 → 探 runs（两条用 maskAgent 归一运行态易变值）
    const runId = await createRunAndWait();
    probes.push(await call("agent.runs.list", "GET /api/agent/runs", "GET", "/api/agent/runs", undefined, true));
    probes.push(await call("agent.runs.read", "GET /api/agent/runs/:id", "GET", `/api/agent/runs/${runId ?? "missing"}`, undefined, true));
    // 执行面开关（末位：会重 spawn MCP）→ 随即恢复 on=false（不记录）
    probes.push(await call("agent.exec.toggle", "POST /api/agent/exec-toggle", "POST", "/api/agent/exec-toggle", { on: true }));
    await request("POST", "/api/agent/exec-toggle", { on: false });
    stop(core);
    const json = (n) => { try { return JSON.parse(probes.find((p) => p.name === n)?.text ?? ""); } catch { return {}; } };
    const al = json("agent.list"), sl = json("agent.sessions.list"), rl = json("agent.runs.list");
    const ex1 = json("export.memories"), ex2 = json("export.audit"), rt = json("agent.runs.read");
    const counts = {
        agentList: (al.agents ?? []).length,
        sessions: (sl.sessions ?? []).length,
        runs: rl.total ?? (rl.runs ?? []).length,
        runStatus: rt.status ?? null,
        exportMemories: ex1.count ?? (ex1.rows ?? []).length,
        exportAudit: ex2.count ?? (ex2.rows ?? []).length,
    };
    return { ok: true, seeded, runId: runId ?? null, probes, counts };
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 批次 D2b（2026-10-15）追加 —— Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛（17 条）
 *
 *  两个隔离实例（各自独立库/端口，互不扰动）：
 *   A = **死端口 LLM**（http://127.0.0.1:1/v1）：LLM 路由（chat / plan.decompose / sessions.summarize）
 *       走**确定性失败路径**逐字节比对；sessions CRUD / compact / mcp.restart（非 LLM）亦逐字节比对。
 *       ★ 不用本机 Ollama/mimo-proxy：那会拿到随机答案，基线必然腐烂。
 *   B = **本地 mock LLM**（OpenAI 兼容；本进程内起，脚本固定）：让 `POST /api/agent/runs` **真跑**——
 *       真 MCP 工具（file_write/file_read）→ 真步骤/真写前快照 → 供 chain / steps.output / rollback /
 *       approval / artifacts / abort 探针拿到**非空**夹具；mock 亦按 prompt 返回固定的 plan/summary/
 *       complete-deps JSON，使 completeDeps 的判定与副作用确定。
 *       ★ mock 是**我们自己的固定脚本服务器**（非外部端点），其确定性由「两轮跑一致」自证。
 *
 *  归一（分两层，如实声明它抓不到什么）：
 *   ① `normBody`（沿用）：本机绝对路径（temp 目录）与 ISO/SQLite 时间戳占位；
 *   ② `maskD2b`：运行态易变值占位 —— runId/sessionId（`r_<base36>_<n>_<hex4>`）、起点/终点 epoch 毫秒、
 *      事件 seq/t、elapsedMs、estimatedTokens（依消息体字符数 → 随 temp 路径长度浮动）、rolledBackAt。
 *      ★ **抓不到**：耗时/时序/序号漂移；runId 同形性；estimatedTokens 数值。
 *   ③ SSE **做不了逐字节**（id/seq/t/runId 天然易变）→ 结构化断言：事件名序列 + 每事件 data 的 **JSON 键集合**
 *      + 归一化载荷（掩码后逐条 JSON 串）与基线一致；并单列「首个事件是否在容差内到达」「客户端断开后
 *      服务端清理（进程内订阅计数）」。★ 本条如实声明：证到的是**结构/载荷恒等 + 清理**，**未证到**原始字节恒等。
 * ══════════════════════════════════════════════════════════════════════ */

/** ★ 批次 D2b：17 条 op → REST 传输声明的期望值（注册表不变量：登记错路由会被抓出） */
const D2B_EXPECT = {
    "agent.chat": "POST /api/agent/chat",
    "agent.runs.create": "POST /api/agent/runs",
    "agent.runs.stream": "GET /api/agent/runs/:id/stream",
    "agent.runs.abort": "POST /api/agent/runs/:id/abort",
    "agent.runs.chain": "GET /api/agent/runs/:id/chain",
    "agent.steps.rollback": "POST /api/agent/runs/:id/steps/:sid/rollback",
    "agent.steps.output": "GET /api/agent/runs/:id/steps/:sid/output",
    "agent.steps.approval": "POST /api/agent/runs/:id/steps/:sid/approval",
    "agent.sessions.create": "POST /api/agent/sessions",
    "agent.sessions.update": "PUT /api/agent/sessions/:id",
    "agent.sessions.delete": "DELETE /api/agent/sessions/:id",
    "agent.sessions.compact": "POST /api/agent/sessions/:id/compact",
    "agent.sessions.summarize": "POST /api/agent/sessions/:id/summarize",
    "agent.artifacts.read": "GET /api/artifacts/:id",
    "agent.mcp.restart": "POST /api/agent/mcp/restart",
    "plan.decompose": "POST /api/agent/plan/decompose",
    "cards.completeDeps": "POST /api/cards/:id/complete-deps",
};
/** ★ 批次 D2b：非 agent 域的登记口径（其余 15 条 domain=agent） */
const D2B_DOMAIN = { "plan.decompose": "plan", "cards.completeDeps": "task" };
/** ★ 批次 D2b：运行态易变值掩码（仅 D2b 探针用；不动 D2a 的 maskAgent） */
const maskD2b = (v) => {
    if (Array.isArray(v)) return v.map(maskD2b);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            if (/^(runId|sessionId|startedAt|finishedAt|queuedAt|startMs|endMs|ms|elapsedMs|seq|t|estimatedTokens|rolledBackAt)$/.test(k)) { out[k] = "«volatile»"; continue; }
            out[k] = maskD2b(val);
        }
        return out;
    }
    if (typeof v === "string") return v.replace(/r_[0-9a-z]+_\d+_[0-9a-f]{4}/g, "«runid»");
    return v;
};
/** 归一 + 掩码：先 normBody 归一绝对路径/时间戳，再对 JSON 体按键掩码运行态易变值（非 JSON 体原样归一）。 */
const maskD2bText = (text) => {
    const t = normBody(text);
    try { return JSON.stringify(maskD2b(JSON.parse(t))); } catch { return t; }
};

/** ★ 批次 D2b：本地 mock LLM（OpenAI 兼容 /chat/completions；支持 stream 与非 stream）。
 *  脚本（按 #assistant 轮数，仅当本轮带 tools=agent 循环）：turn0 → file_write；turn1 → file_read；turn2 → 纯文本。
 *  非 agent 调用（无 tools）按 prompt 特征返回固定 plan/summary/complete-deps 结果。
 *  标记：D2BSLOW → 首轮延迟 4s（供 abort 探针拿 running 态）；D2BSSELIVE → 首轮延迟 1.2s（供 SSE 实时探针）。 */
function startMockLlm({ completeDepsDepId }) {
    const mkCall = (name, args) => ({ index: 0, id: `call_d2b_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
            let p = {};
            try { p = JSON.parse(body); } catch { /* 保底空 */ }
            const messages = Array.isArray(p.messages) ? p.messages : [];
            const joined = messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");
            const hasTools = Array.isArray(p.tools) && p.tools.length > 0;
            const turns = messages.filter((m) => m.role === "assistant").length;
            const delay = /D2BSLOW/.test(joined) ? 4000 : /D2BSSELIVE/.test(joined) ? 1200 : 0;
            const text = (s) => /把下面的目标拆解成/.test(s) ? "- 子任务甲：产出甲\n- 子任务乙：产出乙"
                : /任务调度助手/.test(s) ? JSON.stringify({ complete: [{ id: completeDepsDepId, note: "D2B 判定前置已满足" }], create: [{ title: "D2B 新前置子任务", body: "产出物说明" }] })
                    : /把以下对话压缩成/.test(s) ? "D2B 冒烟摘要正文"
                        : "冒烟 run：完成";
            const send = () => {
                try {
                    if (p.stream) {
                        res.writeHead(200, { "content-type": "text/event-stream" });
                        const chunks = [];
                        if (hasTools && turns < 2) {
                            const tc = turns === 0 ? mkCall("file_write", { path: "d2b-target.txt", content: "v2" }) : mkCall("file_read", { path: "d2b-read.txt" });
                            chunks.push({ choices: [{ delta: { role: "assistant", tool_calls: [tc] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
                        }
                        else
                            chunks.push({ choices: [{ delta: { role: "assistant", content: hasTools ? "冒烟 run：完成" : text(joined) } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
                        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
                        res.write("data: [DONE]\n\n");
                        res.end();
                    }
                    else {
                        res.writeHead(200, { "content-type": "application/json" });
                        const m = hasTools && turns < 2
                            ? { role: "assistant", content: null, tool_calls: [turns === 0 ? mkCall("file_write", { path: "d2b-target.txt", content: "v2" }) : mkCall("file_read", { path: "d2b-read.txt" })] }
                            : { role: "assistant", content: hasTools ? "冒烟 run：完成" : text(joined) };
                        res.end(JSON.stringify({ choices: [{ message: m }] }));
                    }
                }
                catch { /* 客户端已断（abort/超时）→ 静默 */ }
            };
            if (delay) setTimeout(send, delay); else send();
        });
    });
    return new Promise((resolve) => {
        srv.listen(0, "127.0.0.1", () => resolve({
            url: `http://127.0.0.1:${srv.address().port}/v1`,
            close: () => { try { srv.closeAllConnections?.(); srv.close(); } catch { /* 已关 */ } },
        }));
    });
}

/* ── ★ 批次 D2b 夹具 A（死端口 LLM 实例）：≥2 会话；其中 1 条 ≥8 条消息（summarize 触发 LLM 分支） ── */
function seedD2bSessions(dbPath) {
    const db = openDb(dbPath);
    saveAgentSession(db, { sessionKey: "d2b-sess-a", title: "D2B 会话 A", messages: [{ role: "user", content: "A 问 1" }, { role: "assistant", content: "A 答 1" }] });
    saveAgentSession(db, { sessionKey: "d2b-sess-b", title: "D2B 会话 B", messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `B 消息 ${i + 1}` })) });
    const setTs = db.prepare(`UPDATE agent_sessions SET created_at=?, updated_at=? WHERE session_key=?`);
    setTs.run("2026-02-01T00:00:01.000Z", "2026-02-01T00:00:01.000Z", "d2b-sess-a");
    setTs.run("2026-02-01T00:00:02.000Z", "2026-02-01T00:00:02.000Z", "d2b-sess-b");
    db.close();
    return { sessions: ["d2b-sess-a", "d2b-sess-b"] };
}

/* ── ★ 批次 D2b 夹具 B（mock LLM 实例）：会话 + 卡片依赖图（1 主卡 ← depends ← 1 前置 task 卡）── */
function seedD2bRun(dbPath) {
    const db = openDb(dbPath);
    saveAgentSession(db, { sessionKey: "d2b-run-sess", title: "D2B run 会话", messages: [{ role: "user", content: "run 会话起始" }] });
    db.prepare(`UPDATE agent_sessions SET created_at=?, updated_at=? WHERE session_key=?`)
        .run("2026-02-02T00:00:01.000Z", "2026-02-02T00:00:01.000Z", "d2b-run-sess");
    const ins = db.prepare(`INSERT INTO cards(board,kind,title,body,status,meta) VALUES ('default','task',?,?,?,?)`);
    const main = Number(ins.run("D2B 主卡", "主卡产出物说明", "ready", null).lastInsertRowid);
    const dep = Number(ins.run("D2B 前置依赖卡", "前置产出物说明", "pending", null).lastInsertRowid);
    db.prepare(`INSERT INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind) VALUES (NULL,'card',?,'card',?,'depends')`).run(main, dep);
    db.close();
    return { mainCard: main, depCard: dep, session: "d2b-run-sess" };
}

/** 极简 SSE 读取：连 /runs/:id/stream 读到**流自然结束**（终态 run 会 reply.raw.end()）→ 原始文本。 */
async function readSseToEnd(port, runId, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/agent/runs/${runId}/stream`, { headers: { "x-memory-token": TOKEN }, signal: ctrl.signal });
        return { status: r.status, contentType: String(r.headers.get("content-type") ?? ""), text: await r.text() };
    }
    finally { clearTimeout(t); }
}
/** 解析 SSE 为事件数组（`id:`/`event:`/`data:` 三行一组；`: 注释行` 无 event → 跳过）。 */
function parseSse(text) {
    const out = [];
    for (const block of String(text).split("\n\n")) {
        const ev = {};
        for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) ev.id = line.slice(4);
            else if (line.startsWith("event: ")) ev.event = line.slice(7);
            else if (line.startsWith("data: ")) ev.data = line.slice(6);
        }
        if (ev.event) out.push(ev);
    }
    return out;
}
/** SSE 归一：{ contentType, ids, names, keys（事件名 + data 键集合）, payloads（掩码后逐条 JSON） } */
function normSse(sse) {
    const evs = parseSse(sse.text);
    return {
        status: sse.status,
        contentType: sse.contentType,
        ids: evs.map((e) => Number(e.id)),
        names: evs.map((e) => e.event),
        keys: evs.map((e) => ({ event: e.event, keys: Object.keys(JSON.parse(normBody(e.data))).sort() })),
        payloads: evs.map((e) => ({ event: e.event, data: maskD2bText(e.data) })),
    };
}

/* ── ★ 批次 D2b-A：死端口 LLM 实例（LLM 路由失败路径 + 非 LLM 路由逐字节）── */
async function collectD2bLlm() {
    const dbPath = path.join(WS, "ops-d2b-llm.db");
    const seeded = seedD2bSessions(dbPath);
    const port = await freePort();
    // ★ 2026-10-15：本实例的 data 目录由 baseEnv 按实例 tag 统一分配（instanceDataDir）——
    //   原先为规避共享 config.json 而手写的独立目录已收敛到统一机制，此处不再单独声明。
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({
        MEMORY_DB: dbPath, MEMORY_PORT: String(port),
        LLM_BASE_URL: "http://127.0.0.1:1/v1", LLM_MODEL: "smoke-fixed", LLM_API_KEY: "", INGEST_KEY: "",
    }, "ops-d2b-llm"), "ops-d2b-llm");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", seeded, probes: [], counts: {}, evidence: {} };
    }
    const call = async (name, route, method, url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = maskD2bText(await r.text());
        return { name, route, status: r.status, text, sha256: sha256(`${r.status}\n${text}`) };
    };
    const probes = [];
    probes.push(await call("agent.chat", "POST /api/agent/chat", "POST", "/api/agent/chat", { message: "D2B 冒烟：请只回复 ok" }));
    probes.push(await call("plan.decompose", "POST /api/agent/plan/decompose", "POST", "/api/agent/plan/decompose", { goal: "D2B 冒烟：拆解目标", maxSubtasks: 3 }));
    probes.push(await call("agent.sessions.summarize", "POST /api/agent/sessions/:id/summarize", "POST", "/api/agent/sessions/d2b-sess-b/summarize", { keepRecent: 2 }));
    probes.push(await call("agent.sessions.compact", "POST /api/agent/sessions/:id/compact", "POST", "/api/agent/sessions/d2b-sess-b/compact", { keepRecent: 2 }));
    probes.push(await call("agent.sessions.create", "POST /api/agent/sessions", "POST", "/api/agent/sessions", { sessionKey: "d2b-new-sess", title: "D2B 新建会话" }));
    probes.push(await call("agent.sessions.update", "PUT /api/agent/sessions/:id", "PUT", "/api/agent/sessions/d2b-new-sess", { title: "D2B 更新标题" }));
    probes.push(await call("agent.sessions.delete", "DELETE /api/agent/sessions/:id", "DELETE", "/api/agent/sessions/d2b-new-sess"));
    probes.push(await call("agent.mcp.restart", "POST /api/agent/mcp/restart", "POST", "/api/agent/mcp/restart"));
    const json = (n) => { try { return JSON.parse(probes.find((p) => p.name === n)?.text ?? ""); } catch { return {}; } };
    const db = await openDbAfterExit(core, dbPath); // ★ Windows 竞态修复：stop 后立即 openDb 撞未释放句柄（disk I/O error，实测 db.js:691）；openDbAfterExit 自带 stop+等退出+重试
    const sessions = listAgentSessions(db, 50).length;
    db.close();
    const counts = {
        sessionsSeed: seeded.sessions.length,
        sessionsAfter: sessions,
        chatStatus: probes.find((p) => p.name === "agent.chat")?.status ?? null,
        chatText: probes.find((p) => p.name === "agent.chat")?.text ?? "",
        planStatus: probes.find((p) => p.name === "plan.decompose")?.status ?? null,
        summarizeStatus: probes.find((p) => p.name === "agent.sessions.summarize")?.status ?? null,
        compactStatus: probes.find((p) => p.name === "agent.sessions.compact")?.status ?? null,
        compactAfter: json("agent.sessions.compact").after ?? null,
        mcpToolCount: json("agent.mcp.restart").toolCount ?? null,
    };
    return { ok: true, seeded, probes, counts, evidence: {} };
}

/* ── ★ 批次 D2b-B：mock LLM 实例（真跑 run → chain/steps/rollback/approval/artifacts/abort/completeDeps/SSE）── */
async function collectD2bRun() {
    const dbPath = path.join(WS, "ops-d2b-run.db");
    const seeded = seedD2bRun(dbPath);
    const dataDir = instanceDataDir("ops-d2b-run");   // ★ 与 baseEnv 同源的统一机制（原独立目录绕过已收敛）
    fs.mkdirSync(path.join(dataDir, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "artifacts", "d2b-artifact.txt"), "D2B artifact 全文\n第二行\n", "utf8");
    fs.writeFileSync(path.join(WS, "d2b-read.txt"), "D2B 读取目标文件\n第二行内容\n", "utf8");
    const mock = await startMockLlm({ completeDepsDepId: seeded.depCard });
    const port = await freePort();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({
        MEMORY_DB: dbPath, MEMORY_PORT: String(port),
        LLM_BASE_URL: mock.url, LLM_MODEL: "smoke-mock", LLM_API_KEY: "", INGEST_KEY: "",
        MEMORYOS_EXEC_ON: "1",   // B 实例开执行面：file_write/file_read 才在工具面上（真写盘 → 真 diff 快照）
    }, "ops-d2b-run"), "ops-d2b-run");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        mock.close();
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", seeded, probes: [], counts: {}, sse: null };
    }
    const request = async (method, url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
    };
    const call = async (name, route, method, url, body, rawNorm) => {
        const res = await request(method, url, body);
        const text = rawNorm ? normBody(res.text) : maskD2bText(res.text);
        return { name, route, status: res.status, text, sha256: sha256(`${res.status}\n${text}`) };
    };
    const probes = [];
    // ① 真建 run（mock 脚本：file_write → file_read → 文本）→ 等终态
    const created = await request("POST", "/api/agent/runs", { message: "D2B 冒烟：请只回复 ok", sessionKey: seeded.session, allowWrites: true });
    let runId = null;
    try { runId = JSON.parse(created.text)?.runId; } catch { /* 非 202 */ }
    const createdText = maskD2bText(created.text);
    probes.push({ name: "agent.runs.create", route: "POST /api/agent/runs", status: created.status, text: createdText, sha256: sha256(`${created.status}\n${createdText}`) });
    let runStatus = null;
    for (let i = 0; i < 120 && runId; i++) {
        await sleep(250);
        const g = await request("GET", `/api/agent/runs/${runId}`);
        try { runStatus = JSON.parse(g.text)?.status; } catch { runStatus = null; }
        if (runStatus && runStatus !== "running" && runStatus !== "queued") break;
    }
    const rid = runId ?? "missing";
    // ② 副作用：会话追加 2 条（1→3）+ 内存 run 计数 1 + 终态 done
    const sessAfter = await request("GET", `/api/agent/sessions/${seeded.session}`);
    const sessMsgs = (() => { try { return (JSON.parse(sessAfter.text)?.messages ?? []).length; } catch { return -1; } })();
    const runsList = await request("GET", "/api/agent/runs");
    const runsTotal = (() => { try { return JSON.parse(runsList.text)?.total ?? -1; } catch { return -1; } })();
    // ③ run 域只读/写路由（用 maskD2bText 归一）
    probes.push(await call("agent.runs.chain", "GET /api/agent/runs/:id/chain", "GET", `/api/agent/runs/${rid}/chain`));
    probes.push(await call("agent.steps.output", "GET /api/agent/runs/:id/steps/:sid/output", "GET", `/api/agent/runs/${rid}/steps/1/output`));
    probes.push(await call("agent.steps.approval", "POST /api/agent/runs/:id/steps/:sid/approval", "POST", `/api/agent/runs/${rid}/steps/1/approval`));
    probes.push(await call("agent.steps.rollback", "POST /api/agent/runs/:id/steps/:sid/rollback", "POST", `/api/agent/runs/${rid}/steps/1/rollback`));
    // ④ artifact 读取（文件已预置在 data/artifacts；响应是**非 JSON 原文** → 只走 normBody）
    probes.push(await call("agent.artifacts.read", "GET /api/artifacts/:id", "GET", "/api/artifacts/d2b-artifact.txt", undefined, true));
    probes.push(await call("agent.artifacts.read.404", "GET /api/artifacts/:id(不存在)", "GET", "/api/artifacts/d2b-missing.txt"));
    probes.push(await call("agent.artifacts.read.bad", "GET /api/artifacts/:id(非法名)", "GET", "/api/artifacts/d2b..evil.txt"));
    // ⑤ 卡片依赖收敛（mock 返回固定 JSON：complete 既有 task 依赖卡 → done；create 一条新前置）
    probes.push(await call("cards.completeDeps", "POST /api/cards/:id/complete-deps", "POST", `/api/cards/${seeded.mainCard}/complete-deps`));
    // ⑥ SSE 结构化探针：终态 run 的**回放**（读至流自然结束）
    const sseReplay = runId ? normSse(await readSseToEnd(port, runId)) : null;
    // ⑦ abort：D2BSLOW 让 mock 首轮延迟 4s → 立刻中止仍处 running 的 run
    const slow = await request("POST", "/api/agent/runs", { message: "D2BSLOW 冒烟：请只回复 ok" });
    let slowId = null;
    try { slowId = JSON.parse(slow.text)?.runId; } catch { slowId = null; }
    probes.push(await call("agent.runs.abort", "POST /api/agent/runs/:id/abort", "POST", `/api/agent/runs/${slowId ?? "missing"}/abort`, { reason: "D2B 冒烟中止" }));
    // ⑧ SSE 实时 + 客户端断开：D2BSSELIVE 首轮延迟 1.2s → 先连上、拿到首个事件即断（走服务端 close 清理）
    let sseLive = null;
    let liveId = null;
    {
        const lr = await request("POST", "/api/agent/runs", { message: "D2BSSELIVE 冒烟：请只回复 ok" });
        try { liveId = JSON.parse(lr.text)?.runId; } catch { liveId = null; }
        if (liveId) sseLive = await readSseFirstEvent(port, liveId);
    }
    // ⑨ 断开后：run 仍能走到终态（服务端 run 不因客户端断流而卡死）
    let liveStatus = null;
    for (let i = 0; i < 120 && liveId; i++) {
        await sleep(250);
        const g = await request("GET", `/api/agent/runs/${liveId}`);
        try { liveStatus = JSON.parse(g.text)?.status; } catch { liveStatus = null; }
        if (liveStatus && liveStatus !== "running" && liveStatus !== "queued") break;
    }
    const health = await request("GET", "/health");
    mock.close();
    // 夹具/副作用证据（读盘 + 读库）
    const rollbackTarget = fs.existsSync(path.join(WS, "d2b-target.txt")) ? fs.readFileSync(path.join(WS, "d2b-target.txt"), "utf8") : null;
    const json = (n) => { try { return JSON.parse(probes.find((p) => p.name === n)?.text ?? ""); } catch { return {}; } };
    const chain = json("agent.runs.chain");
    const db = await openDbAfterExit(core, dbPath); // ★ Windows 竞态修复：同上（stop 已并入 openDbAfterExit）
    const depStatus = db.prepare(`SELECT status FROM cards WHERE id=?`).get(seeded.depCard)?.status ?? null;
    const cardCount = Number(db.prepare(`SELECT COUNT(*) c FROM cards`).get().c);
    const sessionMsgs = (() => { try { return (JSON.parse(db.prepare(`SELECT messages FROM agent_sessions WHERE session_key=?`).get(seeded.session)?.messages ?? "[]") ?? []).length; } catch { return -1; } })();
    db.close();
    const counts = {
        runStatus, runsTotal, sessMsgs, sessionMsgs,
        steps: (chain.chain ?? []).length,
        diffSteps: (chain.chain ?? []).filter((c) => c.hasDiff).length,
        chainToolCalls: chain.toolCalls ?? null,
        rollback: json("agent.steps.rollback"),
        rollbackTarget,
        artifactBytes: Buffer.byteLength("D2B artifact 全文\n第二行\n", "utf8"),
        completed: json("cards.completeDeps").completed ?? [],
        createdCards: json("cards.completeDeps").created ?? [],
        remaining: json("cards.completeDeps").remaining ?? [],
        depStatus, cardCount,
        abortStatus: json("agent.runs.abort").status ?? null,
        liveFirstMs: sseLive?.firstMs ?? null,
        liveStatus, healthStatus: health.status,
        sseNames: sseReplay?.names ?? [], sseIds: sseReplay?.ids ?? [],
    };
    return { ok: true, seeded, probes, counts, sse: sseReplay, sseLive: sseLive ? { firstMs: sseLive.firstMs } : null };
}

/** SSE 实时读取：连上后在**拿到首个事件即断开**，返回首个事件的到达延迟（ms）。 */
async function readSseFirstEvent(port, runId, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    let firstMs = null;
    let head = "";
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/agent/runs/${runId}/stream`, { headers: { "x-memory-token": TOKEN }, signal: ctrl.signal });
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            head += dec.decode(value, { stream: true });
            if (/(^|\n)event: /.test(head)) { firstMs = Date.now() - t0; break; }
        }
    }
    catch { /* 断开/超时：正常路径 */ }
    finally { clearTimeout(t); try { ctrl.abort(); } catch { /* 已中止 */ } }
    return { firstMs, head };
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 批次 C（2026-10-15）追加 —— memory 域 6 条 REST 路由
 *   op `memory.create` / `memory.update` / `memory.delete` / `rules.list` / `embed.vectors` / `embed.recompute`
 *
 *  两个隔离实例（各自独立库 / 端口 / data 目录）：
 *   A = **mock embeddings 端点**（EMBED_MODE=api，本进程内起、响应固定 8 维 0.1）——6 条路由的
 *       **成功路径**与**协议校验路径**（400/404）全部逐字节比对。
 *   B = **EMBED_MODE=fake** —— 只钉 `POST /v1/embeddings` 的 **fail-closed 503** 契约
 *       （⑥纪律的代码落点：内核未以 local/api 运行时宁可不服务，也不产出伪向量污染真向量语料）；
 *       该分支按 `embedder.mode === "fake"` 判定，**必须换一个进程**才取得到。
 *
 *  ★ 夹具与环境的三处刻意设计（不照抄会踩坑）：
 *   ① 每条基准行**显式落固定 created_at**（+ `normBody` 归一兜底）⇒ `GET /api/rules` 的 created_at /
 *      `eff` 不随运行时刻抖动（本实例内不跑 daemon，eff_confidence 无并发写）。
 *   ② 实例注入 `USERPROFILE` / `HOME` = 临时工作区 —— 因为 **PUT(改 inject) 与 DELETE(删规则) 会触发
 *      `autoSyncRules → syncRules`**，而 syncRules 的落点是 **os.homedir() 下的 7 个真实规则文件**
 *      （~/.codex/AGENTS.md、~/.claude/CLAUDE.md、~/.trae-cn/user_rules/rule-memoryos.md 等）。
 *      不隔离就会**改写用户真实规则文件**；隔离后 7 个落点全落在 WS 内，并可反向当作「规则同步真的跑了」的实证。
 *   ③ 因此 `POST /api/memory` 只用 type='experience'（type='rule' 会触发同一同步链）——
 *      本批的规则同步只经 `PUT(inject=1)` 触发**一次**，副作用受控且可断言。
 * ══════════════════════════════════════════════════════════════════════ */

/** ★ 批次 C：6 条 op → REST 传输声明的期望值（注册表不变量：登记错路由会被抓出） */
const MEM_EXPECT = {
    "memory.create": "POST /api/memory",
    "memory.update": "PUT /api/memory/:id",
    "memory.delete": "DELETE /api/memory/:id",
    "rules.list": "GET /api/rules",
    "embed.vectors": "POST /v1/embeddings",
    "embed.recompute": "POST /api/embed/recompute/:id",
};
/** getSyncTargets() 的 7 个落点（相对家目录）——仅用于「规则同步真的写了文件」的反向实证 */
const SYNC_TARGET_RELS = [".workbuddy/MEMORY.md", ".workbuddy-ai/MEMORY.md", ".codex/AGENTS.md", ".claude/CLAUDE.md", ".trae-cn/user_rules/rule-memoryos.md", ".config/opencode/AGENTS.md", ".qoder/AGENTS.md"];

/** ★ 批次 C 夹具：1 条 rule + 2 条 experience（其一置 embedding_stale=1）+ 固定 created_at */
function seedMemory(dbPath) {
    const db = openDb(dbPath);
    const w = (content, type) => writeMemory(db, { content, type, agent: type === "rule" ? "human:smoke" : AGENT, agent_fpath: null, project: "global" });
    const rule = w("批次C冒烟规则：memory 域迁移期间不得改动检索语义", "rule");
    const keep = w("批次C冒烟记忆 A：编辑与删除的目标", "experience");
    const stale = w("批次C冒烟记忆 B：embedding_stale=1 待补算", "experience");
    const ts = db.prepare(`UPDATE memories SET created_at=? WHERE id=?`);
    ts.run("2026-03-01T00:00:00.000Z", rule.id);
    ts.run("2026-03-01T00:00:01.000Z", keep.id);
    ts.run("2026-03-01T00:00:02.000Z", stale.id);
    // 只留 stale 一条待补算 ⇒ recompute 的 {done,failed,pending} 口径干净（done=1 / pending=0）
    db.prepare(`UPDATE memories SET embedding_stale=1 WHERE id=?`).run(stale.id);
    db.close();
    return { rule: rule.id, keep: keep.id, stale: stale.id };
}

/** 等核心子进程**真退出**再读它的库：Windows 上句柄释放有延迟，否则 `PRAGMA journal_mode=WAL` 会撞上未释放的锁
 *  （实测：不等就 `openDb` 抛 `disk I/O error`，位置 db.js:685 的 journal_mode 语句）。带重试兜底。 */
async function openDbAfterExit(child, dbPath) {
    stop(child);
    await Promise.race([exitWaiters.get(child) ?? Promise.resolve(), sleep(3000)]);
    let last = null;
    for (let i = 0; i < 12; i++) {
        try { return openDb(dbPath); }
        catch (e) { last = e; await sleep(250); }
    }
    throw last;
}

/* ── ★ 批次 C-A：mock embeddings 实例 —— 6 条路由的成功路径 + 协议校验逐字节 ── */
async function collectMemory() {
    const dbPath = path.join(WS, "ops-memory.db");
    const ids = seedMemory(dbPath);
    const mock = await startMockEmbedder();
    const port = await freePort();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({
        MEMORY_DB: dbPath, MEMORY_PORT: String(port),
        EMBED_MODE: "api", EMBED_API_URL: mock.url, EMBED_API_KEY: "smoke-only-not-a-secret",
        USERPROFILE: WS, HOME: WS,   // ★ 见文件头 ②：规则注入落点隔离（否则会写用户真实规则文件）
    }, "ops-memory"), "ops-memory");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        mock.close();
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", ids, probes: [], counts: {} };
    }
    const call = async (name, route, method, url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = normBody(await r.text());
        return { name, route, status: r.status, text, sha256: sha256(`${r.status}\n${text}`) };
    };
    const probes = [];
    // ① 只读 + 向量补算先行（此时夹具未被任何写操作扰动 ⇒ pending 口径干净）
    probes.push(await call("rules.list", "GET /api/rules", "GET", "/api/rules?limit=50&status=active"));
    probes.push(await call("embed.recompute", "POST /api/embed/recompute/:id", "POST", `/api/embed/recompute/${ids.stale}`));
    probes.push(await call("embed.recompute.400", "POST /api/embed/recompute/:id(非法 id)", "POST", "/api/embed/recompute/0"));
    probes.push(await call("embed.vectors", "POST /v1/embeddings", "POST", "/v1/embeddings", { input: ["批次C冒烟嵌入文本一", "批次C冒烟嵌入文本二"], model: "smoke-embed" }));
    probes.push(await call("embed.vectors.400", "POST /v1/embeddings(空输入)", "POST", "/v1/embeddings", { input: ["  "] }));
    // ② 写路径（固定入参、固定顺序）
    probes.push(await call("memory.create", "POST /api/memory", "POST", "/api/memory", { content: "批次C冒烟新建记忆（experience）", type: "experience", project: "global", sensitivity: "normal" }));
    probes.push(await call("memory.create.typeFallback", "POST /api/memory(非法 type → 回落 experience)", "POST", "/api/memory", { content: "批次C冒烟新建记忆（type 回落）", type: "not-a-type" }));
    probes.push(await call("memory.create.sector", "POST /api/memory(显式 sector + private)", "POST", "/api/memory", { content: "批次C冒烟新建记忆（显式 sector）", type: "pitfall", sector: "episodic", sensitivity: "private" }));
    probes.push(await call("memory.create.400.empty", "POST /api/memory(content 为空)", "POST", "/api/memory", { content: "   " }));
    probes.push(await call("memory.create.400.sensitivity", "POST /api/memory(sensitivity 非法)", "POST", "/api/memory", { content: "批次C冒烟：sensitivity 非法", sensitivity: "top-secret" }));
    probes.push(await call("memory.update", "PUT /api/memory/:id", "PUT", `/api/memory/${ids.keep}`, { content: "批次C冒烟记忆 A：已被编辑的正文" }));
    // ★ 既有行为（**不是本批引入**）：路由的空 sector 只挡非法值、不挡空串 ⇒ `sector:""` 落到 db 层 `sector=NULL`
    //   撞 memories.sector 的 NOT NULL ⇒ 400。这条刻意留作回归探针（迁移前后必须逐字节相同）。
    probes.push(await call("memory.update.sectorEmpty", "PUT /api/memory/:id(sector 空串 → db NOT NULL)", "PUT", `/api/memory/${ids.keep}`, { sector: "" }));
    probes.push(await call("memory.update.400.id", "PUT /api/memory/:id(非法 id)", "PUT", "/api/memory/abc", { content: "x" }));
    probes.push(await call("memory.update.400.type", "PUT /api/memory/:id(type 非法)", "PUT", `/api/memory/${ids.keep}`, { type: "bogus" }));
    probes.push(await call("memory.update.400.sector", "PUT /api/memory/:id(sector 非法)", "PUT", `/api/memory/${ids.keep}`, { sector: "not-a-sector" }));
    probes.push(await call("memory.update.404", "PUT /api/memory/:id(不存在)", "PUT", "/api/memory/999999", { content: "x" }));
    // ③ 规则注入开关（PUT inject=1 → 触发 autoSyncRules）→ 复读规则页确认开关已落库
    probes.push(await call("memory.update.inject", "PUT /api/memory/:id(inject=1)", "PUT", `/api/memory/${ids.rule}`, { inject: 1 }));
    probes.push(await call("rules.list.afterInject", "GET /api/rules(改 inject 后)", "GET", "/api/rules?limit=50&status=active"));
    // ④ 删除（先 404 后真删；删的是 experience 行 ⇒ 不触发规则同步）
    probes.push(await call("memory.delete.404", "DELETE /api/memory/:id(不存在)", "DELETE", "/api/memory/999999"));
    probes.push(await call("memory.delete", "DELETE /api/memory/:id", "DELETE", `/api/memory/${ids.keep}`));
    // ── 证据：读库（副作用）+ 读盘（规则同步落点）──
    const json = (n) => { try { return JSON.parse(probes.find((p) => p.name === n)?.text ?? ""); } catch { return {}; } };
    const db = await openDbAfterExit(core, dbPath);
    const one = (sql) => { try { return db.prepare(sql).get() ?? {}; } catch { return {}; } };
    const keepStatus = db.prepare(`SELECT status FROM memories WHERE id=?`).get(ids.keep)?.status ?? null;
    const ruleInject = db.prepare(`SELECT inject FROM memories WHERE id=?`).get(ids.rule)?.inject ?? null;
    const staleLeft = Number(one(`SELECT COUNT(*) c FROM memories WHERE embedding_stale=1`).c ?? -1);
    const rowCount = Number(one(`SELECT COUNT(*) c FROM memories`).c ?? -1);
    db.close();
    mock.close();
    const syncWritten = SYNC_TARGET_RELS.filter((rel) => {
        try { return fs.readFileSync(path.join(WS, ...rel.split("/")), "utf8").includes("MEMORYOS-SYNC-RULES-START"); }
        catch { return false; }
    }).length;
    const rl = json("rules.list"), rl2 = json("rules.list.afterInject"), ev = json("embed.vectors"), rc = json("embed.recompute");
    const counts = {
        rules: (rl.rows ?? []).length,
        rulesAfterInject: (rl2.rows ?? []).length,
        injectInList: (rl2.rows ?? []).find((r) => r.id === ids.rule)?.inject ?? null,
        injectBefore: (rl.rows ?? []).find((r) => r.id === ids.rule)?.inject ?? null,
        embedRows: (ev.data ?? []).length,
        embedDim: (ev.data ?? [])[0]?.embedding?.length ?? null,
        recompute: { done: rc.done ?? null, failed: rc.failed ?? null, pending: rc.pending ?? null },
        createId1: json("memory.create").id ?? null,
        createId2: json("memory.create.typeFallback").id ?? null,
        keepStatus, ruleInject, staleLeft, rowCount, syncWritten,
        probeStatuses: probes.map((p) => `${p.name}:${p.status}`).join(" "),
    };
    return { ok: true, ids, probes, counts };
}

/* ── ★ 批次 C-B：EMBED_MODE=fake 实例 —— /v1/embeddings 的 fail-closed 503 契约 ── */
async function collectMemoryFakeEmbed() {
    const dbPath = path.join(WS, "ops-memory-fake.db");
    seedMemory(dbPath);
    const port = await freePort();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({
        MEMORY_DB: dbPath, MEMORY_PORT: String(port),
        EMBED_MODE: "fake",
        USERPROFILE: WS, HOME: WS,
    }, "ops-memory-fake"), "ops-memory-fake");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", probes: [], counts: {} };
    }
    const r = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: "POST",
        headers: { "x-memory-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ input: ["批次C冒烟：fake 模式拒绝伪向量"] }),
    });
    const text = normBody(await r.text());
    const probes = [{ name: "embed.vectors.fake", route: "POST /v1/embeddings(fake 模式)", status: r.status, text, sha256: sha256(`${r.status}\n${text}`) }];
    stop(core);
    let body = {};
    try { body = JSON.parse(text); } catch { /* 非 JSON：按原文记录 */ }
    return { ok: true, probes, counts: { status: r.status, error: body.error ?? null, hasHint: !!body.hint } };
}

/* ── ★ 批次 E1：cards 域 14 条（CRUD/详情/事件/评论/链接/状态机/心跳）──────────────────
 *  夹具确定性：卡片/事件/评论全部固定 created_at/updated_at（显式 id 1..7 → 建卡探针 id 恒 8）；
 *  claim 的 lock 是随机 hex → 掩码；写探针按固定顺序跑在互不重叠的夹具卡上（A..F），
 *  只读探针先于全部写探针。 */
const CARDS_EXPECT = {
    "cards.list": "GET /api/cards",
    "cards.one": "GET /api/cards/:id",
    "cards.create": "POST /api/cards",
    "cards.update": "PUT /api/cards/:id",
    "cards.delete": "DELETE /api/cards/:id",
    "cards.events.read": "GET /api/cards/:id/events",
    "cards.comment.add": "POST /api/cards/:id/comment",
    "cards.comments.list": "GET /api/cards/:id/comments",
    "cards.link.add": "POST /api/cards/:id/links",
    "cards.link.delete": "DELETE /api/cards/:id/links",
    "cards.status": "POST /api/cards/:id/status",
    "cards.accept": "POST /api/cards/:id/accept",
    "cards.claim": "POST /api/cards/:id/claim",
    "cards.heartbeat": "POST /api/cards/:id/heartbeat",
};
const maskLock = (v) => { try { const o = JSON.parse(String(v)); if (o && typeof o.lock === "string") o.lock = "MASKED"; return JSON.stringify(o); } catch { return v; } };
/* ★ 批次 E2a：工作台配置面 16 条（card-types×4 / retype / card-edges×2 / agent-profiles×4 / positions×2 / archive×3）
 *  探针追加在 E1 序列尾部（cards.delete 之后），固定顺序保确定性；类型生命周期探针自建自删不留残余。 */
const CARDS2_EXPECT = {
    "card-types.list": "GET /api/card-types",
    "card-types.create": "POST /api/card-types",
    "card-types.update": "PUT /api/card-types/:key",
    "card-types.delete": "DELETE /api/card-types/:key",
    "cards.retype": "POST /api/cards/:id/retype",
    "agent-profiles.list": "GET /api/agent-profiles",
    "agent-profiles.create": "POST /api/agent-profiles",
    "agent-profiles.update": "PUT /api/agent-profiles/:id",
    "agent-profiles.delete": "DELETE /api/agent-profiles/:id",
    "card-edges.add": "POST /api/card-edges",
    "card-edges.delete": "DELETE /api/card-edges/:id",
    "cards.position.set": "POST /api/cards/:id/position",
    "cards.positions.reset": "DELETE /api/cards/positions",
    "cards.archive.get": "GET /api/cards/archive",
    "cards.archive.set": "POST /api/cards/archive",
    "cards.archive.grouped": "GET /api/cards/archive/grouped",
};

function seedCards(dbPath) {
    const db = openDb(dbPath);
    const ins = db.prepare(`INSERT INTO cards(id,board,kind,title,body,status,assignee,lane,priority,meta,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const row = (id, kind, title, body, status, meta, assignee = null) =>
        ins.run(id, "default", kind, title, body, status, assignee, null, 0, meta, `2026-02-01T00:01:${String(id).padStart(2, "0")}.000Z`, `2026-02-01T00:01:${String(id).padStart(2, "0")}.000Z`);
    row(1, "task", "E1冒烟卡A（更新/评论/连线源）", "正文A", "todo", JSON.stringify({ map_pos: { h: { x: 10, y: 20 } } }));
    row(2, "task", "E1冒烟卡B（状态流转目标）", "正文B", "todo", null);
    row(3, "task", "E1冒烟卡C（认领/心跳）", "正文C", "ready", null);
    row(4, "task", "E1冒烟卡D（验收 done）", "正文D", "review", null);
    row(5, "task", "E1冒烟卡E（删除目标）", "正文E", "todo", null);
    row(6, "doc", "E1冒烟卡F（事件/评论只读）", "正文F", "todo", null);
    row(7, "doc", "E1冒烟卡G（已归档）", "正文G", "archived", null);
    // 事件 / 评论固定时间戳（GET /:id/events 逐字节确定性的前提）
    const ev = db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail, created_at) VALUES (?,?,?,?,?,?,?)`);
    ev.run(6, AGENT, "create", null, "todo", "夹具事件1", "2026-02-01T00:02:01.000Z");
    ev.run(6, AGENT, "comment", null, null, "夹具事件2", "2026-02-01T00:02:02.000Z");
    const cm = db.prepare(`INSERT INTO card_comments(card_id, author, body, created_at) VALUES (?,?,?,?)`);
    cm.run(6, "human:dashboard", "夹具评论1", "2026-02-01T00:03:01.000Z");
    cm.run(6, AGENT, "夹具评论2", "2026-02-01T00:03:02.000Z");
    db.close();
    return { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, nextId: 8 };
}

async function collectCards() {
    const dbPath = path.join(WS, "ops-cards.db");
    const ids = seedCards(dbPath);
    const port = await freePort();
    const core = start([path.join(HERE, "dashboard.js")], baseEnv({ MEMORY_DB: dbPath, MEMORY_PORT: String(port) }, "ops-cards"), "ops-cards");
    const h = await waitForHealth(port);
    if (!h) {
        stop(core);
        return { ok: false, reason: "隔离核心 30s 内未就绪（环境问题）", ids, probes: [], counts: {} };
    }
    const call = async (name, route, method, url, body, mask) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method, headers: { "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await r.text();
        const text = mask ? normBody(mask(raw)) : normBody(raw);
        return { name, route, status: r.status, text, sha256: sha256(`${r.status}\n${text}`) };
    };
    // 裸请求（状态铺垫/恢复用，不记录探针）：E2a 类型/档案生命周期需要建卡删卡与归档策略恢复
    const request = async (method, url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, {
            method, headers: { "x-memory-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
    };
    const probes = [];
    // —— 只读探针（未被写探针扰动前）——
    probes.push(await call("cards.list", "GET /api/cards", "GET", "/api/cards"));
    probes.push(await call("cards.one", "GET /api/cards/:id", "GET", `/api/cards/${ids.A}`));
    probes.push(await call("cards.one.404", "GET /api/cards/:id(不存在)", "GET", "/api/cards/999999"));
    probes.push(await call("cards.events.read", "GET /api/cards/:id/events", "GET", `/api/cards/${ids.F}/events`));
    probes.push(await call("cards.comments.list", "GET /api/cards/:id/comments", "GET", `/api/cards/${ids.F}/comments`));
    // —— 写探针（固定顺序；每张夹具卡只被一条写路径触碰，保证两次采集状态一致）——
    probes.push(await call("cards.create", "POST /api/cards", "POST", "/api/cards", { title: "E1建卡探针", body: "E1 建卡正文", kind: "task", priority: 2 }));
    probes.push(await call("cards.create.dup", "POST /api/cards(重名软提示)", "POST", "/api/cards", { title: "E1建卡探针" }));
    probes.push(await call("cards.create.strict", "POST /api/cards?strict_dup=1", "POST", "/api/cards?strict_dup=1", { title: "E1建卡探针" }));
    probes.push(await call("cards.create.badstatus", "POST /api/cards(非法状态400)", "POST", "/api/cards", { title: "E1非法状态卡", status: "nonsense" }));
    probes.push(await call("cards.create.longtitle", "POST /api/cards(超长标题400)", "POST", "/api/cards", { title: "长".repeat(201) }));
    probes.push(await call("cards.update", "PUT /api/cards/:id", "PUT", `/api/cards/${ids.A}`, { title: "E1更新后标题A", priority: 5 }));
    probes.push(await call("cards.status", "POST /api/cards/:id/status", "POST", `/api/cards/${ids.B}/status`, { status: "ready", expected_from: "todo", as: "human:dashboard" }));
    probes.push(await call("cards.claim", "POST /api/cards/:id/claim", "POST", `/api/cards/${ids.C}/claim?as=${AGENT}`, {}, maskLock));
    probes.push(await call("cards.heartbeat", "POST /api/cards/:id/heartbeat", "POST", `/api/cards/${ids.C}/heartbeat`, { as: AGENT }));
    probes.push(await call("cards.accept", "POST /api/cards/:id/accept", "POST", `/api/cards/${ids.D}/accept`, { as: "human:dashboard" }));
    probes.push(await call("cards.comment.add", "POST /api/cards/:id/comment", "POST", `/api/cards/${ids.A}/comment`, { body: "E1冒烟评论", author: "human:dashboard" }));
    probes.push(await call("cards.link.add", "POST /api/cards/:id/links", "POST", `/api/cards/${ids.A}/links`, { dst_card_id: ids.B, kind: "relates" }));
    probes.push(await call("cards.link.add.dup", "POST /api/cards/:id/links(重复边409)", "POST", `/api/cards/${ids.A}/links`, { dst_card_id: ids.B, kind: "relates" }));
    probes.push(await call("cards.link.add.blocks", "POST /api/cards/:id/links(blocks→depends)", "POST", `/api/cards/${ids.B}/links`, { dst_card_id: ids.E, kind: "blocks" }));
    probes.push(await call("cards.link.delete", "DELETE /api/cards/:id/links", "DELETE", `/api/cards/${ids.A}/links?dst_card_id=${ids.B}&kind=relates`));
    probes.push(await call("cards.delete", "DELETE /api/cards/:id", "DELETE", `/api/cards/${ids.E}`));
    // —— ★ 批次 E2a：工作台配置面 16 条（追加在 E1 写探针之后；类型/档案生命周期自建自删）——
    // card-types 生命周期：create → dup/reserved/badkey 协议路径 → update（含 404/builtin 409）→ 建卡占类型 → delete 409 → 删卡 → delete 200
    probes.push(await call("card-types.list", "GET /api/card-types", "GET", "/api/card-types"));
    probes.push(await call("card-types.create", "POST /api/card-types", "POST", "/api/card-types", { type_key: "smoketype", label: "E2冒烟类型" }));
    probes.push(await call("card-types.create.dup", "POST /api/card-types(重复409)", "POST", "/api/card-types", { type_key: "smoketype", label: "E2冒烟类型" }));
    probes.push(await call("card-types.create.reserved", "POST /api/card-types(保留字409)", "POST", "/api/card-types", { type_key: "task", label: "任务" }));
    probes.push(await call("card-types.create.badkey", "POST /api/card-types(非法key400)", "POST", "/api/card-types", { type_key: "BadKey", label: "坏键" }));
    probes.push(await call("card-types.update", "PUT /api/card-types/:key", "PUT", "/api/card-types/smoketype", { label: "E2冒烟类型改", can_dispatch_out: 1 }));
    probes.push(await call("card-types.update.404", "PUT /api/card-types/:key(不存在)", "PUT", "/api/card-types/nosuchtype", { label: "X" }));
    probes.push(await call("card-types.update.builtin", "PUT /api/card-types/:key(内置409)", "PUT", "/api/card-types/task", { label: "X" }));
    const typeCard = await call("cards.create.smoketype", "POST /api/cards(占类型)", "POST", "/api/cards", { title: "E2占类型卡", kind: "smoketype" });
    probes.push(typeCard);
    probes.push(await call("card-types.delete.used", "DELETE /api/card-types/:key(有卡使用409)", "DELETE", "/api/card-types/smoketype"));
    await request("DELETE", `/api/cards/${(JSON.parse(typeCard.text || "{}").id ?? 0)}`);
    probes.push(await call("card-types.delete", "DELETE /api/card-types/:key", "DELETE", "/api/card-types/smoketype"));
    // retype：建 doc 卡 → task；unchanged；非法类型 400；404
    const retypeSrc = await call("cards.create.retype-src", "POST /api/cards(retype源卡)", "POST", "/api/cards", { title: "E2改型源卡", kind: "doc" });
    probes.push(retypeSrc);
    probes.push(await call("cards.retype", "POST /api/cards/:id/retype", "POST", `/api/cards/${(JSON.parse(retypeSrc.text || "{}").id ?? 0)}/retype`, { kind: "task" }));
    probes.push(await call("cards.retype.unchanged", "POST /api/cards/:id/retype(同型)", "POST", `/api/cards/${(JSON.parse(retypeSrc.text || "{}").id ?? 0)}/retype`, { kind: "task" }));
    probes.push(await call("cards.retype.400", "POST /api/cards/:id/retype(未知类型)", "POST", `/api/cards/${(JSON.parse(retypeSrc.text || "{}").id ?? 0)}/retype`, { kind: "nosuchkind" }));
    probes.push(await call("cards.retype.404", "POST /api/cards/:id/retype(不存在)", "POST", "/api/cards/999999/retype", { kind: "task" }));
    // agent-profiles 生命周期（list 先于写；channel=queue → carrier_missing 恒 false 确定性）
    probes.push(await call("agent-profiles.list", "GET /api/agent-profiles", "GET", "/api/agent-profiles"));
    probes.push(await call("agent-profiles.create", "POST /api/agent-profiles", "POST", "/api/agent-profiles", { name: "E2冒烟智能体", channel: "queue" }));
    const profBody = (() => { try { return JSON.parse(probes[probes.length - 1].text); } catch { return {}; } })();
    probes.push(await call("agent-profiles.update", "PUT /api/agent-profiles/:id", "PUT", `/api/agent-profiles/${profBody.profile_id ?? 0}`, { name: "E2冒烟智能体改", model: "smoke-model" }));
    probes.push(await call("agent-profiles.update.404", "PUT /api/agent-profiles/:id(不存在)", "PUT", "/api/agent-profiles/999999", { name: "X" }));
    probes.push(await call("agent-profiles.delete", "DELETE /api/agent-profiles/:id", "DELETE", `/api/agent-profiles/${profBody.profile_id ?? 0}`));
    probes.push(await call("agent-profiles.delete.404", "DELETE /api/card-edges/:id 同口径(档案已删)", "DELETE", `/api/agent-profiles/${profBody.profile_id ?? 0}`));
    // card-edges（handoff→task 注入边生命周期；B 卡 can_inject_in=1）
    const handoffCard = await call("cards.create.handoff-src", "POST /api/cards(注入边源卡)", "POST", "/api/cards", { title: "E2交接源卡", kind: "handoff" });
    probes.push(handoffCard);
    const hcid = (JSON.parse(handoffCard.text || "{}").id ?? 0);
    const edgeAdd = await call("card-edges.add", "POST /api/card-edges", "POST", "/api/card-edges", { source_id: hcid, target_id: ids.B, kind: "inject" });
    probes.push(edgeAdd);
    probes.push(await call("card-edges.add.dup", "POST /api/card-edges(重复409)", "POST", "/api/card-edges", { source_id: hcid, target_id: ids.B, kind: "inject" }));
    probes.push(await call("card-edges.add.badkind", "POST /api/card-edges(仅inject400)", "POST", "/api/card-edges", { source_id: hcid, target_id: ids.B, kind: "depends" }));
    probes.push(await call("card-edges.delete", "DELETE /api/card-edges/:id", "DELETE", `/api/card-edges/${(() => { try { return JSON.parse(edgeAdd.text).id; } catch { return 0; } })()}`));
    probes.push(await call("card-edges.delete.404", "DELETE /api/card-edges/:id(不存在)", "DELETE", "/api/card-edges/999999"));
    // positions（A 卡 meta 含 E1 前的 map_pos 夹具；D-13 精确清除）
    probes.push(await call("cards.position.set", "POST /api/cards/:id/position", "POST", `/api/cards/${ids.A}/position`, { view: "h", x: 5, y: 6 }));
    probes.push(await call("cards.positions.reset", "DELETE /api/cards/positions(?ids=精确)", "DELETE", `/api/cards/positions?ids=${ids.A}`));
    // archive（GET → mode → days → now(done 卡 7/3 天内 → archived=0 恒定) → grouped；末尾恢复 auto/7 不记录）
    probes.push(await call("cards.archive.get", "GET /api/cards/archive", "GET", "/api/cards/archive"));
    probes.push(await call("cards.archive.set.mode", "POST /api/cards/archive(mode)", "POST", "/api/cards/archive", { mode: "manual" }));
    probes.push(await call("cards.archive.set.days", "POST /api/cards/archive(days)", "POST", "/api/cards/archive", { days: 3 }));
    probes.push(await call("cards.archive.set.now", "POST /api/cards/archive(now 立即归档)", "POST", "/api/cards/archive", { now: true }));
    probes.push(await call("cards.archive.grouped", "GET /api/cards/archive/grouped", "GET", "/api/cards/archive/grouped"));
    await request("POST", "/api/cards/archive", { mode: "auto" });
    await request("POST", "/api/cards/archive", { days: 7 });
    stop(core);
    const json = (n) => { try { return JSON.parse(probes.find((p) => p.name === n)?.text ?? ""); } catch { return {}; } };
    const lst = json("cards.list"), one = json("cards.one");
    const counts = {
        listTotal: lst.total ?? 0,
        listBuckets: Object.keys(lst.buckets ?? {}).length,
        oneTitle: one.card?.title ?? "",
        oneLinks: (one.card?.links_out ?? []).length,
    };
    return { ok: true, ids, probes, counts };
}

/* ── 注册表不变量（仅比对模式跑；--capture 时新口径尚未落地）── */
async function checkRegistryInvariants() {
    const reg = await import("./ops-registry.js");
    const taskOps = reg.listOps({ domain: "task" });
    const names = taskOps.map((o) => o.name).sort();
    // ★ 批次 D2b：cards.completeDeps（卡片依赖收敛）按语义登记在 domain=task → 期望集合随之 +1
    check("注册表：task 域登记了 tasks.list / task.next / task.create / cards.completeDeps",
        names.join(",") === "cards.completeDeps,task.create,task.next,tasks.list", `names=[${names.join(",")}]`);

    const mcpOps = reg.listOps().filter((o) => o.transports?.mcp);
    const badMcp = mcpOps.filter((o) => !String(o.risk?.source ?? "").startsWith("TOOL_RISK."));
    check("注册表：全部 MCP 传输 op 的 risk.source 前缀 `TOOL_RISK.`", badMcp.length === 0,
        badMcp.length ? `越界：${badMcp.map((o) => `${o.name}(${o.risk?.source})`).join(", ")}` : `覆盖 ${mcpOps.length} 条`);

    const restOnly = reg.listOps().filter((o) => !o.transports?.mcp);
    const badRest = restOnly.filter((o) => !String(o.risk?.source ?? "").includes("REST-only"));
    check("注册表：全部 REST-only op 显式声明 risk（source 含 `REST-only`）", restOnly.length > 0 && badRest.length === 0,
        badRest.length ? `越界：${badRest.map((o) => `${o.name}(${o.risk?.source})`).join(", ")}` : `覆盖 ${restOnly.length} 条：${restOnly.map((o) => o.name).join(",")}`);

    const tn = reg.getOp("task.next");
    check("注册表：task.next 的 handler 已接线（非 null）", typeof tn?.handler === "function");
    check("注册表：tasks.list 的 handler 仍是函数（未被拆坏）", typeof reg.getOp("tasks.list")?.handler === "function");

    /* ★ 批次 D1：knowledge 域 op 不变量 */
    const kbOps = reg.listOps({ domain: "knowledge" });
    const kbNames = kbOps.map((o) => o.name).sort();
    check("注册表：knowledge 域登记 7 条 op（notes.* / runbook.read）",
        kbNames.join(",") === Object.keys(KB_EXPECT).sort().join(","), `names=[${kbNames.join(",")}]`);
    check("注册表：knowledge op 全部 REST-only 显式声明（无 MCP 传输 + source 含 `REST-only`）",
        kbOps.length === 7 && kbOps.every((o) => !o.transports?.mcp && String(o.risk?.source ?? "").includes("REST-only")),
        kbOps.filter((o) => o.transports?.mcp || !String(o.risk?.source ?? "").includes("REST-only")).map((o) => `${o.name}(${o.risk?.source})`).join(", ") || `覆盖 ${kbOps.length} 条`);
    check("注册表：knowledge op 的 handler 全部非 null（已接线）",
        kbOps.every((o) => typeof o.handler === "function"),
        kbOps.filter((o) => typeof o.handler !== "function").map((o) => o.name).join(", ") || `覆盖 ${kbOps.length} 条`);
    check("注册表：knowledge op 的 REST 传输声明与路由逐条一致",
        kbOps.every((o) => o.transports?.rest === KB_EXPECT[o.name]),
        kbOps.map((o) => `${o.name}→${o.transports?.rest}`).join(" | "));
    check("注册表：knowledge op 的 kind 按读写区分",
        kbOps.filter((o) => o.kind === "read").map((o) => o.name).sort().join(",") === "notes.backlinks,notes.graph,notes.list,runbook.read"
        && kbOps.filter((o) => o.kind === "write").map((o) => o.name).sort().join(",") === "notes.create,notes.delete,notes.update",
        kbOps.map((o) => `${o.name}:${o.kind}`).join(" | "));
    // 同名重复注册仍 throw（knowledge op）
    let dupKb = false;
    try { reg.defineOp({ name: "notes.list", domain: "knowledge", kind: "read", transports: { rest: "GET /api/notes" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具" }, handler: () => null }); }
    catch { dupKb = true; }
    check("注册表：knowledge op 同名重复注册 throw（不静默覆盖）", dupKb);
    // invokeOp 端到端：领域函数可经注册表派发，且返回**裸领域值**（无 { ok } 信封）
    const kbDb = openDb(path.join(WS, "ops-knowledge-wire.db"));
    let wired = null;
    try { wired = await reg.invokeOp("notes.list", {}, { db: kbDb }); }
    catch (e) { wired = { err: String(e?.message ?? e) }; }
    kbDb.close();
    check("注册表：notes.list 经 invokeOp 派发返回裸领域值（{ notes: [] }，无 { ok } 信封）",
        Array.isArray(wired?.notes) && wired.ok === undefined && wired.err === undefined,
        `result=${JSON.stringify(wired).slice(0, 90)}`);

    /* ★ 批次 D2a：agent / export 域 op 不变量 —— ★ D2b 亦向 domain=agent 追加了 op，
     *   故此处的口径改为「按 AGENT_EXPECT 名字集合筛选」（保住「D2a 这 10 条」的原始断言力，
     *   不被后续批次新增的 agent 域 op 冲淡），D2b 的新增 op 由下面 D2B_EXPECT 单独断言。 */
    const d2Ops = reg.listOps().filter((o) => Object.prototype.hasOwnProperty.call(AGENT_EXPECT, o.name));
    const d2Names = d2Ops.map((o) => o.name).sort();
    check("注册表：批次 D2a 登记 10 条 op（agent.* / export.*）",
        d2Names.join(",") === Object.keys(AGENT_EXPECT).sort().join(","), `names=[${d2Names.join(",")}]`);
    check("注册表：agent/export op 全部 REST-only 显式声明（无 MCP 传输 + source 含 `REST-only`）",
        d2Ops.length === 10 && d2Ops.every((o) => !o.transports?.mcp && String(o.risk?.source ?? "").includes("REST-only")),
        d2Ops.filter((o) => o.transports?.mcp || !String(o.risk?.source ?? "").includes("REST-only")).map((o) => `${o.name}(${o.risk?.source})`).join(", ") || `覆盖 ${d2Ops.length} 条`);
    check("注册表：agent/export op 的 handler 全部非 null（已接线）",
        d2Ops.every((o) => typeof o.handler === "function"),
        d2Ops.filter((o) => typeof o.handler !== "function").map((o) => o.name).join(", ") || `覆盖 ${d2Ops.length} 条`);
    check("注册表：agent/export op 的 REST 传输声明与路由逐条一致",
        d2Ops.every((o) => o.transports?.rest === AGENT_EXPECT[o.name]),
        d2Ops.map((o) => `${o.name}→${o.transports?.rest}`).join(" | "));
    check("注册表：agent/export op 的 kind 按读写区分",
        d2Ops.filter((o) => o.kind === "read").map((o) => o.name).sort().join(",") === "agent.list,agent.runs.list,agent.runs.read,agent.sessions.list,agent.sessions.read,agent.status,export.audit,export.memories"
        && d2Ops.filter((o) => o.kind === "write").map((o) => o.name).sort().join(",") === "agent.config.set,agent.exec.toggle",
        d2Ops.map((o) => `${o.name}:${o.kind}`).join(" | "));
    // 同名重复注册仍 throw（D2a op）
    let dupD2 = false;
    try { reg.defineOp({ name: "agent.list", domain: "agent", kind: "read", transports: { rest: "GET /api/agents" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具" }, handler: () => null }); }
    catch { dupD2 = true; }
    check("注册表：agent/export op 同名重复注册 throw（不静默覆盖）", dupD2);
    // invokeOp 端到端：agent 域领域函数可经注册表派发，且返回**裸领域值**（无 { ok } 信封）
    const d2Db = openDb(path.join(WS, "ops-agent-wire.db"));
    let wiredD2 = null;
    try { wiredD2 = await reg.invokeOp("agent.sessions.list", {}, { db: d2Db, listAgentSessions }); }
    catch (e) { wiredD2 = { err: String(e?.message ?? e) }; }
    d2Db.close();
    check("注册表：agent.sessions.list 经 invokeOp 派发返回裸领域值（{ sessions: [] }，无 { ok } 信封）",
        Array.isArray(wiredD2?.sessions) && wiredD2.ok === undefined && wiredD2.err === undefined,
        `result=${JSON.stringify(wiredD2).slice(0, 90)}`);

    /* ★ 批次 D2b：17 条 op 不变量（agent 15 / plan 1 / task 1） */
    const d2bOps = reg.listOps().filter((o) => Object.prototype.hasOwnProperty.call(D2B_EXPECT, o.name));
    const d2bNames = d2bOps.map((o) => o.name).sort();
    check("注册表：批次 D2b 登记 17 条 op（agent 运行管理/SSE/LLM/进程操作 + plan.decompose + cards.completeDeps）",
        d2bNames.join(",") === Object.keys(D2B_EXPECT).sort().join(",") && d2bOps.length === 17, `names=[${d2bNames.join(",")}]`);
    check("注册表：D2b op 全部 REST-only 显式声明（无 MCP 传输 + source 含 `REST-only`）",
        d2bOps.length === 17 && d2bOps.every((o) => !o.transports?.mcp && String(o.risk?.source ?? "").includes("REST-only")),
        d2bOps.filter((o) => o.transports?.mcp || !String(o.risk?.source ?? "").includes("REST-only")).map((o) => `${o.name}(${o.risk?.source})`).join(", ") || `覆盖 ${d2bOps.length} 条`);
    check("注册表：D2b op 的 handler 全部非 null（已接线）",
        d2bOps.every((o) => typeof o.handler === "function"),
        d2bOps.filter((o) => typeof o.handler !== "function").map((o) => o.name).join(", ") || `覆盖 ${d2bOps.length} 条`);
    check("注册表：D2b op 的 REST 传输声明与路由逐条一致",
        d2bOps.every((o) => o.transports?.rest === D2B_EXPECT[o.name]),
        d2bOps.map((o) => `${o.name}→${o.transports?.rest}`).join(" | "));
    check("注册表：D2b op 的 kind 按读写区分",
        d2bOps.filter((o) => o.kind === "read").map((o) => o.name).sort().join(",") === "agent.artifacts.read,agent.runs.chain,agent.runs.stream,agent.steps.output"
        && d2bOps.filter((o) => o.kind === "write").map((o) => o.name).sort().join(",") === "agent.chat,agent.mcp.restart,agent.runs.abort,agent.runs.create,agent.sessions.compact,agent.sessions.create,agent.sessions.delete,agent.sessions.summarize,agent.sessions.update,agent.steps.approval,agent.steps.rollback,cards.completeDeps,plan.decompose",
        d2bOps.map((o) => `${o.name}:${o.kind}`).join(" | "));
    check("注册表：D2b op 的 domain 按语义分布（agent 15 / plan 1 / task 1）",
        d2bOps.filter((o) => o.domain === "agent").length === 15 && d2bOps.filter((o) => o.domain === "plan").map((o) => o.name).join(",") === "plan.decompose"
        && d2bOps.filter((o) => o.domain === "task").map((o) => o.name).join(",") === "cards.completeDeps",
        d2bOps.map((o) => `${o.name}:${o.domain}`).join(" | "));
    // 同名重复注册仍 throw（D2b op）
    let dupD2b = false;
    try { reg.defineOp({ name: "agent.chat", domain: "agent", kind: "write", transports: { rest: "POST /api/agent/chat" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具" }, handler: () => null }); }
    catch { dupD2b = true; }
    check("注册表：D2b op 同名重复注册 throw（不静默覆盖）", dupD2b);
    // invokeOp 端到端：返回**裸领域值**（无 { ok } 信封）
    let wiredD2b = "unset";
    try { wiredD2b = await reg.invokeOp("agent.steps.approval", { id: "nope" }, { runs: { getRun: () => null } }); }
    catch (e) { wiredD2b = { err: String(e?.message ?? e) }; }
    check("注册表：agent.steps.approval 经 invokeOp 派发返回裸领域值（run 不存在 → null，无 { ok } 信封）",
        wiredD2b === null, `result=${JSON.stringify(wiredD2b)}`);
    /* ★ D2b：SSE **切成两段**（领域层产事件 / 传输层写响应）的进程内证据 —— 订阅计数 + 退订清理 */
    const kd = await import("./knowledge-domain.js");
    const ar = await import("./agent-runs.js");
    const runsReg = ar.createRunRegistry();
    const sh = runsReg.createRun({ title: "d2b-smoke-run" });
    const st = kd.openAgentRunStream({ runs: runsReg }, { id: sh.run.id, sinceSeq: 0 });
    check("注册表：openAgentRunStream 产出「状态 + 回放 + 订阅」三段（领域层不写响应，无 reply/raw）",
        !!st && typeof st.status === "function" && typeof st.replay === "function" && typeof st.subscribe === "function");
    sh.ev("step", { stepId: 1 });
    const replay1 = st.replay();
    check("注册表：openAgentRunStream 对**不存在**的 run 返回 null（404 由传输层映射）",
        kd.openAgentRunStream({ runs: runsReg }, { id: "missing", sinceSeq: 0 }) === null);
    const got = [];
    const unsub = st.subscribe((e) => got.push(e));
    check("注册表：SSE 订阅占位（进程内 subscribers.size === 1）", sh.run.subscribers.size === 1, `size=${sh.run.subscribers.size}`);
    sh.ev("step_end", { stepId: 1 });
    unsub();
    check("注册表：SSE ② 回放逐条 + 订阅去重（seq>sinceSeq）+ **退订后零残留监听**（客户端断开清理，进程内计数）",
        replay1.length === 1 && replay1[0].event === "step" && got.length === 1 && got[0].event === "step_end" && sh.run.subscribers.size === 0,
        `replay=${JSON.stringify(replay1.map((e) => e.event))}；推给订阅者=${JSON.stringify(got.map((e) => e.event))}；残留 size=${sh.run.subscribers.size}`);

    /* ★ 批次 C：memory / rules / embed 域 op 不变量（6 条） */
    const cOps = reg.listOps().filter((o) => Object.prototype.hasOwnProperty.call(MEM_EXPECT, o.name));
    const cNames = cOps.map((o) => o.name).sort();
    check("注册表：批次 C 登记 6 条 op（memory.* / rules.list / embed.*）",
        cNames.join(",") === Object.keys(MEM_EXPECT).sort().join(",") && cOps.length === 6, `names=[${cNames.join(",")}]`);
    check("注册表：C op 全部 REST-only 显式声明（无 MCP 传输 + source 含 `REST-only`）",
        cOps.length === 6 && cOps.every((o) => !o.transports?.mcp && String(o.risk?.source ?? "").includes("REST-only")),
        cOps.filter((o) => o.transports?.mcp || !String(o.risk?.source ?? "").includes("REST-only")).map((o) => `${o.name}(${o.risk?.source})`).join(", ") || `覆盖 ${cOps.length} 条`);
    check("注册表：C op 的 handler 全部非 null（已接线）",
        cOps.every((o) => typeof o.handler === "function"),
        cOps.filter((o) => typeof o.handler !== "function").map((o) => o.name).join(", ") || `覆盖 ${cOps.length} 条`);
    check("注册表：C op 的 REST 传输声明与路由逐条一致",
        cOps.every((o) => o.transports?.rest === MEM_EXPECT[o.name]),
        cOps.map((o) => `${o.name}→${o.transports?.rest}`).join(" | "));
    check("注册表：C op 的 kind 按读写区分（embed.vectors=read：纯计算、无持久化副作用）",
        cOps.filter((o) => o.kind === "read").map((o) => o.name).sort().join(",") === "embed.vectors,rules.list"
        && cOps.filter((o) => o.kind === "write").map((o) => o.name).sort().join(",") === "embed.recompute,memory.create,memory.delete,memory.update",
        cOps.map((o) => `${o.name}:${o.kind}`).join(" | "));
    check("注册表：C op 的 domain 按语义分布（memory 3 / rules 1 / embed 2）",
        cOps.filter((o) => o.domain === "memory").map((o) => o.name).sort().join(",") === "memory.create,memory.delete,memory.update"
        && cOps.filter((o) => o.domain === "rules").map((o) => o.name).join(",") === "rules.list"
        && cOps.filter((o) => o.domain === "embed").map((o) => o.name).sort().join(",") === "embed.recompute,embed.vectors",
        cOps.map((o) => `${o.name}:${o.domain}`).join(" | "));
    /* ★ 批次 C 的核心判定（必须由门禁守住，防日后被"顺手统一"回去）：
     *   实测 `POST /api/memory`(REST) 与 MCP `memory_write` **不是同一套语义**（身份来源 / 去重与冲突预检 /
     *   幂等键 / supersedes 修订链 / sector+sensitivity / 审计落点 / 输出形态 7 处实质差异，见 memory-domain.js 头），
     *   故**只迁 REST 一侧**、`server-reg-memory.js` 零改动 —— 不做伪统一。 */
    check("注册表：memory 域「非同源」判定被守住 —— 无任何 op 声明 mcp=memory_write（未做伪统一）",
        reg.listOps().every((o) => o.transports?.mcp !== "memory_write"),
        reg.listOps().filter((o) => o.transports?.mcp === "memory_write").map((o) => o.name).join(",") || "零 op 声明 mcp 传输为 memory_write");
    // 同名重复注册仍 throw（C op）
    let dupC = false;
    try { reg.defineOp({ name: "memory.create", domain: "memory", kind: "write", transports: { rest: "POST /api/memory" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具" }, handler: () => null }); }
    catch { dupC = true; }
    check("注册表：C op 同名重复注册 throw（不静默覆盖）", dupC);
    // invokeOp 端到端：返回**裸领域值**（无 { ok } 信封）
    const cDb = openDb(path.join(WS, "ops-memory-wire.db"));
    let wiredC = null;
    try { wiredC = await reg.invokeOp("rules.list", { limit: 50, status: "active" }, { db: cDb }); }
    catch (e) { wiredC = { err: String(e?.message ?? e) }; }
    cDb.close();
    check("注册表：rules.list 经 invokeOp 派发返回裸领域值（{ total, rows }，无 { ok } 信封）",
        wiredC?.total === 0 && Array.isArray(wiredC?.rows) && wiredC.ok === undefined && wiredC.err === undefined,
        `result=${JSON.stringify(wiredC).slice(0, 90)}`);

    /* ★ 批次 E1：cards 域 14 条 op 不变量 */
    const cardOps = reg.listOps().filter((o) => Object.prototype.hasOwnProperty.call(CARDS_EXPECT, o.name));
    check("注册表：批次 E1 登记 14 条 op（cards.*：CRUD/详情/事件/评论/链接/状态机/心跳）",
        cardOps.length === 14 && cardOps.map((o) => o.name).sort().join(",") === Object.keys(CARDS_EXPECT).sort().join(","),
        `names=[${cardOps.map((o) => o.name).join(",")}]`);
    check("注册表：cards op 全部 REST-only 显式声明（无 MCP 传输 + source 含 `REST-only`）",
        cardOps.length === 14 && cardOps.every((o) => !o.transports?.mcp && String(o.risk?.source ?? "").includes("REST-only")),
        cardOps.filter((o) => o.transports?.mcp || !String(o.risk?.source ?? "").includes("REST-only")).map((o) => `${o.name}(${o.risk?.source})`).join(", ") || `覆盖 ${cardOps.length} 条`);
    check("注册表：cards op 的 handler 全部非 null（已接线）",
        cardOps.every((o) => typeof o.handler === "function"),
        cardOps.filter((o) => typeof o.handler !== "function").map((o) => o.name).join(", ") || `覆盖 ${cardOps.length} 条`);
    check("注册表：cards op 的 REST 传输声明与路由逐条一致",
        cardOps.every((o) => o.transports?.rest === CARDS_EXPECT[o.name]),
        cardOps.map((o) => `${o.name}→${o.transports?.rest}`).join(" | "));
    check("注册表：cards op 的 kind 按读写区分（read 4 / write 10）",
        cardOps.filter((o) => o.kind === "read").map((o) => o.name).sort().join(",") === "cards.comments.list,cards.events.read,cards.list,cards.one"
        && cardOps.filter((o) => o.kind === "write").map((o) => o.name).sort().join(",") === "cards.accept,cards.claim,cards.comment.add,cards.create,cards.delete,cards.heartbeat,cards.link.add,cards.link.delete,cards.status,cards.update",
        cardOps.map((o) => `${o.name}:${o.kind}`).join(" | "));
    // 同名重复注册仍 throw（E1 op）
    let dupCards = false;
    try { reg.defineOp({ name: "cards.list", domain: "cards", kind: "read", transports: { rest: "GET /api/cards" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具" }, handler: () => null }); }
    catch { dupCards = true; }
    check("注册表：cards op 同名重复注册 throw（不静默覆盖）", dupCards);
    // invokeOp 端到端：cards 领域实例经注册表派发，返回**裸领域值**（无 { ok } 信封）
    const cardsDomMod = await import("./cards-domain.js");
    const wireCardsDb = openDb(path.join(WS, "ops-cards-wire.db"));
    const cardsDom = cardsDomMod.createCardsDomain({ db: wireCardsDb });
    let wiredCards = null;
    try { wiredCards = await reg.invokeOp("cards.list", {}, { db: wireCardsDb, cards: cardsDom }); }
    catch (e) { wiredCards = { err: String(e?.message ?? e) }; }
    wireCardsDb.close();
    check("注册表：cards.list 经 invokeOp 派发返回裸领域值（{ total, buckets, lanes }，无 { ok } 信封）",
        typeof wiredCards?.total === "number" && typeof wiredCards?.buckets === "object" && wiredCards.ok === undefined && wiredCards.err === undefined,
        `result=${JSON.stringify(wiredCards).slice(0, 90)}`);

    /* ★ 批次 E2a：工作台配置面 16 条 op 不变量 */
    const cards2Ops = reg.listOps().filter((o) => Object.prototype.hasOwnProperty.call(CARDS2_EXPECT, o.name));
    check("注册表：批次 E2a 登记 16 条 op（types/edges/profiles/positions/archive/retype）",
        cards2Ops.length === 16 && cards2Ops.map((o) => o.name).sort().join(",") === Object.keys(CARDS2_EXPECT).sort().join(","),
        `names=[${cards2Ops.map((o) => o.name).join(",")}]`);
    check("注册表：E2a op 全部 REST-only 显式声明 + handler 非空 + 传输声明逐条一致",
        cards2Ops.length === 16 && cards2Ops.every((o) => !o.transports?.mcp && String(o.risk?.source ?? "").includes("REST-only") && typeof o.handler === "function" && o.transports?.rest === CARDS2_EXPECT[o.name]),
        cards2Ops.filter((o) => o.transports?.mcp || !String(o.risk?.source ?? "").includes("REST-only") || typeof o.handler !== "function" || o.transports?.rest !== CARDS2_EXPECT[o.name]).map((o) => o.name).join(", ") || `覆盖 ${cards2Ops.length} 条`);
    let dupCards2 = false;
    try { reg.defineOp({ name: "cards.retype", domain: "cards", kind: "write", transports: { rest: "POST /api/cards/:id/retype" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具" }, handler: () => null }); }
    catch { dupCards2 = true; }
    check("注册表：E2a op 同名重复注册 throw（不静默覆盖）", dupCards2);

    // 重复注册 throw
    let dupThrew = false;
    try { reg.defineOp({ name: "task.next", domain: "task", kind: "read", transports: { mcp: "task_next" }, handler: () => null }); }
    catch { dupThrew = true; }
    check("注册表：同名重复注册 throw（不静默覆盖）", dupThrew);

    // invokeOp 对 handler===null 显式报错（不静默 undefined）
    reg.defineOp({ name: "smokeops.null", domain: "smokeops", kind: "read", transports: { rest: "GET /smoke/null" }, risk: { risk: "L0", gate: false, source: "REST-only：冒烟夹具（非 TOOL_RISK 阶梯）" }, handler: null });
    let nullErr = "";
    try { await reg.invokeOp("smokeops.null", {}); } catch (e) { nullErr = String(e?.message ?? e); }
    check("注册表：invokeOp 对 handler===null 显式报错", /尚未接线/.test(nullErr), `err=${nullErr.slice(0, 70)}`);
}

/* ── 主流程 ── */
try {
    fs.writeFileSync(path.join(WS, "agent-fpath.txt"), "ops-smoke\n", "utf8");

    const tn = await collectTaskNext();
    const tc = await collectTaskCreate();
    const lt = await collectListTools();
    const kb = await collectKnowledge();      // ★ 批次 D1：knowledge 域 7 条 REST 路由
    const ag = await collectAgent();          // ★ 批次 D2a：Agent 域 10 条 REST 路由
    const d2bA = await collectD2bLlm();       // ★ 批次 D2b：死端口 LLM 实例（LLM 失败路径 + 非 LLM CRUD）
    const d2bB = await collectD2bRun();       // ★ 批次 D2b：mock LLM 实例（真跑 run + SSE + 卡片收敛）
    const mem = await collectMemory();        // ★ 批次 C：memory 域 6 条 REST 路由（mock embeddings 实例）
    const memFake = await collectMemoryFakeEmbed(); // ★ 批次 C：fake 模式 /v1/embeddings 的 fail-closed 503
    const cards = await collectCards();       // ★ 批次 E1：cards 域 14 条 REST 路由（CRUD/状态机/链接）
    const current = { taskNext: tn, taskCreate: tc, listTools: lt, knowledge: kb, agent: ag, d2b: { llm: d2bA, run: d2bB }, memory: mem, memoryFake: memFake, cards };

    if (CAPTURE) {
        fs.writeFileSync(BASELINE, JSON.stringify({ capturedAt: new Date().toISOString(), ...current }, null, 2), "utf8");
        console.log(`== ops 冒烟 · 基线采集 ==`);
        console.log(`基线写入：${BASELINE}`);
        console.log(`task_next  sha256=${tn.sha256}  itemLines=${tn.itemLines}`);
        console.log(`task_create status=${tc.statusCode} sha256=${tc.sha256}`);
        console.log(`--list-tools count=${lt.count} exit=${lt.exit} sha256=${lt.sha256}`);
        console.log(`knowledge  ${kb.ok ? kb.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + kb.reason + ")"}`);
        console.log(`agent      ${ag.ok ? ag.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + ag.reason + ")"}`);
        console.log(`d2b-A      ${d2bA.ok ? d2bA.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + d2bA.reason + ")"}`);
        console.log(`d2b-B      ${d2bB.ok ? d2bB.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + d2bB.reason + ")"}`);
        console.log(`d2b-B sse  status=${d2bB.sse?.status ?? "-"} ct=${d2bB.sse?.contentType ?? "-"} names=[${(d2bB.sse?.names ?? []).join(",")}] ids=${JSON.stringify(d2bB.sse?.ids ?? [])}`);
        console.log(`d2b-B sse  keys=${JSON.stringify(d2bB.sse?.keys ?? [])}`);
        console.log(`d2b-B sse  payloads=${JSON.stringify(d2bB.sse?.payloads ?? [])}`);
        console.log(`memory     ${mem.ok ? mem.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + mem.reason + ")"}`);
        console.log(`memory-fake ${memFake.ok ? memFake.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + memFake.reason + ")"}`);
        console.log(`cards      ${cards.ok ? cards.probes.map((p) => `${p.name}=${p.status}/${p.sha256.slice(0, 8)}`).join(" ") : "SKIP(" + cards.reason + ")"}`);
        console.log(`cards 证据  ${JSON.stringify(cards.counts)}`);
        console.log(`memory 证据  ${JSON.stringify(mem.counts)}`);
        console.log(`\n== ops 冒烟：0 PASS / 0 FAIL / 0 SKIP（采集模式，不判定）==`);
        await killAllAndWait();
        await removeWs();
        process.exit(0);
    }

    console.log(`== ops 冒烟 · 比对模式 ==  基线=${BASELINE}\n`);

    /* ⑧-b：task_next 非空数据证据（排除「空库两边都空」的假绿） */
    check("⑧-b task_next 隔离 MCP 调用返回非空文本", tn.text.length > 0, `len=${tn.text.length}`);
    check("⑧-b task_next 输出条目数 ≥3（非空数据证据）", tn.itemLines >= 3, `含 # 条目=${tn.itemLines}（夹具 7 条任务）`);
    check("⑧-b task_next 三段结构齐（可做/阻塞/我在做）", /可做（/.test(tn.text) && /阻塞（/.test(tn.text) && /我在做/.test(tn.text));
    check("⑧-b task_next 含 as 身份段（as=codex）", tn.text.startsWith(`【task_next · as=${AS_ID}】`), tn.text.split("\n")[0]);

    /* 基线比对（缺失记 SKIP） */
    let base = null;
    try { base = upgradeExpectedKnowledgeSurface(JSON.parse(fs.readFileSync(BASELINE, "utf8"))); }
    catch { base = null; }
    if (!base) {
        skip("⑧-b task_next 输出逐字节一致（基线比对）", `基线文件不存在：${BASELINE}（改代码前需先跑 --capture；缺基线与缺环境同约定记 SKIP）`);
        skip("POST /api/task 响应逐字节一致（基线比对）", "基线缺失");
        skip("--list-tools 行 sha256 一致（基线比对）", "基线缺失");
    }
    else {
        check("⑧-b task_next 输出逐字节一致（sha256 + 原文）",
            tn.sha256 === base.taskNext?.sha256 && tn.text === base.taskNext?.text,
            `sha256 ${String(base.taskNext?.sha256).slice(0, 12)} → ${tn.sha256.slice(0, 12)}；首 120 字=${JSON.stringify(tn.text.slice(0, 120))}`);
        check("POST /api/task 响应逐字节一致（status + body）",
            tc.ok && tc.sha256 === base.taskCreate?.sha256 && tc.text === base.taskCreate?.text,
            `status=${tc.statusCode} sha256 ${String(base.taskCreate?.sha256).slice(0, 12)} → ${tc.sha256.slice(0, 12)}；body=${JSON.stringify(tc.text.slice(0, 120))}`);
        check("--list-tools 行逐字节一致（sha256）",
            lt.sha256 === base.listTools?.sha256 && lt.line === base.listTools?.line,
            `sha256 ${String(base.listTools?.sha256).slice(0, 12)} → ${lt.sha256.slice(0, 12)}`);
    }
    check("--list-tools 25项（2026-10-19 整合后）且exit=0", lt.count === 25 && lt.exit === 0, `count=${lt.count} exit=${lt.exit}`);
    check("POST /api/task 返回 200（隔离实例可用）", tc.ok && tc.statusCode === 200, `status=${tc.statusCode ?? tc.reason}`);

    /* ★ 批次 D1：knowledge 域 —— 非空数据证据（排除「空库两边都空」的假绿）+ 逐字节基线比对 */
    if (!kb.ok) {
        skip("⑧-D1 knowledge 探针（隔离实例未就绪）", kb.reason);
        skip("⑧-D1 knowledge 7 条路由逐字节一致（基线比对）", kb.reason);
    }
    else {
        const c = kb.counts;
        check("⑧-D1 夹具非空：notes 列表 ≥2 条", c.notesList >= 2, `GET /api/notes → notes=${c.notesList}`);
        check("⑧-D1 夹具非空：backlinks 四段全非空（linked/outgoing/unresolved/unlinked 各 ≥1）",
            c.blinked >= 1 && c.boutgoing >= 1 && c.bunresolved >= 1 && c.bunlinked >= 1,
            `linked=${c.blinked} outgoing=${c.boutgoing} unresolved=${c.bunresolved} unlinked=${c.bunlinked}`);
        check("⑧-D1 夹具非空：graph 节点 ≥2 + 边 ≥1", c.gnodes >= 2 && c.gedges >= 1, `nodes=${c.gnodes} edges=${c.gedges}`);
        check("⑧-D1 夹具非空：runbook recentDaemon ≥1 + recentExec ≥1", c.rdaemon >= 1 && c.rexec >= 1, `daemon=${c.rdaemon} exec=${c.rexec}`);
        check("⑧-D1 7 条路由全部返回期望状态（无 5xx）",
            kb.probes.every((p) => p.status >= 200 && p.status < 500),
            kb.probes.map((p) => `${p.name}:${p.status}`).join(" "));

        if (!base?.knowledge?.probes?.length) {
            skip("⑧-D1 knowledge 7 条路由逐字节一致（基线比对）",
                base ? "基线缺 knowledge 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            const bm = new Map(base.knowledge.probes.map((p) => [p.name, p]));
            for (const p of kb.probes) {
                const b = bm.get(p.name);
                check(`⑧-D1 ${p.name}（${p.route}）逐字节一致（status + body sha256）`,
                    !!b && p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                    b ? `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 100))}` : "基线缺该探针");
            }
        }
    }

    /* ★ 批次 D2a：Agent 域 10 条路由 —— 非空数据证据（排除「空库两边都空」的假绿）+ 逐字节基线比对 */
    if (!ag.ok) {
        skip("⑧-D2a agent 探针（隔离实例未就绪）", ag.reason);
        skip("⑧-D2a agent 10 条路由逐字节一致（基线比对）", ag.reason);
    }
    else {
        const c = ag.counts;
        check("⑧-D2a 夹具非空：agent 会话 ≥2 条", c.sessions >= 2, `GET /api/agent/sessions → sessions=${c.sessions}`);
        check("⑧-D2a 夹具非空：内存 run ≥1 条（POST /api/agent/runs 真建）", c.runs >= 1, `GET /api/agent/runs → total=${c.runs}；run 终态=${c.runStatus}`);
        check("⑧-D2a 夹具非空：导出 memories ≥1 行", c.exportMemories >= 1, `GET /api/export/memories → count=${c.exportMemories}`);
        check("⑧-D2a 夹具非空：导出 audit ≥1 行", c.exportAudit >= 1, `GET /api/export/audit → count=${c.exportAudit}`);
        check("⑧-D2a 10 条路由全部返回期望状态（无 5xx）",
            ag.probes.every((p) => p.status >= 200 && p.status < 500),
            ag.probes.map((p) => `${p.name}:${p.status}`).join(" "));

        if (!base?.agent?.probes?.length) {
            skip("⑧-D2a agent 10 条路由逐字节一致（基线比对）",
                base ? "基线缺 agent 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            const bm = new Map(base.agent.probes.map((p) => [p.name, p]));
            for (const p of ag.probes) {
                const b = bm.get(p.name);
                /* ★ 2026-10-16：agent.list（GET /api/agents）改结构化断言——该路由是**本机 agent 清单的环境镜像**，
                 *  逐字节比对注定随本机装/卸智能体抖动（实测 30 分钟内两次变化：smoke-ops agent.list 与
                 *  snapshot /api/agents 同步漂移；A/B 实证把本批文件换回 HEAD 后同样 FAIL，sha 逐字节相同）。
                 *  同 D2b SSE 先例：如实声明做不到逐字节，改证 status + 数组结构（maskAgentList 掩码保留）。 */
                if (p.name === "agent.list") {
                    let arr = null;
                    try { arr = JSON.parse(p.text).agents; } catch { /* 非 JSON 按 null */ }
                    check(`⑧-D2a ${p.name}（${p.route}）结构一致（status + agents 数组；环境镜像路由不做 body 基线比对）`,
                        p.status === 200 && Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "string"),
                        `status=${p.status} agents=${Array.isArray(arr) ? arr.length : "非数组"}`);
                    continue;
                }
                check(`⑧-D2a ${p.name}（${p.route}）逐字节一致（status + body sha256）`,
                    !!b && p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                    b ? `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 100))}` : "基线缺该探针");
            }
        }
    }

    /* ★ 批次 D2b-A：死端口 LLM 实例 —— LLM 路由**确定性失败路径**逐字节 + 非 LLM 路由逐字节 + 非空证据 */
    if (!d2bA.ok) {
        skip("⑧-D2b-A 探针（隔离实例未就绪）", d2bA.reason);
        skip("⑧-D2b-A 8 条路由逐字节一致（基线比对）", d2bA.reason);
    }
    else {
        const c = d2bA.counts;
        check("⑧-D2b-A 夹具非空：agent 会话 ≥2 条（种子）", c.sessionsSeed >= 2, `种子会话=${c.sessionsSeed}；CRUD 往返后=${c.sessionsAfter}`);
        check("⑧-D2b-A LLM 路由走**确定性失败路径**（chat/plan/summarize 全 502）",
            c.chatStatus === 502 && c.planStatus === 502 && c.summarizeStatus === 502,
            `chat=${c.chatStatus} plan=${c.planStatus} summarize=${c.summarizeStatus}`);
        check("⑧-D2b-A chat 失败文案含死端口端点提示（确定性，锚定 LLM 端点）",
            /agent 执行失败：/.test(c.chatText) && c.chatText.includes("http://127.0.0.1:1/v1"),
            JSON.stringify(c.chatText.slice(0, 160)));
        check("⑧-D2b-A 非 LLM 路由正常返回（compact 200 + 压到 keepRecent 条 + mcp.restart 工具计数）",
            c.compactStatus === 200 && c.compactAfter === 2 && (c.mcpToolCount ?? 0) > 0,
            `compact=${c.compactStatus}/${c.compactAfter}；mcp.restart toolCount=${c.mcpToolCount}`);
        if (!base?.d2b?.llm?.probes?.length) {
            skip("⑧-D2b-A 8 条路由逐字节一致（基线比对）", base ? "基线缺 d2b.llm 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            const bm = new Map(base.d2b.llm.probes.map((p) => [p.name, p]));
            for (const p of d2bA.probes) {
                const b = bm.get(p.name);
                check(`⑧-D2b-A ${p.name}（${p.route}）逐字节一致（status + body sha256）`,
                    !!b && p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                    b ? `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 100))}` : "基线缺该探针");
            }
        }
    }

    /* ★ 批次 D2b-B：mock LLM 实例 —— 真跑 run + 副作用 + 逐字节 + SSE 结构化 */
    if (!d2bB.ok) {
        skip("⑧-D2b-B 探针（隔离实例未就绪）", d2bB.reason);
        skip("⑧-D2b-B 路由逐字节一致（基线比对）", d2bB.reason);
        skip("⑧-D2b-B SSE 结构化一致（基线比对）", d2bB.reason);
    }
    else {
        const c = d2bB.counts;
        check("⑧-D2b-B 夹具非空：真跑 run 走到终态 done + 内存 run ≥1", c.runStatus === "done" && c.runsTotal >= 1, `status=${c.runStatus}；GET /api/agent/runs total=${c.runsTotal}`);
        check("⑧-D2b-B 夹具非空：run 步骤 ≥2 且含 ≥1 个带写前快照的步骤（rollback 前置）", c.steps >= 2 && c.diffSteps >= 1, `steps=${c.steps} hasDiff=${c.diffSteps} toolCalls=${c.chainToolCalls}`);
        check("⑧-D2b-B 副作用：建 run 追加会话消息 1→3（agent_sessions 真落库）", c.sessionMsgs === 3 && c.sessMsgs === 3, `库里=${c.sessionMsgs} HTTP=${c.sessMsgs}`);
        check("⑧-D2b-B 副作用：rollback 把快照写回目标文件（restoredBytes=0 + nowMatchesSnapshot=true + 文件被清空）",
            c.rollback?.nowMatchesSnapshot === true && c.rollback?.restoredBytes === 0 && c.rollbackTarget === "",
            `resp=${JSON.stringify(c.rollback)}；文件内容=${JSON.stringify(c.rollbackTarget)}`);
        check("⑧-D2b-B 夹具非空：artifact 文件可读（预置 data/artifacts，非空）", c.artifactBytes > 0, `bytes=${c.artifactBytes}`);
        check("⑧-D2b-B 副作用：completeDeps 置既有依赖卡 done + 建 1 条新前置卡 + remaining 清空",
            c.depStatus === "done" && c.createdCards.length === 1 && c.remaining.length === 0 && c.completed.length === 1,
            `completed=${JSON.stringify(c.completed)} created=${JSON.stringify(c.createdCards)} remaining=${JSON.stringify(c.remaining)} depStatus=${c.depStatus} cards=${c.cardCount}`);
        check("⑧-D2b-B abort：running 态 run 中止返回 aborted（排队/运行态可中止）", c.abortStatus === "aborted", `status=${c.abortStatus}`);
        if (!base?.d2b?.run?.probes?.length) {
            skip("⑧-D2b-B 路由逐字节一致（基线比对）", base ? "基线缺 d2b.run 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            const bm = new Map(base.d2b.run.probes.map((p) => [p.name, p]));
            for (const p of d2bB.probes) {
                const b = bm.get(p.name);
                check(`⑧-D2b-B ${p.name}（${p.route}）逐字节一致（status + body sha256）`,
                    !!b && p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                    b ? `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 110))}` : "基线缺该探针");
            }
        }
        /* SSE —— ★ 如实声明：**做不到逐字节**；这里证到的是 ①事件类型序列 ②每事件 data 的键集合
         *  ③掩码后逐条载荷 与基线一致（结构/载荷恒等），**未证到**原始字节恒等。 */
        const s = d2bB.sse, b = base?.d2b?.run?.sse;
        if (!s) {
            skip("⑧-D2b-B SSE 结构化一致（基线比对）", "未取到 SSE 回放（实例未就绪或探针失败）");
        }
        else if (!b) {
            skip("⑧-D2b-B SSE 结构化一致（基线比对）", base ? "基线缺 d2b.run.sse 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            check("⑧-D2b-B SSE 响应面一致（status + content-type=text/event-stream）",
                s.status === b.status && s.contentType === b.contentType && /text\/event-stream/.test(s.contentType),
                `status=${s.status} ct=${s.contentType}`);
            check("⑧-D2b-B SSE ① 事件类型序列逐条一致（event 名序列）",
                JSON.stringify(s.names) === JSON.stringify(b.names),
                `baseline=[${(b.names ?? []).join(",")}] current=[${s.names.join(",")}]`);
            check("⑧-D2b-B SSE ① 每事件 data 的 **JSON 键集合** 逐条一致",
                JSON.stringify(s.keys) === JSON.stringify(b.keys),
                JSON.stringify(s.keys));
            check("⑧-D2b-B SSE ③ 掩码后**逐条载荷**一致（seq/t/runId/elapsedMs/estimatedTokens 占位）",
                JSON.stringify(s.payloads) === JSON.stringify(b.payloads),
                JSON.stringify(s.payloads).slice(0, 200));
            check("⑧-D2b-B SSE ids 为 1..N 严格递增（回放窗口自证，且 id 序列与基线一致）",
                JSON.stringify(s.ids) === JSON.stringify(b.ids) && s.ids.every((v, i) => v === i + 1),
                `ids=${JSON.stringify(s.ids)}`);
            check("⑧-D2b-B SSE ④ 归一后不含未掩码的时间戳/随机 runId（无 13 位 epoch、无 r_xxx_n_hex4）",
                !/\d{13}/.test(JSON.stringify(s.payloads)) && !/r_[0-9a-z]+_\d+_[0-9a-f]{4}/.test(JSON.stringify(s.payloads)),
                `payloads 首条=${JSON.stringify(s.payloads[0] ?? null).slice(0, 120)}`);
            check("⑧-D2b-B SSE ② 首个事件在容差内到达（<8000ms；★ 本路由**无心跳定时器**，故无「心跳间隔」口径）",
                c.liveFirstMs != null && c.liveFirstMs < 8000,
                `首个事件延迟=${c.liveFirstMs}ms —— ★ 实测为**回放窗口**命中（run 在 getAgentMcp+mcp.tools() 之后即发首个 tool_face 事件，客户端连上时该事件多已落队列 → 回放秒达）；**真正的实时推送**由下面进程内订阅计数用例证明`);
            check("⑧-D2b-B SSE ② 客户端断开后服务端 run 仍走到终态 + 服务仍健康",
                c.liveStatus && c.liveStatus !== "running" && c.liveStatus !== "queued" && c.healthStatus === 200,
                `断开后 live run 终态=${c.liveStatus}；/health=${c.healthStatus}`);
        }
    }

    /* ★ 批次 C：memory 域 6 条路由 —— 非空数据证据（排除「空库两边都空」的假绿）+ 副作用实证 + 逐字节基线比对 */
    if (!mem.ok) {
        skip("⑧-C memory 探针（隔离实例未就绪）", mem.reason);
        skip("⑧-C memory 路由逐字节一致（基线比对）", mem.reason);
    }
    else {
        const c = mem.counts;
        check("⑧-C 夹具非空：GET /api/rules 返回 rule ≥1 条", c.rules >= 1, `rules=${c.rules}（夹具 1 条）`);
        check("⑧-C 夹具非空：POST /v1/embeddings 返回 2 条向量且维度 = 8（mock 端点）",
            c.embedRows === 2 && c.embedDim === 8, `rows=${c.embedRows} dim=${c.embedDim}`);
        check("⑧-C 副作用：recompute 真补算了 1 条无向量记忆（done=1 / failed=0 / pending=0）",
            c.recompute.done === 1 && c.recompute.failed === 0 && c.recompute.pending === 0, JSON.stringify(c.recompute));
        check("⑧-C 副作用：PUT(inject=1) 落库并被规则页读出（0 → 1）",
            c.injectBefore === 0 && c.injectInList === 1 && c.ruleInject === 1,
            `列表前=${c.injectBefore} 列表后=${c.injectInList} 库内=${c.ruleInject}`);
        check("⑧-C 副作用：PUT(inject=1) 触发 autoSyncRules 且真写了 7 个注入落点（落点已隔离到临时家目录，未碰用户真实规则文件）",
            c.syncWritten === SYNC_TARGET_RELS.length,
            `命中 ${c.syncWritten}/${SYNC_TARGET_RELS.length} 个落点（含 MEMORYOS-SYNC-RULES-START 段）`);
        check("⑧-C 副作用：DELETE 是软删（行仍在、status=rejected），非物理删除 + 三条 create 真落库",
            c.keepStatus === "rejected" && c.rowCount === 6, `keepStatus=${c.keepStatus} 库内行数=${c.rowCount}（夹具 3 + 新建 3）`);
        check("⑧-C 副作用：PUT 编辑正文把该行向量标记 stale（daemon 待补算）", c.staleLeft >= 1, `staleLeft=${c.staleLeft}`);
        check(`⑧-C ${mem.probes.length} 条探针全部返回 200/400/404（无 5xx；400/404 属传输层协议校验路径）`,
            mem.probes.every((p) => [200, 400, 404].includes(p.status)), c.probeStatuses);
        if (!base?.memory?.probes?.length) {
            skip("⑧-C memory 路由逐字节一致（基线比对）",
                base ? "基线缺 memory 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            const bm = new Map(base.memory.probes.map((p) => [p.name, p]));
            for (const p of mem.probes) {
                const b = bm.get(p.name);
                check(`⑧-C ${p.name}（${p.route}）逐字节一致（status + body sha256）`,
                    !!b && p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                    b ? `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 100))}` : "基线缺该探针");
            }
        }
    }
    /* ★ 批次 C-B：EMBED_MODE=fake 实例 —— /v1/embeddings 的 fail-closed 503 契约（⑥纪律的代码落点） */
    if (!memFake.ok) {
        skip("⑧-C-B fake 模式 /v1/embeddings（隔离实例未就绪）", memFake.reason);
    }
    else {
        const p = memFake.probes[0], c = memFake.counts;
        check("⑧-C-B fake 模式：/v1/embeddings 按 fail-closed 拒绝产出伪向量（503 embedder-fake + hint）",
            c.status === 503 && c.error === "embedder-fake" && c.hasHint === true,
            `status=${c.status} error=${c.error} hint=${c.hasHint}`);
        const b = base?.memoryFake?.probes?.[0];
        if (!b)
            skip("⑧-C-B fake 模式 503 响应逐字节一致（基线比对）",
                base ? "基线缺 memoryFake 段（旧基线，需重跑 --capture）" : "基线缺失");
        else
            check("⑧-C-B fake 模式 503 响应逐字节一致（status + body sha256）",
                p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 100))}`);
    }

    /* ★ 批次 E1：cards 域 14 条路由 —— 非空数据证据 + 协议校验路径 + 逐字节基线比对 */
    if (!cards.ok) {
        skip("⑧-E1 cards 探针（隔离实例未就绪）", cards.reason);
        skip("⑧-E1 cards 路由逐字节一致（基线比对）", cards.reason);
    }
    else {
        const c = cards.counts;
        check("⑧-E1 夹具非空：GET /api/cards 列表 total ≥6（夹具 6 张在板；已归档卡被默认过滤，建卡探针在只读探针之后）", c.listTotal >= 6, `total=${c.listTotal}`);
        check("⑧-E1 夹具非空：buckets 十态桶齐备", c.listBuckets >= 10, `buckets=${c.listBuckets}`);
        check("⑧-E1 夹具非空：卡片详情含 meta 解析 + links_out 字段（无 5xx）",
            c.oneTitle.includes("E1冒烟卡A") && Array.isArray((cards.probes.find((p) => p.name === "cards.one") ? JSON.parse(cards.probes.find((p) => p.name === "cards.one").text) : {}).card?.links_out),
            `title=${c.oneTitle} links_out=${c.oneLinks}`);
        check(`⑧-E1 ${cards.probes.length} 条探针全部返回 200/400/404/409（无 5xx；400/404/409 属传输层协议校验与冲突路径）`,
            cards.probes.every((p) => [200, 400, 404, 409].includes(p.status)),
            cards.probes.map((p) => `${p.name}:${p.status}`).join(" "));
        check("⑧-E1 收养修复回归：建卡非法状态 400（C-11）+ 超长标题 400（C-04）+ 重名软提示 duplicate（C-06）+ strict_dup 409",
            ["cards.create.badstatus", "cards.create.longtitle", "cards.create.dup", "cards.create.strict"].every((n) => {
                const p = cards.probes.find((x) => x.name === n);
                return p && (n === "cards.create.dup" ? p.status === 200 && p.text.includes("duplicate") : n === "cards.create.strict" ? p.status === 409 : p.status === 400);
            }),
            cards.probes.filter((p) => p.name.startsWith("cards.create.")).map((p) => `${p.name}=${p.status}`).join(" "));
        if (!base?.cards?.probes?.length) {
            skip("⑧-E1 cards 路由逐字节一致（基线比对）",
                base ? "基线缺 cards 段（旧基线，需重跑 --capture）" : "基线缺失");
        }
        else {
            const bm = new Map(base.cards.probes.map((p) => [p.name, p]));
            for (const p of cards.probes) {
                const b = bm.get(p.name);
                check(`⑧-E1 ${p.name}（${p.route}）逐字节一致（status + body sha256）`,
                    !!b && p.status === b.status && p.sha256 === b.sha256 && p.text === b.text,
                    b ? `status ${b.status}→${p.status}；sha256 ${String(b.sha256).slice(0, 12)}→${p.sha256.slice(0, 12)}；body=${JSON.stringify(p.text.slice(0, 100))}` : "基线缺该探针");
            }
        }
    }

    await checkRegistryInvariants();
}
catch (e) {
    failed++;
    console.log(`FAIL  探针自身异常：${e instanceof Error ? e.stack : String(e)}`);
}
finally {
    await killAllAndWait();
    await removeWs();
}

console.log(`\n== ops 冒烟：${passed} PASS / ${failed} FAIL / ${skipped} SKIP ==`);
process.exit(failed ? 1 : 0);
