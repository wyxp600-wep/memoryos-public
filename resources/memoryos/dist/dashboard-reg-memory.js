import { registerMemoryBatch } from "./dashboard-memory-batch.mjs";
/** T8（P2-3）：buildApp 路由域拆分 —— memory 域。
 * handler 自 dashboard.js 原行 500-669 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。
 *
 * ★ 2026-10-15（架构收敛第 2 条 · 批次 C）：memory 域 **6 条路由改为薄适配** ——
 *   领域逻辑收进 memory-domain.js，经统一注册表（ops-registry.js 的 `memory.create` / `memory.update` /
 *   `memory.delete` / `rules.list` / `embed.vectors` / `embed.recompute`）派发。
 *   状态码 / body 结构 / 字段顺序 / 错误文案 / RESTRICTED 逐字节不变；**零新增路由**。
 *   领域层不静态 import ML / 进程层（getEmbedder / reembedStale / syncRules 经 ctx 注入），
 *   故此处仅注册调度 + 保留 HTTP 协议校验（400/404/500/502/503 与文案例）。
 *   另两条 task 路由（`GET /api/tasks`、`POST /api/task`）见批次 A/B 注释，本批**一行未动**。 */
// `SECTOR_KEYS` 供 PUT 的 sector 枚举校验（传输层）；`writeMemory/logUsage/logDaemon` 供 `POST /api/task`
// （批次 B 的 task 域薄适配）经 ctx 注入 task-domain.js —— 本批 memory 域的领域逻辑已不再直接调用它们。
import { SECTOR_KEYS, writeMemory, logUsage, logDaemon } from "./db.js";
import { reembedStale } from "./daemon.js";
import { syncRules } from "./sync-rules.js";
import { getEmbedder } from "./embed.js";
// ★ 2026-10-14（架构重构第 2 条 · 批次 A）：任务看板的领域逻辑（头解析/归一/依赖/结论/blocked/分桶）
//   已抽到 task-domain.js —— 领域逻辑单一真相源（MCP task_next 后续批次再收敛）。
import { parseTaskRows, bucketizeTaskRows } from "./task-domain.js";
// ★ 2026-10-15（批次 B/C）：task 域与 memory 域均经注册表派发（invokeOp → 裸领域值 → 按各自协议包装）
import { invokeOp } from "./ops-registry.js";
export function registerMemory(app, ctx) {
    registerMemoryBatch(app, ctx, { syncRules });
    const { db, restricted, RESTRICTED, clampLimit, ALLOWED_TYPES } = ctx;
    /** ★ 批次 C：memory 域领域层依赖（**最小集**，按各领域函数实际用到者给）——
     *  `getEmbedder`（embed.js：会拉起 543MB ONNX 模型面）、`reembedStale`（daemon.js）、
     *  `syncRules`（sync-rules.js：会写 `os.homedir()` 下的用户真实规则文件）三者一律经 ctx 注入，
     *  领域层不静态 import；`ALLOWED_TYPES` 复用 dashboard.js 顶层常量（不在领域层另造白名单）。
     *  本域 6 条均不使用调用方身份（写入方恒为 `human:dashboard`），故无「调用时解析身份」的 accessor。 */
    const MEMORY_CTX = { db, getEmbedder, ALLOWED_TYPES, syncRules };  // memory.create / memory.update / memory.delete / rules.list
    const EMBED_CTX = { getEmbedder };                                  // embed.vectors
    const EMBED_RECOMPUTE_CTX = { db, reembedStale };                   // embed.recompute
    // ── 人工新建记忆（P1-1：新建即嵌入向量；embed 失败降级不阻塞建库）──
    // ★ 批次 C：领域计算已收进 memory-domain.js::createManualMemory（op `memory.create`）；
    //   content 非空 / sensitivity 枚举两条 400 属 HTTP 协议校验，留在传输层，**顺序与改前一致**。
    app.post("/api/memory", async (req, reply) => {
        const b = req.body ?? {};
        const content = String(b.content ?? "").trim();
        if (!content)
            return reply.code(400).send({ ok: false, error: "content 不能为空" });
        const sensitivity = String(b.sensitivity ?? "normal").trim() || "normal";
        if (!["normal", "private", "secret"].includes(sensitivity))
            return reply.code(400).send({ ok: false, error: "sensitivity 非法" });
        const r = await invokeOp("memory.create", b, MEMORY_CTX);
        return { ok: true, id: r.id };
    });
    // —— 编辑记忆：content/type 更新，同步 FTS（embedding 保持原值，v0.3 约定） ——
    // ★ 批次 C：领域计算已收进 memory-domain.js::updateMemoryRow（op `memory.update`）；
    //   id → type → sector 三条 400 属协议校验，留在传输层（**顺序与改前一致**）；
    //   db 层写被拒（如 `sector:""` 写 NULL 撞 memories.sector NOT NULL）由领域层以 `{ error }` 哨兵回传，
    //   此处映射 400 且文案逐字同改前（原实现直接把 `String(e)` 当 400 文案回给前端）。
    app.put("/api/memory/:id", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        const type = req.body?.type;
        if (type && !ALLOWED_TYPES.includes(type))
            return reply.code(400).send({ ok: false, error: "type 非法" });
        const sector = req.body?.sector !== undefined ? String(req.body.sector).trim() : undefined;
        if (sector !== undefined && sector !== "" && !SECTOR_KEYS.includes(sector))
            return reply.code(400).send({ ok: false, error: "sector 非法" });
        const r = await invokeOp("memory.update", { id, content: req.body?.content, type, sector, inject: req.body?.inject }, MEMORY_CTX);
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        if (!r)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        return { ok: true, id: r.id };
    });
    /* ★ 一致性⑥（2026-09-19）：OpenAI 兼容 /v1/embeddings 共享嵌入端点 —— 内核侧常驻真向量嵌入
     *  （Electron 注入 EMBED_MODE=local，bge-m3 已在本进程加载）。MCP 侧 agent 配
     *  EMBED_MODE=api + EMBED_API_URL=http://127.0.0.1:8787/v1/embeddings + EMBED_API_KEY=<data/token>
     *  即共享同一份真向量语义：一份模型全端共享，agent 不必各载各的模型（省 N×GB 内存与启动耗时），
     *  并从此杜绝 MCP 侧 fake 向量混入真向量语料（半真半假比全假更糟）。
     *  鉴权：全局访问控制钩子已覆盖（?token= / x-memory-token / cookie / Bearer 任一）。
     *  响应与 OpenAI /v1/embeddings 同形（{object:"list", data:[{index, embedding}]}），embed.js ApiEmbedder 直读。
     * ★ 批次 C：领域计算已收进 memory-domain.js::serveEmbeddings（op `embed.vectors`）；
     *  input 校验（400）与 502/503 的**文案**属传输层协议行为，此处按领域哨兵 `{ fail }` 映射状态码。 */
    app.post("/v1/embeddings", async (req, reply) => {
        const body = req.body ?? {};
        const input = (Array.isArray(body.input) ? body.input : [body.input ?? ""]).map((t) => String(t ?? ""));
        if (!input.length || input.some((t) => !t.trim()))
            return reply.code(400).send({ ok: false, error: "input-required", hint: "body.input 须为非空字符串或非空字符串数组" });
        const r = await invokeOp("embed.vectors", { input, model: body.model }, EMBED_CTX);
        if (r?.fail === "fake")
            return reply.code(503).send({ ok: false, error: "embedder-fake", hint: "内核未以 EMBED_MODE=local/api 运行：宁可不服务，也不产出伪向量污染真向量语料（⑥纪律）" });
        if (r?.fail === "error")
            return reply.code(502).send({ ok: false, error: `embed-failed: ${r.message}` });
        return r;
    });
    // ★ P0-2：手动触发单条记忆向量重算
    // ★ 批次 C：领域计算已收进 memory-domain.js::recomputeEmbeddings（op `embed.recompute`）；
    //   id 校验（400）与「reembedStale 抛错 → 500」两条属传输层协议行为。
    app.post("/api/embed/recompute/:id", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        try {
            const r = await invokeOp("embed.recompute", { id }, EMBED_RECOMPUTE_CTX);
            return { ok: true, done: r.done, failed: r.failed, pending: r.pending };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
    });
    // —— 删除记忆/规则：软删 status='rejected'，审计留痕 ——
    // ★ 批次 C：领域计算已收进 memory-domain.js::rejectMemoryRow（op `memory.delete`）；id 校验（400）留传输层。
    app.delete("/api/memory/:id", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        const r = await invokeOp("memory.delete", { id }, MEMORY_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        return { ok: true, id: r.id };
    });
    // —— 规则列表：type='rule'，默认只列 active（删除即消失，审计留痕另查） ——
    // ★ 批次 C：领域计算已收进 memory-domain.js::listRules（op `rules.list`）；
    //   limit 的 `clampLimit(query.limit, 500, 2000)` 属**传输口径**（与改前同一函数、同一默认值、同一上限）。
    app.get("/api/rules", async (req) => {
        const limit = clampLimit(req.query.limit, 500, 2000);
        return await invokeOp("rules.list", { limit, status: req.query.status }, MEMORY_CTX);
    });
    // —— 任务看板：解码 type='task' 记忆约定头 → 结构化七态（v1.1 状态机：多 Agent 协同可视化）——
    // 解码与 server.js taskHead 同源：`[task][assignee:X][status:<七态>]`；存量 open/claimed/done 归一
    // ★ 2026-10-14（架构重构第 2 条 · 批次 A）：解析/归一/依赖/结论/blocked/分桶 已抽到 task-domain.js ——
    //   领域逻辑单一真相源；本路由只保留 limit 入参 clamp（传输适配），行为逐字节不变。
    app.get("/api/tasks", async (req) => {
        const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
        return bucketizeTaskRows(parseTaskRows(db, { limit, status: "active" }));
    });
    // —— 任务看板：人工创建任务（约定头由服务端拼装，避免前端拼错导致任务不显示）——
    app.post("/api/task", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "taskCreate");
        const b = req.body ?? {};
        const title = String(b.title ?? "").trim();
        if (!title)
            return reply.code(400).send({ ok: false, error: "任务标题不能为空" });
        // ★ 2026-10-15（架构重构第 2 条 · 批次 B）：入参校验之后的领域逻辑（content 拼装 / embedding / 写库）
        //   已收进 task-domain.js::createTaskMemory（逐字搬出）；本路由只做**薄适配** —— 经注册表派发后原样返回领域值，
        //   响应形状 / 文案 / 状态码逐字节不变。RESTRICTED 门禁与「标题非空」400 属 HTTP 协议行为，留在传输层。
        return await invokeOp("task.create", b, { db, writeMemory, logUsage, logDaemon, getEmbedder });
    });
}
