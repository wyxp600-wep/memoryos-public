/**
 * MemoryOS — 统一操作注册表（架构重构第 2 条「统一操作注册表，消除双传输层」· 批次 A · 2026-10-14）
 *
 * ── 病灶 ────────────────────────────────────────────────────────────
 *   185 条 REST 路由（16 个 dashboard-reg-*.js）与 29 个 MCP 工具各自实现业务逻辑：同一域的操作
 *   被写两遍（已取证：`GET /api/tasks` ↔ MCP `task_next` 各写一份「任务头解析 + 状态归一 + 依赖判定」）。
 *
 * ── 目标形态 ────────────────────────────────────────────────────────
 *   本层是**领域逻辑的单一真相源**：每条操作（op）在此登记一次 —— 名称 / 域 / 读写 / 风险 /
 *   入参 schema / 领域 handler / 暴露传输层。MCP 工具与 REST 路由此后只做**薄适配**
 *   （解析入参 → invokeOp → 按各自协议包装输出），不再各自重写领域逻辑。
 *
 * ── ★ handler 契约（本层核心，不可动摇）────────────────────────────
 *     handler: (ctx, args) => result
 *   返回值是**领域返回值**：
 *     · **不含** MCP 形 `{ content: [...] }`、不含任何 MCP 文案；
 *     · **不含** HTTP 状态码 / reply 对象 / `{ ok }` 信封。
 *   传输层各自的包装（MCP 文案、HTTP 200/400、/ops 信封）由各适配器负责，本层只产出裸领域结果。
 *   handler 允许为 `null` = **元数据已登记、领域函数尚未接线**（invokeOp 会显式报错，绝不静默返回 undefined）。
 *
 * ── ★ risk 口径（复用既有单一真相源，不另造枚举）────────────────────
 *   分两条口径（批次 B 定死，实现见 normalizeRisk）：
 *     · 有 MCP 传输的 op：risk **必须**从 exec-tools.js 的 `TOOL_RISK` 派生（键 = op.transports.mcp → op.name）；
 *       显式声明 risk 一律 **throw**（防止绕过既有 TOOL_RISK fail-closed 落码）。两级皆取不到时 fail-closed 回落 {L4, required}。
 *     · 无 MCP 传输的 REST-only op：**必须显式声明** risk（含 source）—— 不走 agent 执行阶梯，门禁由全局令牌 + RESTRICTED 承担。
 *
 * ── ★ 重复注册即报错 ─────────────────────────────────────────────
 *   同名 op 二次 defineOp 直接 throw。静默覆盖会让「同名两条各写一份逻辑」重新长回来且无人察觉 ——
 *   这正是本层要根治的病灶，故以硬失败守住唯一性。
 *
 * ── ★ 接线进度 ──────────────────────────────────────────────────
 *   批次 A（2026-10-14）：登记元数据 + 抽出 REST 看板领域函数（零调用方，零行为变更）。
 *   批次 B（2026-10-15）：把 **task 域**接线 —— MCP `task_next`（server-reg-task.js）与 REST `POST /api/task`
 *   （dashboard-reg-memory.js）改为薄适配（invokeOp → 按各自协议渲染/包装），领域计算收进 task-domain.js。
 *   批次 D1（2026-10-15）：把 **knowledge 域**（知识库 + 只读查询）接线 —— REST 7 条路由
 *   （dashboard-reg-knowledge.js 的 `/api/notes` CRUD、`/api/backlinks`、`/api/graph`、`/api/runbook`）改为薄适配
 *   （invokeOp → 按原协议包装），领域计算收进 knowledge-domain.js。这 7 条**均无 MCP 传输** ⇒ REST-only 显式声明。
 *   批次 D2a（2026-10-15）：把 **Agent 域只读 + 简单配置写 / 导出** 接线 —— REST 10 条路由
 *   （`/api/agents`、`/api/agent/status`、`/api/agent/runs`、`/api/agent/runs/:id`、`/api/agent/sessions`、
 *   `/api/agent/sessions/:id`、`/api/export/memories`、`/api/export/audit`、`POST /api/agent/config`、
 *   `POST /api/agent/exec-toggle`）改为薄适配，领域计算收进 knowledge-domain.js。这 10 条**均无 MCP 传输**
 *   ⇒ REST-only 显式声明；domain 记 `agent` / `export`（与 D1 的 `knowledge` 分开，不动 D1 的「7 条」口径）。
 *   批次 D2b（2026-10-15）：把 **Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛** 接线 —— REST 17 条路由
 *   （`POST /api/agent/chat`、`POST /api/agent/runs`、`GET /api/agent/runs/:id/stream`、`POST .../abort`、
 *   `GET .../chain`、`POST .../steps/:sid/rollback`、`GET .../steps/:sid/output`、`POST .../steps/:sid/approval`、
 *   `/api/agent/sessions` CRUD + `/:id/compact` + `/:id/summarize`、`GET /api/artifacts/:id`、
 *   `POST /api/agent/mcp/restart`、`POST /api/agent/plan/decompose`、`POST /api/cards/:id/complete-deps`）
 *   改为薄适配，领域计算收进 knowledge-domain.js（含 `createAgentRuntime` run 编排工厂）。
 *   这 17 条**均无 MCP 传输** ⇒ REST-only 显式声明；domain 记 `agent`（15）/ `plan`（1）/ `task`（1）。
 *   批次 C（2026-10-15）：把 **memory 域**接线 —— REST 6 条路由（`POST /api/memory`（人工建库）、
 *   `PUT`/`DELETE /api/memory/:id`、`GET /api/rules`、`POST /v1/embeddings`、`POST /api/embed/recompute/:id`）
 *   改为薄适配，领域计算收进 memory-domain.js。这 6 条**均无 MCP 传输** ⇒ REST-only 显式声明；
 *   domain 记 `memory`（3）/ `rules`（1）/ `embed`（2）。
 *   ★ 判定 `POST /api/memory` ↔ MCP `memory_write` **非同源**（7 处实质差异见 memory-domain.js 文件头）⇒ 不合并、只迁一侧。
 *   其余域（obsidian / cards / 其它 dashboard-reg-*.js）**未接线**，待后续批次。
 *   `listOps()` 供后续 `/ops/catalog` 对接（当前 /ops/catalog 仍读 server-tools.js 的工具面，未改）。
 */
import { TOOL_RISK } from "./exec-tools.js";
import { parseTaskRows, bucketizeTaskRows, nextTasks, createTaskMemory } from "./task-domain.js";
// ★ 批次 D1：knowledge 域领域函数（笔记 CRUD / 反向链接 / 知识图谱 / 事件手册）
import { listNotes, createNote, updateNote, deleteNote, readBacklinks, readGraph, readRunbook } from "./knowledge-domain.js";
// ★ 批次 D2a：Agent 域只读 + 简单配置写 / 导出（领域函数同住 knowledge-domain.js）
import { listAgents, readAgentStatus, listAgentRuns, readAgentRun, listAgentSessions, readAgentSession, exportMemories, exportAudit, setAgentConfig, toggleExecFace } from "./knowledge-domain.js";
// ★ 批次 D2b：Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛（领域函数同住 knowledge-domain.js）
import {
    agentChat, createAgentRun, abortAgentRun, readAgentRunChain, readAgentStepOutput, readAgentStepApproval,
    rollbackAgentStep, openAgentRunStream, createAgentSession, updateAgentSession, removeAgentSession,
    compactAgentSessionOp, summarizeAgentSession, readArtifactFile, restartAgentMcp, decomposePlan, completeCardDeps,
} from "./knowledge-domain.js";
// ★ 批次 C（2026-10-15）：memory 域领域函数（人工建库 / 编辑 / 软删 / 规则列表 / 嵌入端点 / 向量补算）
import { createManualMemory, updateMemoryRow, rejectMemoryRow, listRules, serveEmbeddings, recomputeEmbeddings } from "./memory-domain.js";

/** name → op 记录（defineOp 唯一入口；重复注册见下） */
const OPS = new Map();

/**
 * 风险解析 —— 分两条口径（批次 B 定死，勿混用）：
 *
 *  ① **有 MCP 传输**的 op：risk **必须**从 exec-tools.js 的 TOOL_RISK 派生（键 = op.transports.mcp，回落 op.name）。
 *     显式声明 risk 一律 **throw** —— 理由：TOOL_RISK 是「agent 执行阶梯」的单一真相源，且注入端已 fail-closed
 *     （漏登记只会多审批、绝不静默放行）；若允许在注册表里用显式声明覆盖它，就等于开了一条**绕过 TOOL_RISK 落码**的后门，
 *     既有不变式会被打穿。故不静默忽略，而是硬失败（与「重复注册即 throw」同一纪律）。
 *     两级皆取不到时，按既有 fail-closed 口径回落 {L4, required}。
 *
 *  ② **无 MCP 传输**的 REST-only op（如 tasks.list / task.create）：**必须显式声明 risk**（含 source）。
 *     这类 op 根本不走 agent 执行阶梯 —— 门禁由既有**全局访问令牌 + RESTRICTED** 承担；risk 值仅作登记口径
 *     （本层无消费方），source 须写明来源。旧实现在此按 TOOL_RISK 取不到而 fail-closed 回落 L4/required，
 *     属**口径错配**（把一个非 agent 执行面的操作谎报为最高危），本批据此纠正。
 *
 * @returns 冻结的 {risk, gate, source}
 */
function normalizeRisk(op, transports) {
    if (transports.mcp) {
        if (op.risk != null)
            throw new Error(`defineOp: 「${op.name}」有 MCP 传输 —— risk 必须从 TOOL_RISK 派生，不允许显式声明（声明会绕过既有 TOOL_RISK fail-closed 落码）`);
        const mcpName = transports.mcp;
        const key = TOOL_RISK[mcpName] ? mcpName : (TOOL_RISK[op.name] ? op.name : null);
        if (key)
            return Object.freeze({ risk: TOOL_RISK[key].risk, gate: TOOL_RISK[key].gate, source: `TOOL_RISK.${key}` });
        return Object.freeze({ risk: "L4", gate: true, source: "fail-closed(TOOL_RISK 无此条目)" });
    }
    const r = op.risk;
    if (!r || typeof r !== "object")
        throw new Error(`defineOp: 「${op.name}」是 REST-only（无 MCP 传输）—— 必须显式声明 risk（{risk, gate, source}）`);
    if (typeof r.risk !== "string" || typeof r.gate !== "boolean" || typeof r.source !== "string" || !r.source.includes("REST-only"))
        throw new Error(`defineOp: 「${op.name}」的 risk 声明不合法：须含 {risk, gate, source}，且 source 须注明「REST-only：门禁由既有全局令牌 + RESTRICTED 承担，不属 TOOL_RISK 的 agent 执行阶梯」`);
    return Object.freeze({ risk: r.risk, gate: r.gate, source: r.source });
}

/** REST-only op 的 risk 声明（非 TOOL_RISK 阶梯；门禁走全局令牌 + RESTRICTED）。risk 值仅作登记口径，无消费方。 */
const REST_ONLY_RISK = Object.freeze({
    risk: "L0", gate: false,
    source: "REST-only：门禁由既有全局令牌 + RESTRICTED 承担，不属 TOOL_RISK 的 agent 执行阶梯",
});

/**
 * 登记一条操作。
 * @param {{name:string, domain:string, kind:"read"|"write", risk?:object,
 *          inputSchema?:any, handler:((ctx:any,args:any)=>any)|null,
 *          transports?:{mcp?:string, rest?:string}}} op
 * @returns 冻结后的 op 记录
 */
export function defineOp(op) {
    if (!op || typeof op !== "object")
        throw new TypeError("defineOp: op 必须是对象");
    const name = String(op.name ?? "").trim();
    if (!name)
        throw new Error("defineOp: name 必填");
    if (OPS.has(name))
        throw new Error(`defineOp: 操作「${name}」已注册 —— 重复注册被拒（防同名两份领域逻辑）`);
    const domain = String(op.domain ?? "").trim();
    if (!domain)
        throw new Error(`defineOp: 「${name}」缺 domain`);
    if (op.kind !== "read" && op.kind !== "write")
        throw new Error(`defineOp: 「${name}」的 kind 必须是 read|write`);
    if (op.handler != null && typeof op.handler !== "function")
        throw new Error(`defineOp: 「${name}」的 handler 必须是函数或 null（(ctx,args)=>result）`);
    const transports = op.transports && typeof op.transports === "object" ? { ...op.transports } : {};
    const rec = Object.freeze({
        name,
        domain,
        kind: op.kind,
        risk: normalizeRisk(op, transports),
        inputSchema: op.inputSchema ?? null,
        handler: op.handler ?? null,
        transports: Object.freeze(transports),
    });
    OPS.set(name, rec);
    return rec;
}

/** 取一条 op（不存在返回 null） */
export function getOp(name) {
    return OPS.get(String(name)) ?? null;
}

/** 列出 op（可按 domain 过滤）；返回冻结记录数组，handler 不被复制 */
export function listOps({ domain } = {}) {
    const all = [...OPS.values()];
    return domain ? all.filter((o) => o.domain === domain) : all;
}

/** 派发一条 op：返回 handler 的**裸领域返回值**（不做任何协议包装） */
export async function invokeOp(name, args, ctx) {
    const op = OPS.get(String(name));
    if (!op)
        throw new Error(`invokeOp: 未知操作「${name}」`);
    if (!op.handler)
        throw new Error(`invokeOp: 操作「${name}」尚未接线（本批只登记元数据，handler 待后续批次回填）`);
    return await op.handler(ctx, args);
}

/* ── 登记（批次 A 只登记元数据 → 批次 B 接线 + 补齐口径）────────────────
 * `tasks.list`：REST `GET /api/tasks` 的领域函数（task-domain.js）——看板行数组 + 七态分桶。
 *              REST-only ⇒ 显式声明 risk（修正 A 批按 TOOL_RISK 取不到而 fail-closed 的**口径错配**）。
 * `task.next` ：MCP `task_next`（server-reg-task.js）——批次 B 接线到 task-domain.js 的 nextTasks（领域计算），
 *              MCP 侧只做薄适配：invokeOp → renderTaskNextText。risk 从 TOOL_RISK.task_next 派生（不显式声明）。
 * `task.create`：REST `POST /api/task`（dashboard-reg-memory.js）——批次 B 迁入 task-domain.js 的 createTaskMemory。
 *              REST-only ⇒ 显式声明 risk（同上口径）。
 * 实测 `task_next` 与 REST `GET /api/tasks` **非同一套语义**（6 处实质差异见 task-domain.js 头），故两条 op 各自独立、不合并。 */
defineOp({
    name: "tasks.list",
    domain: "task",
    kind: "read",
    transports: { rest: "GET /api/tasks" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参仅 { limit?, status? }（由 REST 适配器解析）
    handler: (ctx, args = {}) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 100) || 100, 1), 500);
        const status = String(args.status ?? "active").trim() || "active";
        return bucketizeTaskRows(parseTaskRows(ctx.db, { limit, status }));
    },
});

defineOp({
    name: "task.next",
    domain: "task",
    kind: "read",
    transports: { mcp: "task_next" },
    inputSchema: null, // 入参 schema 仍由 server-reg-task.js 的 zod 定义持有
    handler: nextTasks, // 批次 B 接线：领域计算在 task-domain.js，MCP 侧仅 renderTaskNextText
});

defineOp({
    name: "task.create",
    domain: "task",
    kind: "write",
    transports: { rest: "POST /api/task" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 schema 由 REST 适配器（dashboard-reg-memory.js）校验
    handler: createTaskMemory,
});

/* ── 批次 D1（2026-10-15）：knowledge 域（知识库 + 只读查询）──────────────────
 * REST `GET/POST /api/notes`、`PUT/DELETE /api/notes/:id`、`GET /api/backlinks`、`GET /api/graph`、
 * `GET /api/runbook`（dashboard-reg-knowledge.js）的领域逻辑收进 knowledge-domain.js。
 * 这 7 条**均无 MCP 传输**（纯 REST 看板/知识库面）⇒ REST-only：risk 一律**显式声明**（含 source），
 * 不走 TOOL_RISK 的 agent 执行阶梯；门禁由既有全局访问令牌 + RESTRICTED 承担。
 * `GET /api/notes` 兼作单条详情（`?id=`）与列表 —— 同一路由、同一领域函数，故仍只登记为一条 `notes.list`。
 * 入参校验（vault/title 必填、内容非空、id 非法）与 RESTRICTED / reply.code(404|400|500) 属 HTTP 协议行为，
 * 全部留在传输层；故 inputSchema 为 null（由 REST 适配器校验）。 */
defineOp({
    name: "notes.list",
    domain: "knowledge",
    kind: "read",
    transports: { rest: "GET /api/notes" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参仅 { id?, vault?, origin? }（由 REST 适配器解析）
    handler: listNotes,
});

defineOp({
    name: "notes.create",
    domain: "knowledge",
    kind: "write",
    transports: { rest: "POST /api/notes" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 schema 由 REST 适配器（dashboard-reg-knowledge.js）校验
    handler: createNote,
});

defineOp({
    name: "notes.update",
    domain: "knowledge",
    kind: "write",
    transports: { rest: "PUT /api/notes/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, content, type? }；返回 null=不存在、{empty:true}=内容为空（状态码由传输层映射）
    handler: updateNote,
});

defineOp({
    name: "notes.delete",
    domain: "knowledge",
    kind: "write",
    transports: { rest: "DELETE /api/notes/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；返回 null=不存在（404 由传输层映射）
    handler: deleteNote,
});

defineOp({
    name: "notes.backlinks",
    domain: "knowledge",
    kind: "read",
    transports: { rest: "GET /api/backlinks" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { kind?, id }；`id 必填` 400 由传输层先校验
    handler: readBacklinks,
});

defineOp({
    name: "notes.graph",
    domain: "knowledge",
    kind: "read",
    transports: { rest: "GET /api/graph" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { scope?, depth?, focus?, sector? }（归一在领域层，与改前同源）
    handler: readGraph,
});

defineOp({
    name: "runbook.read",
    domain: "knowledge",
    kind: "read",
    transports: { rest: "GET /api/runbook" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 无入参（固定 runbook 处置步骤 + 近期事件查询）
    handler: readRunbook,
});

/* ── 批次 D2a（2026-10-15）：Agent 域只读 + 简单配置写 / 导出 ────────────────────
 * dashboard-reg-knowledge.js 的 10 条 REST 路由领域逻辑收进 knowledge-domain.js。
 * 这 10 条**均无 MCP 传输**（纯 REST 看板/agent 呈现面）⇒ REST-only：risk 一律**显式声明**（含 source），
 * 不走 TOOL_RISK 的 agent 执行阶梯；门禁由既有全局访问令牌 + RESTRICTED 承担。
 * domain 记 `agent`（呈现/配置 8 条）与 `export`（导出 2 条），与 D1 的 `knowledge` 分开。
 * 入参校验（budgetTokens/maxConcurrent/logLevel 枚举/on 须 boolean/id 缺失）与 RESTRICTED / reply.code(400|404|500|503)
 * 属 HTTP 协议行为，全部留在传输层；故 inputSchema 为 null（由 REST 适配器校验）。
 * ★ `agent.status` 的 handler 经 ctx.isRestricted() 在**调用时**求值 RESTRICTED（不冻结）；该值是响应体数据，非门禁。 */

defineOp({
    name: "agent.list",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agents" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 无入参（scanAgents 目标清单 + running/ready 卡片负载 join）
    handler: listAgents,
});

defineOp({
    name: "agent.status",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/status" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 无入参（LLM 端点解析 + MCP 工具面 + 写门禁/调优现值组装）
    handler: readAgentStatus,
});

defineOp({
    name: "agent.runs.list",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/runs" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 无入参（内存 run 注册表读取）
    handler: listAgentRuns,
});

defineOp({
    name: "agent.runs.read",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/runs/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；返回 null=不存在（404 由传输层映射）
    handler: readAgentRun,
});

defineOp({
    name: "agent.sessions.list",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/sessions" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 无入参（agent_sessions 列表读取）
    handler: listAgentSessions,
});

defineOp({
    name: "agent.sessions.read",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/sessions/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；返回 null=不存在（404 由传输层映射）
    handler: readAgentSession,
});

defineOp({
    name: "export.memories",
    domain: "export",
    kind: "read",
    transports: { rest: "GET /api/export/memories" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参仅 { limit?, status? }（由 REST 适配器解析）；信封/附件头/流式写出留在传输层
    handler: exportMemories,
});

defineOp({
    name: "export.audit",
    domain: "export",
    kind: "read",
    transports: { rest: "GET /api/export/audit" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参仅 { limit? }（由 REST 适配器解析）；信封/附件头/流式写出留在传输层
    handler: exportAudit,
});

defineOp({
    name: "agent.config.set",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/config" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { cache?, budgetTokens?, maxConcurrent?, logLevel? }；400/500/403 由传输层映射
    handler: setAgentConfig,
});

defineOp({
    name: "agent.exec.toggle",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/exec-toggle" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { on }；400/503/403 由传输层映射（503 的 error/execOn 文案由传输层拼）
    handler: toggleExecFace,
});

/* ── 批次 D2b（2026-10-15）：Agent 运行管理 / SSE / LLM / 进程操作 / 卡片收敛（17 条）────────────────
 * dashboard-reg-knowledge.js 的 17 条 REST 路由领域逻辑收进 knowledge-domain.js（+ createAgentRuntime）。
 * 这 17 条**均无 MCP 传输**（纯 REST 看板/agent 运行面）⇒ REST-only：risk 一律**显式声明**（含 source），
 * 不走 TOOL_RISK 的 agent 执行阶梯；门禁由既有全局访问令牌 + RESTRICTED 承担。
 * domain：agent 15 条；`plan.decompose` 记 `plan`；`cards.completeDeps`（卡片依赖收敛）按语义记 `task`。
 * 入参校验（message/goal 非空与长度、id 缺失）与 RESTRICTED / reply.code(2xx|4xx|5xx) 属 HTTP 协议行为，
 * 全部留在传输层；故 inputSchema 为 null（由 REST 适配器校验）。
 * ★ `agent.runs.stream` 的 handler 只产出**事件序列**（回放 + 订阅 + 终态判定），不写任何 HTTP 响应；
 *   写响应（SSE 头 / 心跳 / 断连清理）留在传输层。
 * ★ `agent.sessions.summarize` / `agent.chat` 的 handler 经 ctx 的 `resolveLlmCfg`（调用时读 env/config）
 *   解析 LLM，**不在注册期冻结**。 */

defineOp({
    name: "agent.chat",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/chat" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { message, history?, allowWrites?, maxSteps? }；400/502/503 由传输层映射
    handler: agentChat,
});

defineOp({
    name: "agent.runs.create",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/runs" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 = body；handler 委托注入的 startAgentRun（排队/并发/派发反查表在 runtime 内）
    handler: createAgentRun,
});

defineOp({
    name: "agent.runs.stream",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/runs/:id/stream" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, sinceSeq }；返回 null（404）或 { status(), replay(), subscribe() }
    handler: openAgentRunStream,
});

defineOp({
    name: "agent.runs.abort",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/runs/:id/abort" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, reason }；{ notFound:true }→404 / { terminal }→409（由传输层映射）
    handler: abortAgentRun,
});

defineOp({
    name: "agent.runs.chain",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/runs/:id/chain" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；返回 null=不存在（404 由传输层映射）
    handler: readAgentRunChain,
});

defineOp({
    name: "agent.steps.output",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/agent/runs/:id/steps/:sid/output" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, sid, range? }；{ noRun|noStep }→404 / { artifactError }→502（由传输层映射）
    handler: readAgentStepOutput,
});

defineOp({
    name: "agent.steps.approval",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/runs/:id/steps/:sid/approval" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, sid }；null=run 不存在（404）；否则 501 占位（文案由传输层出）
    handler: readAgentStepApproval,
});

defineOp({
    name: "agent.steps.rollback",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/runs/:id/steps/:sid/rollback" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, sid }；{ noRun|noStep }→404 / { notRollbackable|noSnapshot|pathEscaped }→409 / { writeFailed }→500
    handler: rollbackAgentStep,
});

defineOp({
    name: "agent.sessions.create",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/sessions" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { sessionKey?, title? }；403 由传输层映射（RESTRICTED 门禁）
    handler: createAgentSession,
});

defineOp({
    name: "agent.sessions.update",
    domain: "agent",
    kind: "write",
    transports: { rest: "PUT /api/agent/sessions/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, title?, messages? }；null=不存在（404 由传输层映射）
    handler: updateAgentSession,
});

defineOp({
    name: "agent.sessions.delete",
    domain: "agent",
    kind: "write",
    transports: { rest: "DELETE /api/agent/sessions/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；{ deleted:false }→404（由传输层映射）
    handler: removeAgentSession,
});

defineOp({
    name: "agent.sessions.compact",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/sessions/:id/compact" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, keepRecent? }；null=不存在（404）；非 LLM（纯截断）
    handler: compactAgentSessionOp,
});

defineOp({
    name: "agent.sessions.summarize",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/sessions/:id/summarize" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, keepRecent? }；null=404 / {llmConfigError|llmEmpty|summarizeFailed}→502（由传输层映射）
    handler: summarizeAgentSession,
});

defineOp({
    name: "agent.artifacts.read",
    domain: "agent",
    kind: "read",
    transports: { rest: "GET /api/artifacts/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { name }；null=404 / { escaped:true }→400（由传输层映射）；缓冲写出留在传输层
    handler: readArtifactFile,
});

defineOp({
    name: "agent.mcp.restart",
    domain: "agent",
    kind: "write",
    transports: { rest: "POST /api/agent/mcp/restart" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 无入参；进程生命周期（close/reset/重 spawn）经 ctx 注入，{ restartFailed }→503
    handler: restartAgentMcp,
});

defineOp({
    name: "plan.decompose",
    domain: "plan",
    kind: "write",
    transports: { rest: "POST /api/agent/plan/decompose" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { goal, maxSubtasks? }；goal 校验（400）与 {llmConfigError|llmEmpty|decomposeFailed}→502 留在传输层
    handler: decomposePlan,
});

defineOp({
    name: "cards.completeDeps",
    domain: "task",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/complete-deps" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；null→404 / {llmConfigError|llmFail}→502（由传输层映射）；RESTRICTED 门禁在传输层
    handler: completeCardDeps,
});

/* ══════════════════════════════════════════════════════════════════════
 * ★ 批次 C（2026-10-15）：memory 域 6 条 REST 路由（dashboard-reg-memory.js）
 *
 * ★ **非同源判定**（本批最关键结论，已由冒烟断言「无 op 声明 mcp=memory_write」守住）：
 *   `POST /api/memory` ↔ MCP `memory_write` 实测 7 处实质差异（身份 / 去重三闸 / 修订链 / 入参面 /
 *   审计落点 / [task] 头分支 / 输出形态，逐条见 memory-domain.js 头）⇒ **不合并**，只迁 REST 一侧，
 *   `server-reg-memory.js` 零改动 —— 与 B 批 task 域的判定同源（非同源就不做伪统一）。
 *   `DELETE /api/memory/:id` ↔ MCP `memory_feedback` 同理非同源；两者的共享部分本就是 db.js
 *   同一个 `rejectMemory` 入口，无重复实现可消。
 * ══════════════════════════════════════════════════════════════════════ */
defineOp({
    name: "memory.create",
    domain: "memory",
    kind: "write",
    transports: { rest: "POST /api/memory" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 = body；content 非空 / sensitivity 枚举校验（400）留在传输层
    handler: createManualMemory,
});

defineOp({
    name: "memory.update",
    domain: "memory",
    kind: "write",
    transports: { rest: "PUT /api/memory/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, content?, type?, sector?, inject? }；null→404 / {error}→400（由传输层映射）
    handler: updateMemoryRow,
});

defineOp({
    name: "memory.delete",
    domain: "memory",
    kind: "write",
    transports: { rest: "DELETE /api/memory/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；null=不存在（404 由传输层映射）；软删（status='rejected'），非物理删除
    handler: rejectMemoryRow,
});

defineOp({
    name: "rules.list",
    domain: "rules",
    kind: "read",
    transports: { rest: "GET /api/rules" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { limit?, status? }；limit 由传输层 clampLimit(query.limit, 500, 2000) 归一
    handler: listRules,
});

defineOp({
    name: "embed.vectors",
    domain: "embed",
    kind: "read",   // 纯计算无持久化副作用（POST 只是 HTTP 形态；不改库、不改盘）
    transports: { rest: "POST /v1/embeddings" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { input, model? }；input 校验（400）在传输层；{fail:"fake"}→503 / {fail:"error"}→502
    handler: serveEmbeddings,
});

defineOp({
    name: "embed.recompute",
    domain: "embed",
    kind: "write",
    transports: { rest: "POST /api/embed/recompute/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }（id 只作传输层参数校验；重算选择见 memory-domain.js 注释）；抛错→500（传输层映射）
    handler: recomputeEmbeddings,
});

/* ══════════════════════════════════════════════════════════════════════
 * ★ 批次 E1（2026-10-16）：cards 域 14 条（CRUD/详情/事件/评论/链接/状态机/心跳）。
 *   与 memory 批的差异：cards 领域层持有**可变实例状态**（SSE 事件总线 cardSubs /
 *   事务事件队列 txEvtQueue / 卡向量缓存），故 handler 经 `ctx.cards.*` 调
 *   registerCards 创建的**单例** createCardsDomain 实例，而非模块级函数——
 *   handler 契约不变（(ctx,args)=>裸领域值/哨兵）。
 *   全部 REST-only（cards 域无 MCP 工具对应面）；RESTRICTED 与协议校验留传输层；
 *   哨兵映射：null→404 / {error}→400 / {error,conflict}→409 / {error,forbidden}→403 / {error,missing}→404。
 * ══════════════════════════════════════════════════════════════════════ */
defineOp({
    name: "cards.list",
    domain: "cards",
    kind: "read",
    transports: { rest: "GET /api/cards" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { board?, status?, assignee?, lane?, include_terminal? }（查询串原样透传）
    handler: (ctx, args) => ctx.cards.listCards(args),
});
defineOp({
    name: "cards.one",
    domain: "cards",
    kind: "read",
    transports: { rest: "GET /api/cards/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；null→404
    handler: (ctx, args) => ctx.cards.readCardDetail(args.id),
});
defineOp({
    name: "cards.create",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { b: body, strictDup }；空标题 400 留传输层；{error,conflict}→409(strict_dup)
    handler: (ctx, args) => ctx.cards.createCard(args),
});
defineOp({
    name: "cards.update",
    domain: "cards",
    kind: "write",
    transports: { rest: "PUT /api/cards/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, b }；null→404 / {error}→400
    handler: (ctx, args) => ctx.cards.updateCardRow(args.id, args.b),
});
defineOp({
    name: "cards.delete",
    domain: "cards",
    kind: "write",
    transports: { rest: "DELETE /api/cards/:id" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }；null→404；绑定开放态任务 → {error,conflict}→409
    handler: (ctx, args) => ctx.cards.deleteCardRow(args.id),
});
defineOp({
    name: "cards.events.read",
    domain: "cards",
    kind: "read",
    transports: { rest: "GET /api/cards/:id/events" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, since? }；null→404
    handler: (ctx, args) => ctx.cards.readCardEvents(args.id, args.since),
});
defineOp({
    name: "cards.comment.add",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/comment" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, b }；{error}→400 / null→404 / {error,forbidden}→403（secret 扫描）
    handler: (ctx, args) => ctx.cards.addCardComment(args.id, args.b),
});
defineOp({
    name: "cards.comments.list",
    domain: "cards",
    kind: "read",
    transports: { rest: "GET /api/cards/:id/comments" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id }（非法 id 400 留传输层）
    handler: (ctx, args) => ctx.cards.listCardComments(args.id),
});
defineOp({
    name: "cards.link.add",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/links" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, b }；RESTRICTED 留传输层；{error}→400 / null→404 / 成环·重复边 {error,conflict}→409
    handler: (ctx, args) => ctx.cards.addCardLink(args.id, args.b),
});
defineOp({
    name: "cards.link.delete",
    domain: "cards",
    kind: "write",
    transports: { rest: "DELETE /api/cards/:id/links" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, dst, kind }；{error,missing}→404（L-08）
    handler: (ctx, args) => ctx.cards.deleteCardLink(args.id, args.dst, args.kind),
});
defineOp({
    name: "cards.status",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/status" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, b, actor, credential }；非法状态 {error}→400 / 白名单·验收门·TOCTOU {error,conflict}→409 / 凭据·认领者 {error,forbidden}→403
    handler: (ctx, args) => ctx.cards.transitionCard(args.id, args.b, args.actor, args.credential),
});
defineOp({
    name: "cards.accept",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/accept" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, actor, credential }；非 review {error,conflict}→409
    handler: (ctx, args) => ctx.cards.acceptCard(args.id, args.actor, args.credential),
});
defineOp({
    name: "cards.claim",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/claim" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, actor, credential }；CAS 竞争 {error,conflict}→409（lock 为随机值，冒烟掩码）
    handler: (ctx, args) => ctx.cards.claimCard(args.id, args.actor, args.credential),
});
defineOp({
    name: "cards.heartbeat",
    domain: "cards",
    kind: "write",
    transports: { rest: "POST /api/cards/:id/heartbeat" },
    risk: REST_ONLY_RISK,
    inputSchema: null, // 入参 { id, actor, credential }；非认领者/非 running {error,conflict}→409
    handler: (ctx, args) => ctx.cards.heartbeatCard(args.id, args.actor, args.credential),
});

/* ★ 批次 E2a（2026-10-16）：工作台配置面 16 条（types/edges/profiles/positions/archive/retype）——同 E1 实例派发口径 */
defineOp({ name: "card-types.list", domain: "cards", kind: "read", transports: { rest: "GET /api/card-types" }, risk: REST_ONLY_RISK, inputSchema: null, handler: (ctx) => ctx.cards.listCardTypes() });
defineOp({
    name: "card-types.create", domain: "cards", kind: "write", transports: { rest: "POST /api/card-types" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.createCardType(args.b), // {error}→400 / 保留字·重复 {error,conflict}→409
});
defineOp({
    name: "card-types.update", domain: "cards", kind: "write", transports: { rest: "PUT /api/card-types/:key" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.updateCardType(args.key, args.b), // null→404 / builtin {error,conflict}→409 / {error}→400
});
defineOp({
    name: "card-types.delete", domain: "cards", kind: "write", transports: { rest: "DELETE /api/card-types/:key" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.deleteCardType(args.key), // null→404 / builtin·有卡使用 {error,conflict}→409
});
defineOp({
    name: "cards.retype", domain: "cards", kind: "write", transports: { rest: "POST /api/cards/:id/retype" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.retypeCard(args.id, args.b), // null→404 / 未知类型 {error}→400 / running·派发连线 {error,conflict}→409
});
defineOp({ name: "agent-profiles.list", domain: "cards", kind: "read", transports: { rest: "GET /api/agent-profiles" }, risk: REST_ONLY_RISK, inputSchema: null, handler: (ctx) => ctx.cards.listAgentProfiles() });
defineOp({
    name: "agent-profiles.create", domain: "cards", kind: "write", transports: { rest: "POST /api/agent-profiles" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.createAgentProfile(args.b), // {error}→400；事务异常 throw→500（传输层映射）
});
defineOp({
    name: "agent-profiles.update", domain: "cards", kind: "write", transports: { rest: "PUT /api/agent-profiles/:id" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.updateAgentProfile(args.id, args.b), // null→404 / 派发中 {error,conflict}→409 / {error}→400
});
defineOp({
    name: "agent-profiles.delete", domain: "cards", kind: "write", transports: { rest: "DELETE /api/agent-profiles/:id" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.deleteAgentProfile(args.id), // null→404 / 派发中 {error,conflict}→409
});
defineOp({
    name: "card-edges.add", domain: "cards", kind: "write", transports: { rest: "POST /api/card-edges" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.addCardEdge(args.b), // {error}→400 / null→404 / 端口档位·重复连线 {error,conflict}→409
});
defineOp({
    name: "card-edges.delete", domain: "cards", kind: "write", transports: { rest: "DELETE /api/card-edges/:id" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.deleteCardEdge(args.id), // null→404 / dispatch 边 {error,conflict}→409
});
defineOp({
    name: "cards.position.set", domain: "cards", kind: "write", transports: { rest: "POST /api/cards/:id/position" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.setCardPosition(args.id, args.b), // null→404
});
defineOp({
    name: "cards.positions.reset", domain: "cards", kind: "write", transports: { rest: "DELETE /api/cards/positions" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.resetCardPositions(args.scope), // scope 由传输层解析（D-13）
});
defineOp({ name: "cards.archive.get", domain: "cards", kind: "read", transports: { rest: "GET /api/cards/archive" }, risk: REST_ONLY_RISK, inputSchema: null, handler: (ctx) => ctx.cards.getArchivePolicy() });
defineOp({
    name: "cards.archive.set", domain: "cards", kind: "write", transports: { rest: "POST /api/cards/archive" }, risk: REST_ONLY_RISK, inputSchema: null,
    handler: (ctx, args) => ctx.cards.setArchivePolicy(args.b), // mode 非法 {error}→400；mode/days/now 三分支由传输层按返回形状映射
});
defineOp({ name: "cards.archive.grouped", domain: "cards", kind: "read", transports: { rest: "GET /api/cards/archive/grouped" }, risk: REST_ONLY_RISK, inputSchema: null, handler: (ctx, args) => ctx.cards.listArchiveGrouped(args.by) });
