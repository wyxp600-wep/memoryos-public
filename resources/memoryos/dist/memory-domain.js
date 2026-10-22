/**
 * MemoryOS — memory 域领域逻辑（架构重构第 2 条「统一操作注册表，消除双传输层」· 批次 C · 2026-10-15）
 *
 * ── 单一真相源 ──────────────────────────────────────────────────────
 *   本模块承载 REST memory 域（dashboard-reg-memory.js）的领域语义，**逐字自 registerMemory 原实现搬出，
 *   行为逐字节不变**（原实现见 git 历史 dashboard-reg-memory.js 中对应 handler 段）。
 *   注册表（ops-registry.js）与 REST 路由都指向本模块 —— 领域逻辑只有一份。
 *
 *   批次 C（6 条）：
 *     `POST /api/memory`（op `memory.create`）· `PUT /api/memory/:id`（`memory.update`）·
 *     `DELETE /api/memory/:id`（`memory.delete`）· `GET /api/rules`（`rules.list`）·
 *     `POST /v1/embeddings`（`embed.vectors`）· `POST /api/embed/recompute/:id`（`embed.recompute`）
 *
 * ── ★ REST ↔ MCP 的「非同源」判定（本批最关键的一条结论；已由冒烟断言守住，防日后被"顺手统一"回去）──
 *   `POST /api/memory`（本模块 createManualMemory）与 MCP `memory_write`（server-reg-memory.js）
 *   **不是同一套语义** —— 逐条复核出 7 处实质差异，故**只迁 REST 一侧，server-reg-memory.js 零改动**：
 *     ① 写入者身份：REST 恒为 `human:dashboard`；MCP 走 `agentName()`/`agentFpath()`（**调用时**解析）。
 *     ② 去重闸门：MCP 有「幂等键 / 精确同文 / 事务内全量向量比对」三道闸（命中即 merge + bumpConfidence + foldInto）；
 *        REST 无任何去重 —— 同文重复提交即落两条。
 *     ③ 修订链：MCP 支持 `supersedes` + `version` 乐观栅 + `source_task_id` 因果链（旧条归档 archived）；
 *        REST 无（PUT 只改正文/类型/分区，**不重算向量、不挂因果链**）。
 *     ④ 入参面：MCP 无 `sector` / `sensitivity`（走 db 层缺省推导）；REST 显式收这两个字段并按枚举校验（非法 → 400）。
 *     ⑤ 审计落点：REST 写 `logUsage` + `logDaemon`（人工通道留痕 `manual-write`）；MCP 只写 `logUsage` + `stateReceipt`。
 *     ⑥ 特殊分支：MCP 见 `[task]` 状态头会**强制 type='task'** 并提示走 task_assign；REST 无此分支。
 *     ⑦ 输出形态：MCP 输出中文回执 + `stateReceipt`（并发冲突判定行）+ 写前检索硬门禁提示；REST 输出 `{ ok, id }`。
 *   强行合并必然造成行为漂移（B 批在 task 域已有同类判定：`task_next` ↔ `GET /api/tasks` 6 处差异 ⇒ 不合并）。
 *   `DELETE /api/memory/:id` 与 MCP `memory_feedback` 同属「软删」但同样**非同源**（门禁/状态前置校验/
 *   审计文案不同），且两者的共享部分本来就已是 db.js 的同一个 `rejectMemory` 入口 —— 无重复实现可消。
 *
 * ── ★ 边界（本批刻意，勿越界"统一"）──────────────────────────────────
 *   · handler 契约 = `(ctx, args) => 裸领域值`（ops-registry.js 定死）：**不含** HTTP 状态码 / reply 对象 /
 *     `{ ok }` 信封 / 错误文案。`reply.code(400/404/500/502/503)`、RESTRICTED 门禁、`{ ok:true, ... }` 包装
 *     一律留在传输层（dashboard-reg-memory.js）。
 *   · 未找到 / 校验不过用**裸哨兵**回传（不带状态码）：不存在 → `null`；db 层写被拒（如 sector 空串撞
 *     `memories.sector NOT NULL`）→ `{ error: <原文案> }`；嵌入失败 → `{ fail:"fake" }` / `{ fail:"error", message }`。
 *     ★ 校验**先后顺序与改前逐字一致**：content 非空（400）先于 sensitivity 合法性（400）；PUT 的
 *     id → type → sector 三条也是原顺序 —— 均在传输层按序执行，故「多项同时非法」的返回码不变。
 *   · ctx 取**实际用到的最小集**；**不静态 import** ML / 进程层（embed.js 的 `getEmbedder`、daemon.js 的
 *     `reembedStale`、sync-rules.js 的 `syncRules` 全经 ctx 注入）—— 避免 ops-registry 被加载时把
 *     543MB ONNX 运行时或「写用户真实规则文件」的副作用面拖进 MCP 工具面。
 *     db.js 的**数据层**函数按 task-domain.js 先例静态 import（纯 SQLite 访问，无 ML / 网络 / 进程副作用）。
 *   · 本域 6 条**均不使用调用方身份**（写入方恒为 `human:dashboard`），故无「调用时解析身份」的 accessor
 *     —— 「身份严禁在注册期冻成常量」的坑在此不适用（无身份可冻）。
 *   · `recomputeEmbeddings` **逐字保留既有事实**：原实现 `reembedStale(db, 1)` **不使用** `:id`（id 只作
 *     入参校验），本批只搬迁、不改行为 —— 改它属另一主题，须单独批次 + 单独验收。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────
 *   db.js（writeMemory / updateMemory / queryByType / rejectMemory / logUsage / logDaemon —— 数据层）
 */
import { writeMemory, updateMemory, queryByType, rejectMemory, logUsage, logDaemon } from "./db.js";

/**
 * 规则变更后的自动注入刷新（★ 批次⑦X2 原 `autoSyncRules` 逐字搬移）：幂等替换目标文件，毫秒级。
 * 失败绝不阻断业务请求 —— 记审计留痕，下次规则变更或手动同步再自愈。
 *
 * ★ 副作用面（必须知道）：`syncRules` 的落点是 **`os.homedir()` 下的真实规则文件**
 *   （`~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md`、`~/.trae-cn/user_rules/rule-memoryos.md` 等 7 处）。
 *   冒烟 / 隔离实例必须把 `USERPROFILE`/`HOME` 指到临时工作区，否则每跑一次都会改写用户真实规则文件。
 *
 * ctx 最小集：`{ db, syncRules }`
 */
export function syncRulesAfterRuleChange(ctx, reason) {
    const { db, syncRules } = ctx;
    try {
        syncRules(db);
        logDaemon(db, { task: "sync-rules", op: "auto-resync", operator: "system:auto", detail: `规则变更自动同步（${reason}）` });
    }
    catch (e) {
        try {
            logDaemon(db, { task: "sync-rules", op: "auto-resync-failed", operator: "system:auto", detail: String(e?.message ?? e) });
        }
        catch { /* 审计失败也不阻断 */ }
    }
}

/**
 * `POST /api/memory` —— 人工新建一条记忆。
 * 入参校验（content 非空 → 400、sensitivity 非法 → 400）留在传输层；本函数只在合法入参下执行。
 * @returns 裸领域值 `{ id }`（原实现返回 `{ ok:true, id }` —— `{ ok }` 信封由传输层补）
 * ctx 最小集：`{ db, getEmbedder, ALLOWED_TYPES, syncRules }`
 *   `ALLOWED_TYPES` = dashboard.js 顶层常量，形状按 type 白名单校验后回落 `experience`（**经 ctx 注入，
 *   不在本模块另造一份白名单**，避免"同名两份"重新长回来）。
 */
export async function createManualMemory(ctx, args = {}) {
    const { db, getEmbedder, ALLOWED_TYPES, syncRules } = ctx;
    const content = String(args.content ?? "").trim();
    const type = ALLOWED_TYPES.includes(args.type) ? args.type : "experience";
    const project = String(args.project ?? "global").trim() || "global";
    const sector = String(args.sector ?? "").trim() || undefined;
    const sensitivity = String(args.sensitivity ?? "normal").trim() || "normal";
    // P1-1: 人工沉淀必须进语义路——新建即嵌入向量；embed 失败降级 null 不阻塞建库
    let embedding = null;
    try {
        const [v] = await (await getEmbedder()).embedTexts([content]);
        embedding = v ?? null;
    }
    catch {
        embedding = null; // 嵌入暂不可用 → 建库照常，语义路下次 backfill 兜底
    }
    const row = writeMemory(db, { content, type, agent: "human:dashboard", agent_fpath: null, project, embedding, confidence: 0.8, sector, sensitivity });
    logUsage(db, { memory_id: row.id, event: "write", reader_agent: "human:dashboard", writer_agent: "human:dashboard", project: row.project });
    logDaemon(db, { task: "manual-write", op: "write", memory_id: row.id, operator: "human:dashboard", detail: `Dashboard 手动新建记忆（${type}）${embedding ? "（已嵌入）" : "（未嵌入）"}` });
    if (type === "rule")
        syncRulesAfterRuleChange({ db, syncRules }, `新建规则 #${row.id}`); // ★ 批次⑦X2：新建规则即自动注入刷新
    return { id: row.id };
}

/**
 * `PUT /api/memory/:id` —— 编辑记忆：content/type/sector 更新（同步 FTS；embedding 保持原值，v0.3 约定），
 * 另收 `inject` 开关（规则强制注入，只动本列，不碰 FTS/向量）。
 * @returns 记忆不存在 → `null`；db 层写被拒 → `{ error: <原文案> }`（传输层映射 400）；成功 → `{ id }`
 * ★ 原实现把 `updateMemory` 的异常 `String(e)` 直接当 400 文案回给前端（形如
 *   `Error: NOT NULL constraint failed: memories.sector`）—— 本函数原样保留该口径（`{ error }` 哨兵）。
 * ctx 最小集：`{ db, syncRules }`
 */
export function updateMemoryRow(ctx, args = {}) {
    const { db, syncRules } = ctx;
    const id = Number(args.id);
    const type = args.type;
    const sector = args.sector !== undefined ? String(args.sector).trim() : undefined;
    let row;
    try {
        row = updateMemory(db, id, { content: args.content, type, sector });
    }
    catch (e) {
        return { error: String(e) };
    }
    if (!row)
        return null;
    // ★ 批次⑦X2：inject 开关写入（规则强制注入）——只动本列，不碰 FTS/向量
    const injectChanged = args.inject !== undefined;
    if (injectChanged) {
        const inj = args.inject ? 1 : 0;
        db.prepare(`UPDATE memories SET inject=? WHERE id=?`).run(inj, row.id);
    }
    logDaemon(db, { task: "manual-edit", op: "edit", memory_id: row.id, operator: "human:dashboard", detail: "Dashboard 手动编辑记忆" });
    // ★ 批次⑦X2：规则内容/类型/注入开关变更 → 自动刷新注入段
    if (row.type === "rule" || type !== undefined || injectChanged)
        syncRulesAfterRuleChange({ db, syncRules }, `编辑 #${row.id}${injectChanged ? `（inject=${args.inject ? 1 : 0}）` : ""}`);
    return { id: row.id };
}

/**
 * `DELETE /api/memory/:id` —— 删除记忆/规则：软删（status='rejected'，走 db.js 统一软删入口）+ 审计留痕。
 * @returns 记忆不存在 → `null`；成功 → `{ id }`
 * ctx 最小集：`{ db, syncRules }`
 */
export function rejectMemoryRow(ctx, args = {}) {
    const { db, syncRules } = ctx;
    const id = Number(args.id);
    const old = db.prepare(`SELECT id, type FROM memories WHERE id=?`).get(id);
    if (!old)
        return null;
    rejectMemory(db, id, "human:dashboard");
    if (old.type === "rule")
        syncRulesAfterRuleChange({ db, syncRules }, `删除规则 #${id}`); // ★ 批次⑦X2：删规则即从注入段移除
    return { id };
}

/**
 * `GET /api/rules` —— 规则列表（type='rule'，默认只列 active）。
 * @returns `{ total, rows }`（行内字段与**键序**逐字同改前，含 ★ 批次⑦X2 的 `inject` 展示位）
 * ★ `limit` 由传输层用 dashboard.js 的 `clampLimit(query.limit, 500, 2000)` 归一后传入（属传输口径）；
 *   本函数原样透传给 db.js 的 `queryByType`（后者自身还有一层 [1,2000] 兜底）而不重复 clamp —— 与改前一致。
 * ctx 最小集：`{ db }`
 */
export function listRules(ctx, args = {}) {
    const db = ctx.db;
    const limit = args.limit ?? 500;
    const status = String(args.status ?? "").trim() || "active"; // 默认 active
    const rows = queryByType(db, "rule", { limit, status }).map((r) => ({
        id: r.id,
        content: r.content,
        type: r.type,
        agent: r.agent,
        project: r.project,
        status: r.status,
        confidence: r.confidence,
        eff: r.eff_confidence ?? r.confidence,
        hits: r.hit_count,
        created_at: r.created_at,
        inject: r.inject ? 1 : 0,   // ★ 批次⑦X2：强制注入开关（规则页展示）
    }));
    return { total: rows.length, rows };
}

/**
 * `POST /v1/embeddings` —— OpenAI 兼容共享嵌入端点（内核侧常驻真向量嵌入）。
 *   Electron 注入 EMBED_MODE=local（bge-m3 已在本进程加载）。MCP 侧 agent 配
 *   `EMBED_MODE=api` + `EMBED_API_URL=http://127.0.0.1:8787/v1/embeddings` + `EMBED_API_KEY=<data/token>`
 *   即共享同一份真向量语义：一份模型全端共享，agent 不必各载各的模型（省 N×GB 内存与启动耗时），
 *   并从此杜绝 MCP 侧 fake 向量混入真向量语料（半真半假比全假更糟）。
 *   鉴权：全局访问控制钩子已覆盖（?token= / x-memory-token / cookie / Bearer 任一）—— 属传输层，不在本层。
 *   入参校验（input 须为非空字符串或非空字符串数组 → 400 `input-required`）留在传输层。
 * @returns 成功 → OpenAI /v1/embeddings 同形 `{ object, model, data }`（**无 `{ ok }` 信封**，与改前一致）；
 *          内核以 fake 运行 → `{ fail:"fake" }`（传输层映射 503）；嵌入抛错 → `{ fail:"error", message }`（映射 502）
 * ctx 最小集：`{ getEmbedder }`
 */
export async function serveEmbeddings(ctx, args = {}) {
    const body = args ?? {};
    const input = (Array.isArray(body.input) ? body.input : [body.input ?? ""]).map((t) => String(t ?? ""));
    try {
        const embedder = await ctx.getEmbedder();
        if (embedder.mode === "fake")
            return { fail: "fake" };   // ⑥纪律：内核未以 EMBED_MODE=local/api 运行时宁可不服务，也不产出伪向量污染真向量语料
        const vectors = await embedder.embedTexts(input);
        return {
            object: "list",
            model: String(embedder.provenance?.().model ?? embedder.modelName ?? embedder.mode),
            data: vectors.map((v, i) => ({ object: "embedding", index: i, embedding: Array.from(v) })),
        };
    }
    catch (e) {
        return { fail: "error", message: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * `POST /api/embed/recompute/:id` —— ★ P0-2：手动触发单条记忆向量重算。
 * @returns `{ done, failed, pending }`（原实现返回 `{ ok:true, ... }` —— `{ ok }` 信封由传输层补）
 * ★ 既有事实（逐字保留，本批不改）：原实现调用 `reembedStale(db, 1)`，**`args.id` 只被传输层用于
 *   参数校验（非法 → 400），并未参与重算选择** —— 即「按 id 重算」实际是「补算最早的一条 stale」。
 *   这是既有语义，改动属另一主题（须单独批次 + 单独验收），本批不做。
 * ctx 最小集：`{ db, reembedStale }`
 */
export async function recomputeEmbeddings(ctx, _args = {}) {
    const r = await ctx.reembedStale(ctx.db, 1);
    return { done: r.done, failed: r.failed, pending: r.pending };
}
