/** T8（P2-3）：buildApp 路由域拆分 —— knowledge 域。
 * handler 自 dashboard.js 原行 2397-2727 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { syncNotesIndex, demoteNoteLinks, writeNoteToVault, mapType } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";
import { detectSkillTargets } from "./skill-sync.js";
import { resolveLlm, runAgent, buildSystemPrompt, callLlm } from "./agent-core.js";
import { unprotectSecret } from "./secret-store.js";
import { createRunRegistry } from "./agent-runs.js";
import { resolveInside } from "./exec-tools.js";
import { listAgentSessions, getAgentSession, saveAgentSession, deleteAgentSession, appendAgentSession, compactAgentSession, allExecAudit, logExecAudit, updateMemory, logDaemon, renewCardLease } from "./db.js";
import path from "node:path";
// ★ 批次 D2b：`crypto`（会话 key 的 randomUUID）随会话写 CRUD 一并搬进 knowledge-domain.js —— 本模块不再直接用。
// ★ 2026-10-15（架构重构第 2 条 · 批次 D1）：knowledge 域 7 条路由（笔记 CRUD / 反向链接 / 知识图谱 /
//   事件手册）改为**薄适配** —— 领域逻辑收进 knowledge-domain.js，经统一注册表（ops-registry.js 的
//   `notes.*` / `runbook.read`）派发；响应状态码 / body 结构 / 字段顺序 / 错误文案逐字节不变。
import { invokeOp } from "./ops-registry.js";
// ★ 批次 D2b：run 编排运行时工厂（runQueue / pumpQueue / startRun / startAgentRun / abort）——
//   领域逻辑住在 knowledge-domain.js；本模块只注入重依赖（agent-core / LLM 解析 / secret / MCP 句柄）。
import { createAgentRuntime } from "./knowledge-domain.js";
export function registerKnowledge(app, ctx) {
    const { db, restricted, RESTRICTED, readDiskConfig, writeDiskConfig, getAgentMcp, resetAgentMcp, dataDirOf, setAgentMcpEnv, getLogLevel, setLogLevel } = ctx;
    /** ★ 批次 D1：knowledge 域领域层依赖（**最小集**，按各领域函数实际用到者给）——
     *  领域层不静态 import obsidian-sync / embed（避免 ops-registry 被加载时把 ML 层拖进 MCP 工具面）。
     *  本域 7 条路由均不使用调用方身份（写入方恒为 human:dashboard），故无需调用时解析的 accessor。 */
    const KNOWLEDGE_CTX = { db, getEmbedder, writeNoteToVault, mapType, syncNotesIndex, updateMemory, logDaemon, demoteNoteLinks };
    // 注：RESTRICTED 顶层常量是 8 个 reg 模块共享的单一判定入口（dashboard.js:46 模块加载时求值）。
    //   桌面 core-process 注入 MEMORY_RESTRICTED=0（默认非受限）；受限演示/冒烟经 env 切换（非 buildApp opts）。
    /* ── Agent 执行中心：per-run 内存模型（模块级单例，注册一次）────────
     * 纪律：呈现层只读/只推，不改 writeGate 行为；审批三键端点未启用一律 501 占位（B1）。
     * F15：SSE 预览 ≤300 字；工具结果全文走 exec artifact（data/artifacts/）按 range 拉取。 */
    const runs = createRunRegistry();
    /** ★ 批次 D2a：Agent 域只读 + 简单配置写的领域层依赖（**最小集**，按各领域函数实际用到者分组给）——
     *  重依赖（skill-sync 进程/磁盘探测 / agent-core 的 MCP 客户端 / agent-runs 内存 run 注册表 / llm 解析 /
     *  secret 解密）一律经 ctx 注入，领域层不静态 import；`RESTRICTED` 以 accessor 注入（**调用时求值**，
     *  不以布尔值冻结进 ctx —— 它只出现在 /api/agent/status 的响应体数据里，非门禁）。 */
    const AGENT_READ_CTX = {
        db, detectSkillTargets, runs,
        readDiskConfig, unprotectSecret, resolveLlm,
        getAgentMcp, resetAgentMcp, getLogLevel, agentTuning,
        listAgentSessions, getAgentSession,
        isRestricted: () => RESTRICTED,
    };
    const EXPORT_CTX = { db, allExecAudit };
    const CONFIG_CTX = { readDiskConfig, writeDiskConfig, setLogLevel, agentTuning };
    const EXEC_TOGGLE_CTX = { readDiskConfig, writeDiskConfig, setAgentMcpEnv, getAgentMcp, resetAgentMcp };
    /* ★ 批次 D2b（2026-10-15）：run 编排内存模型（runQueue / pumpQueue / dispatchRuns / startAgentRun /
     *   startRun / resolveLlmCfg / 写前快照）已**逐字搬进** knowledge-domain.js::createAgentRuntime ——
     *   重依赖（agent-core 的 runAgent/buildSystemPrompt、LLM 解析、secret 解密、MCP 句柄）全经 deps 注入；
     *   RESTRICTED / 卡片收口以 **accessor（调用时求值）** 注入，不在注册期冻成常量。
     *   本模块只保留 `runs` 内存注册表单例与 `agentTuning`，并连同工作区根一起注入工厂（见下方 agentRuntime）。 */
    /** 工作区根（diff 快照的路径边界；与 server.js 执行面同口径） */
    const WORKSPACE_ROOT = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", ".."));
    /* ── ★ 驾驶舱调优项（config.json 顶层键；各旋钮默认值保持既有行为不变）──
     *  llmCache（bool，默认 false）     ⑦「缓存」：LLM 响应缓存开关
     *  tokenBudget（number，默认 0=不设）⑦「预算上限」：单 run 累计 token 超即中止
     *  maxConcurrent（number，默认 3）  ⑧「并行数」：同时 running 的 run 上限（超出排队）
     *  logLevel（debug|info|warn|error）⑨「日志级别」：内核 5xx 诊断输出门控
     *  execOn（bool，默认 null=继承 shell）④「执行工具开关」：MCP 子进程 MEMORYOS_EXEC_ON
     *  读走 readDiskConfig（现读，即时生效）；写经 writeDiskConfig（整对象落盘）。 */
    function agentTuning() {
        const c = readDiskConfig();
        const mc = Number(c.maxConcurrent);
        const tb = Number(c.tokenBudget);
        return {
            llmCache: c.llmCache === true,
            tokenBudget: Number.isFinite(tb) && tb > 0 ? Math.floor(tb) : 0,
            maxConcurrent: Number.isFinite(mc) && mc >= 1 ? Math.min(8, Math.floor(mc)) : 3,
            logLevel: ["debug", "info", "warn", "error"].includes(c.logLevel) ? c.logLevel : "info",
            execOn: c.execOn === true ? true : c.execOn === false ? false : null,   // null=未显式设置（继承 shell）
        };
    }
    /** ★ 批次 D2b：run 编排运行时 —— 领域逻辑在 knowledge-domain.js::createAgentRuntime；此处只注入依赖并取回能力。 */
    const agentRuntime = createAgentRuntime({
        db, readDiskConfig, unprotectSecret, resolveLlm, buildSystemPrompt, runAgent,
        getAgentMcp, resetAgentMcp, agentTuning, runs,
        appendAgentSession, renewCardLease, resolveInside,
        finalizeCardDispatch: (...a) => ctx.finalizeCardDispatch?.(...a),   // ★ 调用时求值（cards 域先注册）
        isRestricted: () => RESTRICTED,                                    // ★ 调用时求值（RESTRICTED 非注册期常量）
        workspaceRoot: WORKSPACE_ROOT,
    });
    ctx.startAgentRun = agentRuntime.startAgentRun;   // ★ A1：cards 域（registerCards 已先注册）请求期复用
    /** ★ 批次 D2b：17 条 op 的**最小 ctx**（按各领域函数实际用到者给；重依赖与进程态注入）。 */
    const CHAT_CTX = { readDiskConfig, unprotectSecret, resolveLlm, getAgentMcp, resetAgentMcp, buildSystemPrompt, runAgent, isRestricted: () => RESTRICTED };
    const RUN_CREATE_CTX = { startAgentRun: agentRuntime.startAgentRun };
    const ABORT_CTX = { abortRun: agentRuntime.abortRun };
    const RUN_READ_CTX = { runs, dataDirOf };
    const RUN_WRITE_CTX = { runs, db, workspaceRoot: WORKSPACE_ROOT, resolveInside, logExecAudit };
    const LLM_CTX = { resolveLlmCfg: agentRuntime.resolveLlmCfg, callLlm };
    const SESSION_CTX = { db, saveAgentSession, getAgentSession, deleteAgentSession, compactAgentSession, resolveLlmCfg: agentRuntime.resolveLlmCfg, callLlm };
    const ARTIFACT_CTX = { dataDirOf };
    const MCP_CTX = { getAgentMcp, resetAgentMcp };
    const CARDS_DEPS_CTX = { db, resolveLlmCfg: agentRuntime.resolveLlmCfg, callLlm };
    // —— Agent 画像（泳道 + 负载）——
    // ★ 批次 D2a：领域计算（scanAgents 目标清单 + running/ready 卡片负载 join）已收进
    //   knowledge-domain.js::listAgents（op `agent.list`）；本路由只做薄适配 —— 领域值原样返回
    //   （本路由无 `{ ok }` 信封，与改前一致）。
    app.get("/api/agents", async () => invokeOp("agent.list", {}, AGENT_READ_CTX));
    // —— 知识图谱（H1 统一图 + H4 secret 折叠 + R2-1 上限 200 + focus/depth BFS）——
    // ★ 批次 D1：领域计算（节点池 / links 边 / focus BFS / 度数截断 / sector 过滤）已收进
    //   knowledge-domain.js::readGraph（op `notes.graph`）；本路由只做薄适配 —— 入参原样传入、领域值原样返回。
    app.get("/api/graph", async (req) => invokeOp("notes.graph", { scope: req.query.scope, depth: req.query.depth, focus: req.query.focus, sector: req.query.sector }, KNOWLEDGE_CTX));
    // —— 反向链接（linked/unlinked/outgoing/unresolved）——
    // ★ 批次 D1：领域计算已收进 knowledge-domain.js::readBacklinks（op `notes.backlinks`）；
    //   `id 必填` 的 400 属 HTTP 协议行为，留在传输层（先校验后派发，校验顺序与改前一致）。
    app.get("/api/backlinks", async (req, reply) => {
        const id = Number(req.query.id);
        if (!id)
            return reply.code(400).send({ ok: false, error: "id 必填" });
        const r = await invokeOp("notes.backlinks", { kind: req.query.kind, id }, KNOWLEDGE_CTX);
        return { ok: true, ...r };
    });
    // —— 笔记（用户自建 + vault 镜像；POST/PUT/DELETE 走写盘 + 索引同步）——
    // ★ 批次 D1：领域计算已收进 knowledge-domain.js（ops `notes.list` / `notes.create` / `notes.update` / `notes.delete`）；
    //   本模块只做薄适配 —— 状态码 / body 结构 / 字段顺序 / 错误文案逐字节不变（404/400/500 与 RESTRICTED 留在传输层）。
    app.get("/api/notes", async (req, reply) => {
        const r = await invokeOp("notes.list", { id: req.query.id, vault: req.query.vault, origin: req.query.origin }, KNOWLEDGE_CTX);
        if (req.query.id) {
            if (!r)
                return reply.code(404).send({ ok: false, error: "笔记不存在" });
            return { ok: true, note: r.note };
        }
        return { ok: true, notes: r.notes };
    });
    app.post("/api/notes", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "noteCreate");
        const b = req.body ?? {};
        const vault = String(b.vault ?? "").trim();
        const title = String(b.title ?? "").trim();
        if (!vault || !title)
            return reply.code(400).send({ ok: false, error: "vault/title 必填" });
        try {
            const r = await invokeOp("notes.create", b, KNOWLEDGE_CTX);
            return { ok: true, file: r.file, note_path: r.note_path, memory_id: r.memory_id, created: r.created };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.put("/api/notes/:id", async (req, reply) => {
        const r = await invokeOp("notes.update", { id: req.params.id, content: req.body?.content, type: req.body?.type }, KNOWLEDGE_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "笔记不存在" });
        if (r.empty)
            return reply.code(400).send({ ok: false, error: "内容不能为空" });
        return { ok: true, id: r.id };
    });
    app.delete("/api/notes/:id", async (req, reply) => {
        const r = await invokeOp("notes.delete", { id: req.params.id }, KNOWLEDGE_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "笔记不存在" });
        return { ok: true, id: r.id };
    });

    /* ── Agent（C 路线：dashboard 内置智能体）──────────────────────────────
     * 与 CLI（dist/agent.js）共用 dist/agent-core.js —— 同一个 agent 循环、同一个 MCP 工具面（18 工具），
     * 只是把「大脑」换成可插拔 LLM 端点、「工具客户端」换成 dashboard 进程内 stdio 拉起。
     * LLM 端点：设置页 llmUrl/llmModel（config.json 落盘）优先，环境变量 LLM_* 兜底，默认本地 Ollama qwen3:8b。
     *           API Key 绝不落盘（P-4171）：如需鉴权走环境变量 LLM_API_KEY（config.json 不含明文密钥）。
     * 写门禁：默认全拒（记忆库写操作须先获同意）。前端显式带 allowWrites=true 且非受限模式时才放行写类工具。
     * 无状态：对话历史由前端回传（仅收 user/assistant 文本），服务端不持有会话，重启不丢、也不串号。 */
    /** agent 状态：模型端点 + 工具面 + 写门禁（前端页头直接展示，避免"以为在用 A 其实在用 B"） */
    // ★ 批次 D2a：领域计算（LLM 端点解析 + MCP 工具面 + 写门禁/调优现值组装）已收进
    //   knowledge-domain.js::readAgentStatus（op `agent.status`）；本路由只补 `{ ok:true }` 信封。
    app.get("/api/agent/status", async () => {
        const r = await invokeOp("agent.status", {}, AGENT_READ_CTX);
        return { ok: true, ...r };
    });
    /** 跑一轮 agent：返回答案 + 工具调用轨迹（前端据此展示"它干了什么"） */
    // ★ 批次 D2b：领域计算（LLM 端点解析 + MCP 获取 + agent 循环 + 工具轨迹）已收进
    //   knowledge-domain.js::agentChat（op `agent.chat`）；400/502/503 与错误文案留在传输层。
    app.post("/api/agent/chat", async (req, reply) => {
        const b = (req.body ?? {});
        const message = String(b.message ?? "").trim();
        if (!message)
            return reply.code(400).send({ ok: false, error: "message 不能为空" });
        if (message.length > 4000)
            return reply.code(400).send({ ok: false, error: "message 过长（上限 4000 字）" });
        const r = await invokeOp("agent.chat", b, CHAT_CTX);
        if (r.mcpUnavailable !== undefined)
            return reply.code(503).send({ ok: false, error: "MCP 工具面不可用：" + r.mcpUnavailable });
        if (r.chatFailed)
            return reply.code(502).send({
                ok: false,
                error: `agent 执行失败：${r.msg}${/fetch failed|ECONNREFUSED|HTTP 500/i.test(r.msg) ? `（LLM 端点 ${r.baseUrl} 不可达：本地 Ollama 未启动可执行 ollama serve；或在设置页把 llmUrl/llmModel 指向可用端点）` : ""}`,
                toolLog: r.toolLog, elapsedMs: r.elapsedMs,
            });
        return {
            ok: true, answer: r.answer, steps: r.steps, llmSteps: r.steps,
            toolLog: r.toolLog, deniedWrites: r.deniedWrites, allowWrites: r.allowWrites, elapsedMs: r.elapsedMs,
            llm: r.llm,
        };
    });
    /* ── Agent 执行中心（呈现层）：起 run 立即回 runId，后台跑 runAgent，过程经 SSE /stream 实时推送；
     * GET /runs、/runs/:id 读全量；artifact 与 sessions 只读/受限写。
     * 纪律：全部「追加」，不改 /chat 行为；审批三键端点未启用 → 501 占位（B1，不静默放行）。 */
    /** 建一个后台 run（立即返回，不阻塞） */
    // ★ 批次 D2b：起 run 收敛到 knowledge-domain.js::createAgentRun（op `agent.runs.create`）——
    //   委托 createAgentRuntime 的 startAgentRun（排队/并发/派发反查表全在 runtime 内，与派发端点同源）；
    //   400 校验与 202 信封留在传输层。
    app.post("/api/agent/runs", async (req, reply) => {
        const b = (req.body ?? {});
        const message = String(b.message ?? "").trim();
        if (!message)
            return reply.code(400).send({ ok: false, error: "message 不能为空" });
        if (message.length > 4000)
            return reply.code(400).send({ ok: false, error: "message 过长（上限 4000 字）" });
        let started;
        try {
            started = await invokeOp("agent.runs.create", b, RUN_CREATE_CTX);
        }
        catch (e) {
            return reply.code(503).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return reply.code(202).send({
            ok: true, runId: started.runId, sessionKey: b.sessionKey || null, status: started.status,
            ...(started.status === "queued" ? { queueAhead: started.queueAhead } : {}),
            cap: started.cap,
        });
    });
    /** run 列表（活动 + 终态，内存保留最近 50） */
    // ★ 批次 D2a：领域计算（内存 run 注册表读取）已收进 knowledge-domain.js::listAgentRuns（op `agent.runs.list`）。
    app.get("/api/agent/runs", async () => {
        const r = await invokeOp("agent.runs.list", {}, AGENT_READ_CTX);
        return { ok: true, ...r };
    });
    /** 单 run 全量（steps + 事件回放 + 答案） */
    // ★ 批次 D2a：领域计算已收进 knowledge-domain.js::readAgentRun（op `agent.runs.read`）；404 留在传输层。
    app.get("/api/agent/runs/:id", async (req, reply) => {
        const r = await invokeOp("agent.runs.read", { id: req.params.id }, AGENT_READ_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "run 不存在（内存保留最近 50 个）" });
        return { ok: true, ...r };
    });
    /** SSE 实时流：Last-Event-ID 回补 + 增量推送；断线浏览器自动重连 */
    // ★ 批次 D2b：**切成两段** —— 领域层（knowledge-domain.js::openAgentRunStream，op `agent.runs.stream`）
    //   只产出「终态判定 + 事件回放 + 订阅（内置 seq 去重与退订）」，**不写任何响应**；
    //   SSE 头 / `: agent-run stream` 注释行 / raw.write / error 监听 / 断连 unsub / end() 全部留在本层。
    app.get("/api/agent/runs/:id/stream", async (req, reply) => {
        const st = await invokeOp("agent.runs.stream", { id: req.params.id, sinceSeq: Number(req.headers["last-event-id"] || 0) }, RUN_READ_CTX);
        if (!st)
            return reply.code(404).send({ ok: false, error: "run 不存在" });
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
        });
        reply.raw.write(": agent-run stream\n\n");
        // ★ 写失败是异步 'error' 事件，无监听即未捕获异常 → 整服务崩（run 反馈流断开不能拖死看板）
        reply.raw.on("error", () => { /* 单条客户端流故障，交给 close 走 unsub */ });
        const flush = (e) => {
            if (reply.raw.writableEnded || reply.raw.destroyed) // 已收流后仍可能有事件回补 → 防 write after end
                return;
            reply.raw.write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        };
        try {
            for (const e of st.replay())
                flush(e);
            const unsub = st.subscribe((e) => flush(e));
            req.raw.on("close", () => unsub());
        }
        catch (e) {
            // 呈现层护栏：headers 已发出后任何异常都不能回 500（会升级为 ERR_HTTP_HEADERS_SENT 拖崩服务面）。
            // 只收掉这条客户端流；服务端 run 与事件流本体不受影响（订阅失败不阻塞其他订阅者）。
            reply.log?.error?.(e instanceof Error ? e : new Error(String(e)));
            try { reply.raw.end(); } catch { /* 连接可能已断 */ }
            return;
        }
        // queued 也会后续发 started/step 事件 → 保持连接；只有真终态才收流
        if (st.status() !== "running" && st.status() !== "queued")
            reply.raw.end();
    });
    /** 大输出按段拉取（exec artifact；range=a-b 0 基；无 artifact 步骤返回内联预览） */
    // ★ 批次 D2b：领域计算已收进 knowledge-domain.js::readAgentStepOutput（op `agent.steps.output`）；
    //   404/502 与 `{ ok:true, ... }` 信封留在传输层（键序与改前逐字节一致）。
    app.get("/api/agent/runs/:id/steps/:sid/output", async (req, reply) => {
        const r = await invokeOp("agent.steps.output", { id: req.params.id, sid: req.params.sid, range: req.query.range }, RUN_READ_CTX);
        if (r.noRun)
            return reply.code(404).send({ ok: false, error: "run 不存在" });
        if (r.noStep)
            return reply.code(404).send({ ok: false, error: "步骤不存在" });
        if (r.inline !== undefined)
            return { ok: true, inline: r.inline, totalLines: r.totalLines, from: r.from, to: r.to };
        if (r.artifactError !== undefined)
            return reply.code(502).send({ ok: false, error: r.artifactError });
        return { ok: true, ...r };
    });
    /** artifact 下载（只读；RESTRICTED 下 403 体例；basename 白名单 + realpath 边界校验防越界） */
    // ★ 批次 D2b：realpath 边界校验与读盘已收进 knowledge-domain.js::readArtifactFile（op `agent.artifacts.read`）；
    //   403/400/404 与附件头 + raw 写出留在传输层（HTTP 协议行为，含非 JSON 原文写出）。
    app.get("/api/artifacts/:id", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const name = String(req.params.id || "").slice(0, 200);
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes(".."))
            return reply.code(400).send({ ok: false, error: "非法 artifact 名" });
        const r = await invokeOp("agent.artifacts.read", { name }, ARTIFACT_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "artifact 不存在" });
        if (r.escaped)
            return reply.code(400).send({ ok: false, error: "artifact 越界" });
        reply.raw.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "content-length": r.buffer.length });
        reply.raw.end(r.buffer);
    });
    /* ── Agent 会话持久化（agent_sessions 表；RESTRICTED 下写 403） ── */
    // ★ 批次 D2a：领域计算（会话列表/单条读取）已收进 knowledge-domain.js
    //   （op `agent.sessions.list` / `agent.sessions.read`）；404 留在传输层。
    app.get("/api/agent/sessions", async () => {
        const r = await invokeOp("agent.sessions.list", {}, AGENT_READ_CTX);
        return { ok: true, ...r };
    });
    app.get("/api/agent/sessions/:id", async (req, reply) => {
        const r = await invokeOp("agent.sessions.read", { id: req.params.id }, AGENT_READ_CTX);
        return r ? { ok: true, ...r } : reply.code(404).send({ ok: false, error: "会话不存在" });
    });
    // ★ 批次 D2b：会话写 CRUD 已收进 knowledge-domain.js（op `agent.sessions.create`）；
    //   403（RESTRICTED 门禁）与 201 留在传输层。
    app.post("/api/agent/sessions", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const r = await invokeOp("agent.sessions.create", req.body ?? {}, SESSION_CTX);
        return reply.code(201).send({ ok: true, sessionKey: r.sessionKey });
    });
    // ★ 批次 D2b：已收进 knowledge-domain.js::updateAgentSession（op `agent.sessions.update`）；404 留在传输层。
    app.put("/api/agent/sessions/:id", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = req.body ?? {};
        const r = await invokeOp("agent.sessions.update", { id: req.params.id, title: b.title, messages: b.messages }, SESSION_CTX);
        return r ? { ok: true } : reply.code(404).send({ ok: false, error: "会话不存在" });
    });
    // ★ 批次 D2b：已收进 knowledge-domain.js::removeAgentSession（op `agent.sessions.delete`）；404 留在传输层。
    app.delete("/api/agent/sessions/:id", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const r = await invokeOp("agent.sessions.delete", { id: req.params.id }, SESSION_CTX);
        return r.deleted ? { ok: true } : reply.code(404).send({ ok: false, error: "会话不存在" });
    });
    /** 审批三键端点（B1：writeGate 升级属功能变更，本次仅 501 占位，不静默放行） */
    // ★ 批次 D2b：run 存在性判定 + `approval` 取值已收进 knowledge-domain.js::readAgentStepApproval
    //   （op `agent.steps.approval`）；501 状态码与固定文案留在传输层。
    app.post("/api/agent/runs/:id/steps/:sid/approval", async (req, reply) => {
        const r = await invokeOp("agent.steps.approval", { id: req.params.id, sid: req.params.sid }, RUN_READ_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "run 不存在" });
        return reply.code(501).send({ ok: false, error: "审批功能未启用（需单独立项：writeGate 升级为 (tool,risk,decision) 判定）", approval: r.approval });
    });
    /* ── 驾驶舱 6 端点（A1/A2/A3/A4/A6；A5 token 用量已随 startRun 落地到 /runs/:id 的 usage/estimatedTokens） ── */
    /** A1 中止运行：触发 AbortSignal（轮次间 + LLM fetch 可中断；进行中工具调用跑完）。
     *  queued 状态亦可中止（取消排队）；中止后空出的并发位由 pumpQueue 启动排队下一个。 */
    // ★ 批次 D2b：中止语义（含排队反查表补收口 + pumpQueue 空位）已收进 knowledge-domain.js::abortRun
    //   （op `agent.runs.abort`）；404/409 留在传输层。
    app.post("/api/agent/runs/:id/abort", async (req, reply) => {
        const r = await invokeOp("agent.runs.abort", { id: req.params.id, reason: (req.body ?? {}).reason }, ABORT_CTX);
        if (r.notFound)
            return reply.code(404).send({ ok: false, error: "run 不存在（内存保留最近 50 个）" });
        if (r.terminal)
            return reply.code(409).send({ ok: false, error: `run 已终态（${r.terminal}），无需中止` });
        return { ok: true, runId: r.runId, status: "aborted" };
    });
    /** A2 会话压缩：保留最近 N 条消息（上下文管理；RESTRICTED 下 403） */
    // ★ 批次 D2b：领域计算已收进 knowledge-domain.js::compactAgentSessionOp（op `agent.sessions.compact`）；
    //   403/404 留在传输层。
    app.post("/api/agent/sessions/:id/compact", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = (req.body ?? {});
        const r = await invokeOp("agent.sessions.compact", { id: req.params.id, keepRecent: b.keepRecent }, SESSION_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "会话不存在" });
        return { ok: true, ...r };
    });
    /** A3 全量记忆导出（JSON 附件；复用 /api/all SQL 口径；RESTRICTED 下 403） */
    // ★ 批次 D2a：领域计算（limit/status 归一 + SQL 查询行）已收进 knowledge-domain.js::exportMemories
    //   （op `export.memories`）；附件头（content-disposition/content-length）、`{ exportedAt, count, rows }`
    //   信封与流式写出一律留在传输层（HTTP 协议行为）。
    app.get("/api/export/memories", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const r = await invokeOp("export.memories", { limit: req.query.limit, status: req.query.status }, EXPORT_CTX);
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), count: r.rows.length, rows: r.rows }, null, 2);
        const name = `memoryos-memories-${new Date().toISOString().slice(0, 10)}.json`;
        reply.raw.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
            "content-length": Buffer.byteLength(payload),
        });
        reply.raw.end(payload);
    });
    /** A4 执行审计导出（JSON 附件；全量 exec_audit 只读；RESTRICTED 下 403） */
    // ★ 批次 D2a：领域计算（limit 归一 + 审计行查询）已收进 knowledge-domain.js::exportAudit（op `export.audit`）。
    app.get("/api/export/audit", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const r = await invokeOp("export.audit", { limit: req.query.limit }, EXPORT_CTX);
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), count: r.rows.length, rows: r.rows }, null, 2);
        const name = `memoryos-exec-audit-${new Date().toISOString().slice(0, 10)}.json`;
        reply.raw.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
            "content-length": Buffer.byteLength(payload),
        });
        reply.raw.end(payload);
    });
    /** A6 MCP 重启：close 现有句柄 + reset + 惰性重 spawn（仅 dashboard 自己的 MCP 子进程） */
    // ★ 批次 D2b：进程生命周期（close/reset/重 spawn）经 ctx 注入、逻辑收进
    //   knowledge-domain.js::restartAgentMcp（op `agent.mcp.restart`）；503 文案留在传输层。
    app.post("/api/agent/mcp/restart", async (req, reply) => {
        const r = await invokeOp("agent.mcp.restart", {}, MCP_CTX);
        if (r.restartFailed !== undefined)
            return reply.code(503).send({ ok: false, error: "MCP 重启失败：" + r.restartFailed });
        return { ok: true, restarted: true, toolCount: r.toolCount };
    });
    /** ⑦⑧⑨ 调优旋钮：缓存开关 / token 预算 / 并行数 / 日志级别（config.json 顶层键，即时生效；
     *  logLevel 同时设内核内存级。RESTRICTED 下 403 —— 调优属运维写）。 */
    // ★ 批次 D2a：字段应用 + 落盘已收进 knowledge-domain.js::setAgentConfig（op `agent.config.set`）；
    //   入参校验（400 文案）、403 / 500 留在传输层 —— 校验顺序与「无可更新字段」判定同改前逐字一致。
    app.post("/api/agent/config", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = req.body ?? {};
        if (b.budgetTokens !== undefined) {
            const n = Math.floor(Number(b.budgetTokens));
            if (!Number.isFinite(n) || n < 0 || n > 10_000_000)
                return reply.code(400).send({ ok: false, error: "budgetTokens 须为 0..10000000 整数（0=不设上限）" });
        }
        if (b.maxConcurrent !== undefined) {
            const n = Math.floor(Number(b.maxConcurrent));
            if (!Number.isFinite(n) || n < 1 || n > 8)
                return reply.code(400).send({ ok: false, error: "maxConcurrent 须为 1..8 整数" });
        }
        if (b.logLevel !== undefined) {
            if (!["debug", "info", "warn", "error"].includes(b.logLevel))
                return reply.code(400).send({ ok: false, error: "logLevel 须为 debug|info|warn|error" });
        }
        if (b.cache === undefined && b.budgetTokens === undefined && b.maxConcurrent === undefined && b.logLevel === undefined)
            return reply.code(400).send({ ok: false, error: "无可更新字段（cache/budgetTokens/maxConcurrent/logLevel）" });
        try {
            const r = await invokeOp("agent.config.set", b, CONFIG_CTX);
            return { ok: true, changed: r.changed, tuning: r.tuning };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: "写入 config.json 失败：" + (e instanceof Error ? e.message : String(e)) });
        }
    });

    /** ④ 执行工具开关：设 MEMORYOS_EXEC_ON + 持久化 execOn + 重 spawn MCP（返回新工具面计数） */
    // ★ 批次 D2a：领域计算（落盘 + MCP 重 spawn + 工具面计数）已收进 knowledge-domain.js::toggleExecFace
    //   （op `agent.exec.toggle`）；403 / 400 / 503 留在传输层（503 的 execOn 由入参带回）。
    app.post("/api/agent/exec-toggle", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const on = (req.body ?? {}).on;
        if (typeof on !== "boolean")
            return reply.code(400).send({ ok: false, error: "on 须为 boolean" });
        try {
            const r = await invokeOp("agent.exec.toggle", { on }, EXEC_TOGGLE_CTX);
            return { ok: true, ...r };
        }
        catch (e) {
            return reply.code(503).send({ ok: false, error: "执行面重启失败：" + (e instanceof Error ? e.message : String(e)), execOn: on });
        }
    });

    /** ② 自动拆解（LLM planner）：把目标拆成 3–7 条可派发子任务（纯 LLM 推理，不写库；
     *  RESTRICTED 下亦允许——只读推理。前端「领任务做」的拆解预览）。 */
    // ★ 批次 D2b：prompt 组装 + LLM 调用 + 子任务切分已收进 knowledge-domain.js::decomposePlan
    //   （op `plan.decompose`）；goal 校验（400）与 502 文案留在传输层。
    app.post("/api/agent/plan/decompose", async (req, reply) => {
        const b = req.body ?? {};
        const goal = String(b.goal ?? "").trim();
        if (!goal)
            return reply.code(400).send({ ok: false, error: "goal 不能为空" });
        if (goal.length > 4000)
            return reply.code(400).send({ ok: false, error: "goal 过长（上限 4000 字）" });
        const r = await invokeOp("plan.decompose", b, LLM_CTX);
        if (r.llmConfigError !== undefined)
            return reply.code(502).send({ ok: false, error: "LLM 配置不可用：" + r.llmConfigError });
        if (r.llmEmpty)
            return reply.code(502).send({ ok: false, error: "LLM 未返回拆解结果" });
        if (r.decomposeFailed !== undefined)
            return reply.code(502).send({ ok: false, error: `LLM 拆解失败：${r.decomposeFailed}` });
        return { ok: true, goal: r.goal, plan: r.plan, subtasks: r.subtasks, llm: r.llm };
    });
    /** ★ 2026-10-06「补全依赖」：任务卡被依赖拦着派不出去时，LLM 读目标 + 未完成依赖，
     *  给出「可判定满足的前置」(complete) 与「尚缺的前置子任务」(create)。
     *  前端点「🪄 补全依赖并继续派发」调本端点 → 完成后所有依赖满足 → 主卡即可派发。
     *  副作用：complete 里的既有依赖卡被置 done；create 出的新前置卡以 done 建立并连 depends。 */
    // ★ 批次 D2b：依赖判定 + LLM 补全方案解析 + 置 done/建卡/连线 + remaining 复查已收进
    //   knowledge-domain.js::completeCardDeps（op `cards.completeDeps`，domain=task）；
    //   RESTRICTED 门禁（restricted(reply,"cardCreate")）与 404/502 文案留在传输层。
    app.post("/api/cards/:id/complete-deps", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const r = await invokeOp("cards.completeDeps", { id: req.params.id }, CARDS_DEPS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r.llmConfigError !== undefined)
            return reply.code(502).send({ ok: false, error: "LLM 配置不可达，无法补全依赖：" + r.llmConfigError });
        if (r.llmFail !== undefined)
            return reply.code(502).send({ ok: false, error: "LLM 补全依赖失败：" + r.llmFail });
        return { ok: true, ...r };
    });
    /** ⑥ 上下文摘要（LLM 有损压缩）：把会话较早消息摘要成一条，保留最近 keepRecent 条原文。
     *  区别于 compact（纯截断无损）——摘要走 LLM 生成，RESTRICTED 下 403（写会话）。 */
    // ★ 批次 D2b：keepRecent 钳制 + 会话读取 + LLM 摘要 + 写回已收进
    //   knowledge-domain.js::summarizeAgentSession（op `agent.sessions.summarize`）；403/404/502 留在传输层。
    app.post("/api/agent/sessions/:id/summarize", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const r = await invokeOp("agent.sessions.summarize", { id: req.params.id, keepRecent: (req.body ?? {}).keepRecent }, SESSION_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "会话不存在" });
        if (r.llmConfigError !== undefined)
            return reply.code(502).send({ ok: false, error: "LLM 配置不可用：" + r.llmConfigError });
        if (r.llmEmpty)
            return reply.code(502).send({ ok: false, error: "LLM 未返回摘要" });
        if (r.summarizeFailed !== undefined)
            return reply.code(502).send({ ok: false, error: `摘要失败：${r.summarizeFailed}` });
        return { ok: true, ...r };
    });
    /** ② 文件写回滚（快照还原）：把某 file_write 步骤的写前快照写回原路径。
     *  仅当该步骤带 beforeText/beforePath（写入时 ≤50KB 且在工作区内）才可回滚；RESTRICTED 下 403（写盘）。 */
    // ★ 批次 D2b：快照还原 + 路径边界再校验（resolveInside）+ 审计 + 事件已收进
    //   knowledge-domain.js::rollbackAgentStep（op `agent.steps.rollback`）；403/404/409/500 与文案留在传输层。
    app.post("/api/agent/runs/:id/steps/:sid/rollback", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const r = await invokeOp("agent.steps.rollback", { id: req.params.id, sid: req.params.sid }, RUN_WRITE_CTX);
        if (r.noRun)
            return reply.code(404).send({ ok: false, error: "run 不存在（内存保留最近 50 个）" });
        if (r.noStep)
            return reply.code(404).send({ ok: false, error: "步骤不存在" });
        if (r.notRollbackable)
            return reply.code(409).send({ ok: false, error: "该步骤不是可回滚的写文件步骤" });
        if (r.noSnapshot)
            return reply.code(409).send({ ok: false, error: "该步骤无写前快照（文件过大或越界，未快照），无法回滚" });
        if (r.pathEscaped)
            return reply.code(409).send({ ok: false, error: "快照路径越界，拒绝回滚" });
        if (r.writeFailed)
            return reply.code(500).send({ ok: false, error: "写回失败：" + r.error });
        return { ok: true, runId: r.runId, stepId: r.stepId, file: r.file, restoredBytes: r.restoredBytes, nowMatchesSnapshot: r.nowMatchesSnapshot };
    });
    /** ⑨ 调用链：把某 run 的工具调用串成机器可读 trace（顺序 + 每步耗时 + 产物 + 依赖），前端渲染调用链图 */
    // ★ 批次 D2b：领域计算已收进 knowledge-domain.js::readAgentRunChain（op `agent.runs.chain`）；404 留在传输层。
    app.get("/api/agent/runs/:id/chain", async (req, reply) => {
        const r = await invokeOp("agent.runs.chain", { id: req.params.id }, RUN_READ_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "run 不存在（内存保留最近 50 个）" });
        return { ok: true, ...r };
    });
    /** ⑩ 事件手册（治理合规）：返回结构化 runbook（处置步骤）+ 近期真实事件（daemon_log + exec_audit 失败/拒绝），只读 */
    // ★ 批次 D1：领域计算（runbook 处置步骤 + 近期事件查询）已收进 knowledge-domain.js::readRunbook（op `runbook.read`）。
    app.get("/api/runbook", async () => {
        const r = await invokeOp("runbook.read", {}, KNOWLEDGE_CTX);
        return { ok: true, ...r };
    });
}
