/** T8（P2-3）：buildApp 路由域拆分 —— cards 域。
 * handler 自 dashboard.js 原行 1332-2396 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { logUsage, logDaemon, writeMemory, listWorkingMemory, setWorkingMemory, clearWorkingMemory, readMemory, readConfig, writeConfig, SECTORS, SECTOR_KEYS, updateMemory, setCardEvtPusher, createDispatch, settleDispatch, releaseDispatch } from "./db.js";
import { getEmbedder, cosine, bufToVec } from "./embed.js";
import { randomBytes } from "node:crypto";
import { TASK_NORMALIZE, CARD_TO_TASK } from "./task-status-map.js";
import { scanAgents, getScanCachedShared, scanAgentsAsync } from "./scan.js"; // 节点画布：智能体卡载体在位探测（agent_key 对账）
import { overridesOf } from "./dashboard-exec-util.js"; // ★ 批1：launch_overrides 解析与两个执行器同口径（含双重编码容错）
import { createCardsDomain } from "./cards-domain.js"; // ★ 批次 E1：cards 域领域层（helpers 单一真相源 + 14 条领域函数）
import { gateBreakerOn } from "./task-domain.js"; // ★ B3（P2）：门控连续失败熔断开关（与 daemon ③-b 同判据）
import { invokeOp } from "./ops-registry.js"; // ★ 批次 E1：E1 路由经操作注册表薄适配
import { cliAcceptsModel } from "./dashboard-reg-cliexec.js"; // ★ 批2：向导要如实告知「该载体填了模型会不会真传出去」
import fs from "node:fs";
import path from "node:path";
export function registerCards(app, ctx) {
    const { db, restricted, RESTRICTED } = ctx;
    // ═══════════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════════
    // ★ 批次 E1（2026-10-16 · 架构收敛第2条）：cards 域领域层实例 —— 全部共享 helper/常量已收进
    // cards-domain.js（原 15-359 / 553-562 / 1296-1302 / 1571-1586 / 1819-1907 行逐字搬移）。
    // 此处解构回**同名**标识符 → 尚未迁移的路由（E2：dispatch/SSE/跨域等）零调用点改动；
    // E1 的 14 条路由改经注册表薄适配（invokeOp → 裸领域值 → 按原协议包装，状态码/文案逐字节不变）。
    const cardsDom = createCardsDomain({ db, setCardEvtPusher });
    const { CARD_STATES, CARD_TRANSITIONS, CARD_LINK_KINDS, CARD_TO_SECTOR, DEP_SATISFIED, AGENT_NAME_RE,
        pushCardEvt, cardSubs, ensureEvtPoller, stopEvtPoller, cardRowOf, readCard, readCardMeta,
        txBegin, txCommit, txRollback, writeCardEvent, syncCardToTask, actorCredError,
        pendingDepends, cardDependsDone, depPendingMsg, finalizeCardDispatch, dependsPathExists,
        BASE_CARD_QUERY_FALLBACK, jdOf, jdNow, topicOfCardRow, getAllActiveVecs,
        CARD_TYPE_FLAGS, BUILTIN_TYPE_KEYS, PROFILE_CHANNELS, typeRowOf, profileOfCard,
        projectionCardOfProfile, scanKeysSafe, profileHasOverrideExe, carrierMissingFor,
        carrierMissingOf, validProfileChannel, workspaceError } = cardsDom;
    ctx.finalizeCardDispatch = finalizeCardDispatch; // ★ A1 收口回调（knowledge 域 run 终态）——接线不变，实体现由领域层提供
    /** 请求中的自我声明身份（单机单用户，README 已声明不防恶意本机调用，R4-6） */
    function asOf(req) {
        return String(req.query.as ?? "").trim() || "unassigned";
    }
    /** ★ 批次 E1：cards 域注册表派发上下文（领域实例 + db；RESTRICTED/协议校验留各路由适配器） */
    const CARDS_CTX = { db, cards: cardsDom };
    // —— 记忆类别（单一信源：前端筛选/着色/详情徽标）——
    app.get("/api/sectors", async () => {
        const rows = db.prepare(`SELECT sector, COUNT(*) c FROM memories GROUP BY sector`).all();
        const counts = new Map(rows.map((r) => [r.sector, r.c]));
        return {
            sectors: SECTOR_KEYS.map((k) => ({
                sector: k,
                cn: SECTORS[k]?.cn ?? k,
                desc: SECTORS[k]?.desc ?? "",
                lambda: SECTORS[k]?.lambda ?? 0,
                w: SECTORS[k]?.w ?? 1,
                count: counts.get(k) ?? 0,
            })),
        };
    });
    // —— H5 引用上报：last_seen_at + hit_count（V-H5：search 命中 1 分钟内可见）——
    app.post("/api/memory/hit", async (req, reply) => {
        const raw = req.body?.ids;
        const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : [];
        if (!ids.length)
            return reply.code(400).send({ ok: false, error: "ids 不能为空" });
        const now = new Date().toISOString();
        const upd = db.prepare(`UPDATE memories SET last_seen_at=?, hit_count=hit_count+1 WHERE id=?`);
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const id of ids)
                upd.run(now, id);
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return { ok: true, updated: ids.length };
    });
    // —— R5-8：secret 查看审计（本机前端详情页 allow_secret 查看时上报；不记内容）——
    app.post("/api/memory/:id/secret-view", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "非法 id" });
        const row = readMemory(db, id);
        if (!row)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        if (String(row.sensitivity ?? "normal") !== "secret")
            return { ok: true, noted: false }; // 非 secret 无需审计
        logUsage(db, {
            memory_id: id,
            event: "secret_view",
            reader_agent: String(req.query.as ?? "human:dashboard"),
            writer_agent: row.agent,
            project: row.project,
        });
        return { ok: true, noted: true };
    });
    // —— M7：计划 JSON → 卡片（同源幂等 + 状态分策略重应用）——
    app.post("/api/cards/apply-plan", async (req, reply) => {
        const plan = req.body?.plan;
        if (!plan || typeof plan !== "object" || !Array.isArray(plan.tasks)) {
            return reply.code(400).send({ ok: false, error: "缺少 plan.tasks 数组" });
        }
        const planId = String(plan.plan_id ?? plan.id ?? `plan-${Date.now()}`);
        const covered = ["triage", "todo", "ready"];
        const now = new Date().toISOString();
        let created = 0, overwritten = 0, staleMarked = 0, skipped = 0;
        const rows = db.prepare(`SELECT id, meta, status FROM cards WHERE meta LIKE '%"plan_id"%'`).all();
        const byKey = new Map();
        for (const r of rows) {
            try {
                const m = JSON.parse(r.meta ?? "{}");
                if (m.plan_id === planId && m.task_id != null)
                    byKey.set(`${planId}::${m.task_id}`, { id: r.id, status: r.status });
            }
            catch { /* meta 非 JSON 跳过 */ }
        }
        txBegin(); // ★ 修 #9：事务内事件入队，COMMIT 后统一推 SSE
        try {
            for (const t of plan.tasks) {
                const tid = String(t.id ?? t.task_id ?? "");
                if (!tid) {
                    skipped++;
                    continue;
                }
                const key = `${planId}::${tid}`;
                const title = String(t.title ?? "").trim() || `任务 ${tid}`;
                const priority = Number(t.priority ?? t.p1 ?? 0) || 0;
                const body = String(t.body ?? t.description ?? "").trim();
                const exist = byKey.get(key);
                if (!exist) {
                    const ins = db.prepare(`INSERT INTO cards(board, kind, title, body, status, priority, meta) VALUES ('default','task',?,?,'triage',?,?)`).run(title, body, priority, JSON.stringify({ plan_id: planId, task_id: tid }));
                    // ★ 修 #14：原直插 card_events 绕过 SSE —— 统一走 writeCardEvent（事务内自动入队）
                    writeCardEvent(Number(ins.lastInsertRowid), "dispatcher", "apply_plan", null, "triage", `计划 ${planId} 建卡`);
                    created++;
                    continue;
                }
                if (covered.includes(exist.status)) {
                    db.prepare(`UPDATE cards SET title=?, body=?, priority=?, updated_at=? WHERE id=?`).run(title, body, priority, now, exist.id);
                    writeCardEvent(exist.id, "dispatcher", "apply_plan", exist.status, exist.status, "计划更新原位覆盖");
                    overwritten++;
                }
                else {
                    // 进行中/已完成：不覆盖，评论 + stale_plan
                    db.prepare(`UPDATE cards SET meta=?, updated_at=? WHERE id=?`).run(JSON.stringify({ ...JSON.parse(rows.find((r) => r.id === exist.id)?.meta ?? "{}"), plan_id: planId, task_id: tid, stale_plan: true }), now, exist.id);
                    writeCardEvent(exist.id, "dispatcher", "plan_changed", exist.status, exist.status, "计划已变更，卡片保留当前状态");
                    db.prepare(`INSERT INTO card_comments(card_id, author, body, created_at) VALUES (?,'dispatcher','计划已变更（同源计划重应用），当前状态保留；如需执行新计划请重置状态。',?)`).run(exist.id, now);
                    staleMarked++;
                }
            }
            txCommit();
        }
        catch (e) {
            txRollback();
            throw e;
        }
        logDaemon(db, { task: "cards", op: "apply-plan", operator: "human:dashboard", detail: `计划 ${planId}：建 ${created} / 覆盖 ${overwritten} / stale ${staleMarked} / 跳过 ${skipped}` });
        return { ok: true, plan_id: planId, created, overwritten, staleMarked, skipped };
    });
    // —— H2 working 记忆（会话级独立表）——
    app.get("/api/working", async (req) => {
        const session = String(req.query.session ?? "").trim();
        if (!session)
            return { ok: true, items: [] };
        return { ok: true, items: listWorkingMemory(db, session) };
    });
    app.post("/api/working", async (req, reply) => {
        const b = req.body ?? {};
        const session = String(b.session ?? "").trim();
        const key = String(b.key ?? "").trim();
        const content = String(b.content ?? "").trim();
        if (!session || !key || !content)
            return reply.code(400).send({ ok: false, error: "session/key/content 必填" });
        setWorkingMemory(db, session, key, content, String(b.kind ?? "note").trim() || "note");
        return { ok: true };
    });
    app.delete("/api/working", async (req) => {
        const session = String(req.query.session ?? "").trim();
        if (!session)
            return { ok: false, removed: 0 };
        const key = String(req.query.key ?? "").trim();
        const removed = key ? clearWorkingMemory(db, session, key) : clearWorkingMemory(db, session);
        return { ok: true, removed };
    });
    // —— H6 前瞻记忆 due：cron 到期命中 + pattern 匹配会话文本（llm 默认关）。双消费：返回提醒 + auto 建卡 ——
    app.get("/api/prospective/due", async (req) => {
        const text = String(req.query.text ?? "").trim();
        const autoCard = String(req.query.auto_card ?? "1") !== "0";
        const now = new Date().toISOString();
        const rows = db
            .prepare(`SELECT ${BASE_CARD_QUERY_FALLBACK()} FROM memories
         WHERE sector='prospective' AND status='active'
           AND (valid_until IS NULL OR julianday(valid_until) > julianday('now'))
           AND (trigger_kind='cron' OR (trigger_kind='pattern' AND ? <> ''))`)
            .all(text);
        const due = [];
        const created = [];
        for (const r of rows) {
            const kind = String(r.trigger_kind ?? "pattern");
            let hit = false;
            if (kind === "cron") {
                // cron：valid_until 到期即命中（julianday 统一格式，兼容 ISO/空格两种写入）
                hit = !r.valid_until || jdOf(String(r.valid_until)) <= jdNow();
            }
            else if (kind === "pattern" && text) {
                const cond = String(r.trigger_cond ?? "");
                try {
                    hit = new RegExp(cond, "i").test(text);
                }
                catch {
                    hit = text.includes(cond);
                }
            }
            if (!hit)
                continue;
            // 防重放：已有 from_prospective 卡则不重复建
            if (autoCard) {
                // ★ 修 #6（2026-09-19）：原 meta LIKE '%"from_prospective":5%' 是子串匹配，
                //   `"from_prospective":55` 也命中 → #55 存在则 #5 永远建不出卡。改 json_extract 精确比对；
                //   json_valid 守卫防历史脏 meta 让 json_extract 抛 malformed JSON。
                const dup = db
                    .prepare(`SELECT id FROM cards WHERE kind='task'
                   AND json_extract(CASE WHEN json_valid(meta) THEN meta END, '$.from_prospective') = ? LIMIT 1`)
                    .get(r.id);
                if (!dup) {
                    const ins = db
                        .prepare(`INSERT INTO cards(board,kind,title,status,meta) VALUES ('default','task',?,'triage',?)`)
                        .run(String(r.trigger_action ?? r.content ?? "前瞻提醒").slice(0, 200), JSON.stringify({ from_prospective: r.id }));
                    writeCardEvent(Number(ins.lastInsertRowid), "dispatcher", "create", null, "triage", `前瞻命中自动建卡 #${r.id}`);
                    created.push({ card_id: Number(ins.lastInsertRowid), memory_id: r.id });
                }
            }
            due.push({ id: r.id, content: r.content, trigger_action: r.trigger_action, trigger_kind: kind, valid_until: r.valid_until });
        }
        return { ok: true, due, auto_created: created };
    });
    // —— M4 注入策略核对（≤20 条/4K token；semantic/episodic 各 ≤5，user/procedural 各 ≤3，prospective ≤3，affective ≤2，meta ≤2）——
    app.post("/api/inject", async () => {
        const budget = 20;
        const topBySector = (sector, n) => db
            .prepare(`SELECT id, content FROM memories WHERE sector=? AND status='active' AND sensitivity != 'secret'
           ORDER BY pinned DESC, COALESCE(last_seen_at, created_at) DESC, hit_count DESC LIMIT ?`)
            .all(sector, n).map((r) => ({ id: Number(r.id), content: r.content }));
        const sections = {
            user: topBySector("user", 3),
            procedural: topBySector("procedural", 3),
            semantic: topBySector("semantic", 5),
            episodic: topBySector("episodic", 5),
            prospective: topBySector("prospective", 3),
            affective: topBySector("affective", 2),
        };
        const total = Object.values(sections).reduce((s, a) => s + a.length, 0);
        return { ok: true, budget, total, sections };
    });
    // —— 卡片列表 / 新建 ——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::listCards（op `cards.list`）；查询入参原样透传（传输口径不变）。
    app.get("/api/cards", async (req) => {
        return await invokeOp("cards.list", {
            board: req.query.board, status: req.query.status, assignee: req.query.assignee,
            lane: req.query.lane, include_terminal: req.query.include_terminal,
        }, CARDS_CTX);
    });
    /** ★ 实时看板 SSE：卡片任何变更（经 writeCardEvent 中心点）即时推给前端；25s 心跳防断连。
     *  鉴权走全局 onRequest hook（同源 EventSource 自动带 memoryos_token cookie，与 /api/agent/runs/:id/stream 同体例）。
     *  注：静态路径 /api/cards/stream 优先于 /api/cards/:id 参数匹配（find-my-way 静态优先，同 /api/cards/archive）。 */
    app.get("/api/cards/stream", (req, reply) => {
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
        });
        const send = (s) => { try { reply.raw.write(s); } catch { /* 连接已断 */ } };
        send(": cards stream\n\n");
        const ping = setInterval(() => send(": ping\n\n"), 25000);
        cardSubs.add(send);
        ensureEvtPoller(); // 有订阅者才跑跨进程事件补流
        const detach = () => {
            clearInterval(ping);
            cardSubs.delete(send);
            if (!cardSubs.size)
                stopEvtPoller();
        };
        req.raw.on("close", detach);
        // ★ 写已断开的响应是异步 emit('error')，try/catch 抓不到；无监听 = 未捕获异常把整个
        //   dashboard 打死（同 streamJobSSE 那处的崩法）。故必须就地降级。
        reply.raw.on("error", detach);
    });
    // ★ 批次 E1：领域计算已收进 cards-domain.js::createCard（op `cards.create`）；
    //   RESTRICTED 与空标题 400 属协议校验留传输层；超长标题/重名/未知类型/非法状态由领域哨兵映射
    //   （判定顺序与改前一致；409 strict_dup 响应含 duplicate/count/ids 附加字段），文案逐字同改前。
    app.post("/api/cards", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const b = req.body ?? {};
        const title = String(b.title ?? "").trim();
        if (!title)
            return reply.code(400).send({ ok: false, error: "卡片标题不能为空" });
        const r = await invokeOp("cards.create", { b, strictDup: String((req.query || {}).strict_dup ?? "") === "1" }, CARDS_CTX);
        if (r?.error)
            return reply.code(r.conflict ? 409 : 400).send({ ok: false, error: r.error, duplicate: r.duplicate, count: r.count, ids: r.ids });
        return { ok: true, ...r };
    });
    // —— 卡片详情 / 更新 / 删除 ——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::readCardDetail（op `cards.one`）。
    app.get("/api/cards/:id", async (req, reply) => {
        const r = await invokeOp("cards.one", { id: Number(req.params.id) }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        return { ok: true, card: r.card };
    });
    app.put("/api/cards/:id", async (req, reply) => {
        const r = await invokeOp("cards.update", { id: Number(req.params.id), b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, id: r.id };
    });
    app.delete("/api/cards/:id", async (req, reply) => {
        const r = await invokeOp("cards.delete", { id: Number(req.params.id) }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true, removed: r.removed };
    });
    // —— CAS 认领（H3 ①）——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::claimCard（op `cards.claim`）；凭据 403 / CAS 竞争 409 由领域哨兵映射。
    app.post("/api/cards/:id/claim", async (req, reply) => {
        const r = await invokeOp("cards.claim", { id: Number(req.params.id), actor: asOf(req), credential: req.query.credential }, CARDS_CTX);
        if (r?.forbidden)
            return reply.code(403).send({ ok: false, error: r.error });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true, id: r.id, assignee: r.assignee, lock: r.lock };
    });
    // —— ★ A1 一键派发（对标 orca「one authoritative Task attempt」）——
    /* 一条龙：状态准入 → CAS 认领（claim_lock 即 dispatch_key 投影）→ 建工作证 → 起 agent run。
     * 与 /claim 的分工：/claim 是人手动认领；本端点是「把活推给 agent」——多两步（建 dispatch + 起 run），
     * 且起 run 失败整笔回滚（卡回 ready + 工作证释放），不留半开状态。
     * run 终态由 knowledge 域回调 ctx.finalizeCardDispatch 收口（review/failed + settleDispatch）。 */
    app.post("/api/cards/:id/dispatch-agent", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardDispatchAgent");
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const agent = String(b.agent ?? "").trim() || "dispatch-agent";
        const credErr = actorCredError(agent, b.credential ?? req.query.credential); // kebab 名硬模式需有效写凭据
        if (credErr)
            return reply.code(403).send({ ok: false, error: credErr });
        if (typeof ctx.startAgentRun !== "function")
            return reply.code(503).send({ ok: false, error: "run 域未就绪（startAgentRun 未注册）" });
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        let from = c.status;
        const pend = pendingDepends(id); // 一次算清：todo 提升与 409 文案共用同一判据（旧实现算两遍且各说各话）
        // todo 且依赖已满足 → 先提升 ready（与 /api/dispatch 调度器同口径），派发少一步手动流转
        if (from === "todo" && !pend.length) {
            db.prepare(`UPDATE cards SET status='ready', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='todo'`).run(id);
            writeCardEvent(id, agent, "promote", "todo", "ready", "派发前置：依赖已满足");
            from = "ready";
        }
        // 状态卡点优先（triage/running/done… 说状态）；todo 卡住的真实原因多半是依赖 → 说依赖并列卡号
        if (from !== "ready")
            return reply.code(409).send({
                ok: false,
                error: from === "todo" && pend.length
                    ? depPendingMsg(pend)
                    : `卡片状态「${from}」不可派发（需可认领 ready）`,
            });
        if (pend.length)
            return reply.code(409).send({ ok: false, error: depPendingMsg(pend) });
        // 关联任务记忆（与 syncCardToTask 同口径：ref 优先，其次 card_memory dispatch 关联）
        const memRow = (c.ref_kind === "memory" && c.ref_id
            ? db.prepare(`SELECT id FROM memories WHERE id=?`).get(c.ref_id)
            : undefined) ??
            db.prepare(`SELECT memory_id id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(id);
        const taskId = memRow ? Number(memRow.id) : null;
        const lock = randomBytes(12).toString("hex");
        let dsp = null;
        let dispatchEdgeId = null; // 节点画布：本次派发写下的边（连线派发时返回给前端）
        const agentCardId = Number(b.agent_card_id) || 0; // 节点画布：目标智能体卡（0=未指定；tx 内校验存在性）
        txBegin(); // 认领 + 建工作证一笔事务：任一步失败整笔回滚（事件先入队、COMMIT 后推）
        try {
            const info = db
                .prepare(`UPDATE cards SET status='running', assignee=?, claim_lock=?,
               lease_expires_at=datetime('now','+10 minutes'), heartbeat_at=datetime('now'), updated_at=datetime('now')
             WHERE id=? AND status='ready' AND claim_lock IS NULL`)
                .run(agent, lock, id);
            if (Number(info.changes) === 0)
                throw new Error("认领竞争：卡片已不在 ready 或已被认领");
            if (taskId) {
                dsp = createDispatch(db, { key: lock, memoryId: taskId, agent, leaseMinutes: 10 }); // 同任务旧尝试 → 自动 supersede 换代
                // ★ 补链（2026-10-04 多 agent 协作联调）：ref 关联卡（from-memory 建的是 'reference'、import-legacy 无行）
                //   缺 'dispatch' 关系 → run 内 task_done 的 syncTaskToCard 定位不到卡 → 卡留 running → 收口把
                //   done 头经 E-0(review→in_progress) 投影回退。task_assign 建卡本就双写，此处幂等补齐同一口径。
                db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(id, taskId);
            }
            // ★ 节点画布（D3/D11 连线派发）：任务卡→智能体卡派发边锚定本次工作证；同对旧 active 边翻 superseded。
            //   与认领/工作证同一事务：目标卡校验失败整笔回滚，不留半截边。
            if (agentCardId) {
                if (!db.prepare(`SELECT id FROM cards WHERE id=? AND kind='agent'`).get(agentCardId))
                    throw new Error("目标智能体卡不存在（须为智能体类型投影卡）");
                db.prepare(`UPDATE card_edges SET status='superseded' WHERE source_id=? AND target_id=? AND kind='dispatch' AND status='active'`).run(id, agentCardId);
                const eIns = db.prepare(`INSERT INTO card_edges(source_id,target_id,kind,dispatch_id,status) VALUES (?,?,'dispatch',?,'active')`)
                    .run(id, agentCardId, dsp ? dsp.id : null);
                dispatchEdgeId = Number(eIns.lastInsertRowid);
            }
            writeCardEvent(id, agent, "dispatch", "ready", "running", dsp
                ? `一键派发（工作证 gen=${dsp.generation}${dsp.superseded ? `，取代 #${dsp.superseded}` : ""} · run 启动中）`
                : "一键派发（无关联任务记忆，仅卡级认领 · run 启动中）");
            txCommit();
        }
        catch (e) {
            try { txRollback(); }
            catch (e2) { console.error("[cards] 派发事务回滚异常（卡片可能滞留 running，需调度器/人工核对）", e2); }
            console.error(`[cards] #${id} 派发事务失败（409 回显调用方）`, e);
            return reply.code(409).send({ ok: false, error: String(e instanceof Error ? e.message : e) });
        }
        syncCardToTask(id, { assignee: agent }); // 头回写 running + assignee（与 /claim 同口径）
        // ★ P4 前情注入：本卡的 active 注入边 → 上游交接文档进 run 提示词头部（下游开局即有上下文）
        const handoffs = db.prepare(`SELECT h.title title, h.body body FROM card_edges e JOIN cards h ON h.id = e.source_id
            WHERE e.target_id=? AND e.kind='inject' AND e.status='active' ORDER BY e.id`).all(id);
        const handoffBlock = handoffs.length
            ? (`【前情提要（来自上游交接文档，全文按需检索）】\n` + handoffs.map((h) => `· ${h.title}：\n${String(h.body ?? "").slice(0, 1500)}`).join("\n---\n")).slice(0, 3000) // ★ 详版注入：单条 1500/总量 3000（有界，防撞 run 提示词上限）
            : "";
        // 起 run：提示词内嵌卡片正文（agent 无卡片读工具），并给足收口指令
        // ★ P2/P3 通道分流：智能体卡 channel='cli' → CLI 直控执行器；'cdp' → CDP 驾驶执行器；queue → 内部 agent run
        // （计算必须先于 message 构建——交接要求行按通道分支引用 channel）
        const agentProfile = agentCardId ? profileOfCard(db.prepare(`SELECT * FROM cards WHERE id=?`).get(agentCardId)) : null;
        const channel = agentProfile ? String(agentProfile.channel) : "queue";
        const message = [
            `【一键派发】你被指派处理 MemoryOS 看板卡片 #${id}（认领人 ${agent}）。`,
            // ★ 根治批（2026-10-06）：工作空间与模型随派发词下发 —— CDP 驾驶的聊天类载体（如 WorkBuddy）
            //   进程 cwd 传不进它的会话，提示词是唯一载体；不带这两行，智能体「不知道在哪干活、用什么模型」（用户实测）。
            ...(agentProfile?.workspace ? [`工作空间：${agentProfile.workspace}（所有文件操作都在此目录内进行）`] : []),
            ...(agentProfile?.model ? [`使用模型：${agentProfile.model}`] : [`使用模型：（未指定——用你当前的默认模型即可）`]),
            taskId
                ? `关联任务 #${taskId}，工作证 dispatch_key=${lock}：干完必须调用 task_done(memory_id=${taskId}, conclusion="<≤200字结论>", dispatch_key="${lock}")。`
                : `本卡未关联任务记忆：不要调用 task_done，结论直接写在最终回复里。`,
            ...(handoffBlock ? [handoffBlock] : []),
            `标题：${String(c.title ?? "").slice(0, 120)}`,
            `正文：${String(c.body ?? "").trim().slice(0, 2500) || "（空卡：先自行调研再给可执行结论）"}`,
            `要求：① 先查上下文（memory_search/memory_read，或 task_next 看全局任务）再动手；② 结论须可验收，不确定处显式标注不确定性；③ 中途不要改卡片状态（由系统按 run 终态自动收口）。`,
            // ★ CLI 通道收口靠分隔符协议（D7）：提示词里明确详版交接的分节要求
            ...(channel === "cli" ? [`交接要求：结束前必须输出 <<<HANDOFF>>> … <</HANDOFF>>> 详版交接段，分节写：【结论】【改动文件】【踩坑与规避】【遗留与建议】，尽量具体，写全给下一个人看。`] : []),
        ].join("\n");
        let started;
        try {
            if (channel === "cli") {
                if (typeof ctx.startCliRun !== "function")
                    throw new Error("CLI 直控执行器未就绪"); // ★ 抛出走统一回滚分支（503 早退会留下已认领的 running 卡+工作证）
                // ★ agent 必须透传：收口 finalizeCardDispatch 按 assignee===actor 比对，漏传则回退默认
                //   "dispatch-agent"，与派发时写进 assignee 的 agent 名不等 → 状态翻转被静默跳过，
                //   卡永远停 running、锁不释放（queue 通道 cardDispatch.actor 本就传，CLI/CDP 漏了）。
                started = await ctx.startCliRun({
                    cardId: id, agentCardId, profile: agentProfile, dispatchId: dsp ? dsp.id : null, dispatchKey: lock, taskId, message, agent,
                });
            }
            else if (channel === "cdp") {
                if (typeof ctx.startCdpRun !== "function")
                    throw new Error("CDP 驾驶执行器未就绪"); // 同上
                // 同上：CDP 通道同样必须透传 agent，否则收口比对失败、卡滞留 running（见 CLI 分支注释）
                started = await ctx.startCdpRun({
                    cardId: id, agentCardId, profile: agentProfile, dispatchId: dsp ? dsp.id : null, dispatchKey: lock, taskId, message, agent,
                });
            }
            else {
                started = await ctx.startAgentRun({
                    message, allowWrites: true, title: `🚀 ${String(c.title ?? "卡片派发").slice(0, 50)}`,
                    taskHint: taskId ?? undefined,
                    cardDispatch: { cardId: id, dispatchId: dsp ? dsp.id : null, dispatchKey: lock, taskId, actor: agent },
                });
            }
        }
        catch (e) {
            // 起 run 失败 → 回滚认领 + 释放工作证（不留半开状态，卡片回到可派发）
            console.error(`[cards] #${id} 起 run 失败（认领将回滚至 ready）`, e);
            txBegin();
            try {
                db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='running' AND claim_lock=?`).run(id, lock);
                if (dsp)
                    releaseDispatch(db, dsp.id, `起 run 失败：${e instanceof Error ? e.message : e}`);
                if (dispatchEdgeId)
                    db.prepare(`UPDATE card_edges SET status='cancelled' WHERE id=? AND status='active'`).run(dispatchEdgeId);
                writeCardEvent(id, agent, "dispatch_failed", "running", "ready", String(e instanceof Error ? e.message : e).slice(0, 160));
                txCommit();
            }
            catch (e2) {
                try { txRollback(); }
                catch (e3) { console.error("[cards] 起 run 失败的回滚自身异常（半开状态风险：卡片可能滞留 running，需人工/调度器核对）", e3); }
            }
            syncCardToTask(id, { assignee: "" }); // 头随卡回到 ready 并清 assignee
            return reply.code(503).send({ ok: false, error: `起 run 失败（认领已回滚）：${e instanceof Error ? e.message : e}` });
        }
        return reply.code(202).send({
            ok: true, id, runId: started.runId, status: started.status, cap: started.cap ?? null,
            queueAhead: started.queueAhead ?? null, agent, assignee: agent, taskId,
            channel, executor: channel === "cli", queued: !!started.queued,
            dispatch: dsp ? { id: dsp.id, key: lock, generation: dsp.generation, superseded: dsp.superseded ?? null } : null,
            edgeId: dispatchEdgeId, // 节点画布：本次连线派发写下的边
        });
    });
    // —— 状态流转（H3 ②：WHERE status=expected_from 前置校验 + 白名单）——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::transitionCard（op `cards.status`）；
    //   非法状态 400 / 迁移白名单·验收门·TOCTOU 409 / 凭据·认领者 403 由领域哨兵映射，文案逐字同改前。
    app.post("/api/cards/:id/status", async (req, reply) => {
        const b = req.body ?? {};
        const r = await invokeOp("cards.status", {
            id: Number(req.params.id), b,
            actor: String(b.as ?? "").trim() || asOf(req),
            credential: b.credential ?? req.query.credential,
        }, CARDS_CTX);
        if (r?.forbidden)
            return reply.code(403).send({ ok: false, error: r.error });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, id: r.id, from: r.from, to: r.to };
    });
    // —— M2 验收：review → done（meta.acceptance 存在时必须走此端点）——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::acceptCard（op `cards.accept`）；凭据 403 / 非 review 409 由领域哨兵映射。
    app.post("/api/cards/:id/accept", async (req, reply) => {
        const r = await invokeOp("cards.accept", {
            id: Number(req.params.id),
            actor: String(req.body?.as ?? "").trim() || "human:dashboard",
            credential: req.body?.credential ?? req.query?.credential,
        }, CARDS_CTX);
        if (r?.forbidden)
            return reply.code(403).send({ ok: false, error: r.error });
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true, id: r.id };
    });
    // —— M1 refine：LLM 生成 steps/acceptance 建议（以评论返回，用户确认后写 meta）——
    app.post("/api/cards/:id/refine", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        // P3 先落骨架评论（LLM 精炼接入放 P4）；前端展示"待细化"引导
        db.prepare(`INSERT INTO card_comments(card_id, author, body) VALUES (?,?,?)`).run(id, "dispatcher", `[refine] 卡片待细化：请补充 steps / acceptance_criteria 后写回 meta（P4 接入 LLM 建议）`);
        writeCardEvent(id, "dispatcher", "auto_refine", null, null, "触发细化建议");
        return { ok: true, id, hint: "已写细化提示评论（LLM 建议待 P4）" };
    });
    // —— 评论（Agent 间协议；H4/R5-3：secret 内容扫描拒绝）——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::addCardComment（op `cards.comment.add`）；
    //   空评论 400 / 卡不存在 404 / secret 扫描 403 由领域哨兵映射（判定顺序与改前一致），文案逐字同改前。
    app.post("/api/cards/:id/comment", async (req, reply) => {
        const r = await invokeOp("cards.comment.add", { id: Number(req.params.id), b: req.body ?? {} }, CARDS_CTX);
        if (r?.forbidden)
            return reply.code(403).send({ ok: false, error: r.error });
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, id: r.id };
    });
    app.get("/api/cards/:id/comments", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "非法 id" });
        const r = await invokeOp("cards.comments.list", { id }, CARDS_CTX);
        return { ok: true, comments: r.comments };
    });
    app.get("/api/cards/:id/events", async (req, reply) => {
        const r = await invokeOp("cards.events.read", { id: Number(req.params.id), since: String(req.query.since ?? "").trim() }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        return { ok: true, events: r.events, comments: r.comments, latest: r.latest };
    });
    // —— H1 卡片互链：写统一 links 表 + depends 成环校验 ——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::addCardLink（op `cards.link.add`）；
    //   非法关系/前置类型 400、成环/重复边 409（含 already_exists 附加字段）、404 由领域哨兵映射，文案逐字同改前。
    app.post("/api/cards/:id/links", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardLink");
        const r = await invokeOp("cards.link.add", { id: Number(req.params.id), b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error, already_exists: r.already_exists, from: r.from, to: r.to, kind: r.kind });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, from: r.from, to: r.to, kind: r.kind };
    });
    app.delete("/api/cards/:id/links", async (req, reply) => {
        const r = await invokeOp("cards.link.delete", { id: Number(req.params.id), dst: Number(req.query.dst_card_id), kind: String(req.query.kind ?? "depends").trim() }, CARDS_CTX);
        if (r?.missing)
            return reply.code(404).send({ ok: false, error: r.error });
        return { ok: true, removed: r.removed };
    });
    // —— 卡片 ↔ 记忆 关联 ——
    app.post("/api/cards/:id/memory", async (req, reply) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const memoryId = Number(b.memory_id);
        const relation = String(b.relation ?? "context").trim() || "context";
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (!db.prepare(`SELECT id FROM memories WHERE id=?`).get(memoryId))
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,?)`).run(id, memoryId, relation);
        return { ok: true, card_id: id, memory_id: memoryId, relation };
    });
    app.delete("/api/cards/:id/memory", async (req, reply) => {
        const id = Number(req.params.id);
        const memoryId = Number(req.query.memory_id);
        db.prepare(`DELETE FROM card_memory WHERE card_id=? AND memory_id=?`).run(id, memoryId);
        return { ok: true };
    });
    // —— 心跳续租（R6-4：常规续窗不写 events）——
    // ★ 批次 E1：领域计算已收进 cards-domain.js::heartbeatCard（op `cards.heartbeat`）；凭据 403 / 冲突 409 由领域哨兵映射，文案逐字同改前。
    app.post("/api/cards/:id/heartbeat", async (req, reply) => {
        const r = await invokeOp("cards.heartbeat", { id: Number(req.params.id), actor: String(req.body?.as ?? "").trim(), credential: req.body?.credential ?? req.query?.credential }, CARDS_CTX);
        if (r?.forbidden)
            return reply.code(403).send({ ok: false, error: r.error });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true, id: r.id };
    });
    // —— M6 卡片 → 记忆（sector 映射表）——
    app.post("/api/cards/:id/to-memory", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardToMemory");
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const sector = CARD_TO_SECTOR[c.kind] ?? (c.kind === "question" ? "semantic" : "social");
        const row = writeMemory(db, {
            content: `${c.title}${c.body ? "\n\n" + c.body : ""}`,
            type: "task",
            agent: "human:dashboard",
            agent_fpath: null,
            project: String(req.body?.project ?? "global").trim() || "global",
            sector,
            source_ref: `card:${c.id}`,
            confidence: 0.7,
        });
        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'output')`).run(c.id, row.id);
        return { ok: true, memory_id: row.id, sector };
    });
    // —— 万物卡片化：记忆 → 卡片 / 笔记 → 卡片 / 历史 task 导入 ——
    app.post("/api/cards/from-memory/:id", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const memoryId = Number(req.params.id);
        const m = db.prepare(`SELECT id, content, sector FROM memories WHERE id=?`).get(memoryId);
        if (!m)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(memoryId);
        if (dup)
            return { ok: true, id: dup.id, existed: true };
        const ins = db.prepare(`INSERT INTO cards(board,kind,title,status,ref_kind,ref_id,meta) VALUES ('default','memory',?,'triage','memory',?,?)`)
            .run(m.content.slice(0, 120), memoryId, JSON.stringify({ from_sector: m.sector ?? "episodic" }));
        const id = Number(ins.lastInsertRowid);
        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'reference')`).run(id, memoryId);
        writeCardEvent(id, "human:dashboard", "create", null, "triage", `由记忆 #${memoryId} 转化`);
        return { ok: true, id, existed: false };
    });
    app.post("/api/cards/from-note/:id", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const noteId = Number(req.params.id);
        const n = db.prepare(`SELECT id, title, body FROM notes WHERE id=?`).get(noteId);
        if (!n)
            return reply.code(404).send({ ok: false, error: "笔记不存在" });
        const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='note' AND ref_id=?`).get(noteId);
        if (dup)
            return { ok: true, id: dup.id, existed: true };
        const ins = db.prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id) VALUES ('default','note',?,?,'triage','note',?)`)
            .run(n.title, (n.body ?? "").slice(0, 2000) || null, noteId);
        const id = Number(ins.lastInsertRowid);
        writeCardEvent(id, "human:dashboard", "create", null, "triage", `由笔记 #${noteId} 转化`);
        return { ok: true, id, existed: false };
    });
    app.post("/api/cards/import-legacy", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const tasks = db
            .prepare(`SELECT id, content, created_at FROM memories WHERE type='task' AND status IN ('active','trial') ORDER BY id`)
            .all();
        let created = 0;
        let skipped = 0;
        const ins = db.prepare(`INSERT INTO cards(board,kind,title,status,ref_kind,ref_id,meta,created_at) VALUES ('default','task',?,'todo','memory',?,?,?)`);
        for (const t of tasks) {
            const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(t.id);
            if (dup) {
                skipped++;
                continue;
            }
            // R1-5：剥离约定头
            const title = t.content.replace(/^\[task\]\[[^\]]*\]*\[[^\]]*\]\[[^\]]*\]\s*/g, "").split("\n")[0].slice(0, 120) || `task #${t.id}`;
            const r = ins.run(title, t.id, JSON.stringify({ legacy: true }), t.created_at);
            writeCardEvent(Number(r.lastInsertRowid), "human:dashboard", "create", null, "todo", `历史任务导入 #${t.id}`); // ★ 修 #14：导入卡此前零事件
            created++;
        }
        return { ok: true, scanned: tasks.length, created, skipped };
    });
    // —— ★ 2026-09-14 补齐：任务地图数据源 / 位置持久化 / 归档策略 / 卡片↔MCP 任务（前端 9/13 重构先行，后端补齐）——
    // 取全部 active 非 secret 记忆向量（跨 project；卡片无语义归属，需匹配全库）
        // 任务地图：nodes + links（卡片互链 + card_memory 关联 + aux 辅助卡挂载边）。前端消费字段见任务地图 drawTaskMap。
    app.get("/api/cards/graph", async (req) => {
        // ★ 2026-10-05 批1：节点补 `topic` 字段（前端「排布 · 主题聚类」需要）——
        //   cardRowOf 刻意不返回 topic（避免改 /api/cards 响应体），故这里从原始行取并复用 topicOfCardRow 同口径。
        const nodeRows = db.prepare(`SELECT id, board, kind, title, body, status, assignee, priority, meta, ref_kind, ref_id, created_at, topic FROM cards ORDER BY priority DESC, id`).all();
        const nodes = nodeRows.map(cardRowOf).map((c, i) => ({
            id: c.id, board: c.board, kind: c.kind, title: c.title, body: c.body, status: c.status, assignee: c.assignee,
            priority: Number(c.priority ?? 0), meta: readCardMeta(c), ref_kind: c.ref_kind, ref_id: c.ref_id,
            created_at: c.created_at, topic: topicOfCardRow(nodeRows[i]),
        }));
        const cardIds = new Set(nodes.map((n) => n.id));
        // 卡片单向链：depends/blocks/relates/spawned_by/duplicates + kind='aux_*' 辅助挂载边
        const cardLinks = db.prepare(`SELECT src_id, dst_id, kind, context FROM links WHERE src_kind='card' AND dst_kind='card' AND dst_id IS NOT NULL`).all();
        // card_memory 关联 → aux 记忆节点（kind='aux_memory'，前端作为辅助卡挂载，不参与任务分层）
        const memRows = db.prepare(`SELECT cm.card_id, cm.memory_id, cm.relation, m.content, m.sensitivity FROM card_memory cm LEFT JOIN memories m ON m.id=cm.memory_id WHERE m.sensitivity != 'secret'`).all();
        const links = [...cardLinks];
        for (const m of memRows) {
            if (!cardIds.has(m.card_id))
                continue;
            // ★ 记忆子卡用负整数占位 id（卡片 id 恒为正，负 id 天然不冲突；前端 Number 索引可正常工作）
            const memId = -(1000000 + m.memory_id);
            nodes.push({ id: memId, board: "default", kind: "aux_memory", title: (m.content ?? `记忆#${m.memory_id}`).replace(/\s+/g, " ").slice(0, 60), body: null, status: "", assignee: null, priority: 0, meta: {}, ref_kind: null, ref_id: null, created_at: "", topic: "" });
            links.push({ src_id: m.card_id, dst_id: memId, kind: "aux_memory", context: m.relation });
        }
        // ★ 2026-09-14 v2：自动关联（仅展示不落库；?auto=0 关闭）。升级为语义路：
        //   · 连线：任务卡两两「标题+正文」嵌入向量余弦相似 → relates_auto 虚线（语义近似，非词枚举）
        //   · 子卡：任务卡「标题+正文」向量 vs 记忆库 active 记忆向量余弦 → 相似记忆 aux_memory 子卡
        //   记忆向量直接取（免重算）；卡向量实时 embed（卡量少可承受）。embedding 失败 → 静默降级（不连线不补卡）。
        if (String(req.query.auto ?? "0") !== "0") {
            const tasks = nodes.filter((n) => !(String(n.kind).startsWith("aux_")));
            try {
                const embedder = await getEmbedder();
                // 任务卡文本 = 标题 + 正文（截 600 字，够表达语义；卡无向量）
                const cardText = new Map();
                tasks.forEach((n) => cardText.set(n.id, `${n.title}\n${String(n.body ?? "").slice(0, 600)}`.trim()));
                // ★ 修 #13：先查缓存，只重嵌缺失/已变更的卡（顺序与 tasks 对齐）
                const keyList = tasks.map((n) => `${n.id}:${cardText.get(n.id) ?? ""}`);
                const cardVecs = new Array(tasks.length);
                const needIdx = [];
                keyList.forEach((k, i) => {
                    const hit = cardVecCache.get(k);
                    if (hit)
                        cardVecs[i] = hit;
                    else
                        needIdx.push(i);
                });
                if (needIdx.length) {
                    const fresh = await embedder.embedTexts(needIdx.map((i) => cardText.get(tasks[i].id) ?? ""));
                    needIdx.forEach((i, j) => {
                        cardVecs[i] = fresh[j];
                        if (cardVecCache.size > 2000)
                            cardVecCache.clear();
                        cardVecCache.set(keyList[i], fresh[j]);
                    });
                }
                if (cardVecs[0] && cardVecs[0].length) {
                    const vecByCard = new Map();
                    tasks.forEach((n, i) => vecByCard.set(n.id, cardVecs[i]));
                    // ① 连线：任务卡两两余弦 ≥0.55 → relates_auto 虚线
                    const CONNECT_SIM = 0.55;
                    const autoSeen = new Set();
                    for (let i = 0; i < tasks.length; i++) {
                        for (let j = i + 1; j < tasks.length; j++) {
                            const ia = tasks[i].id, ib = tasks[j].id;
                            const s = cosine(vecByCard.get(ia), vecByCard.get(ib));
                            if (s < CONNECT_SIM)
                                continue;
                            const key = Math.min(ia, ib) + ">" + Math.max(ia, ib);
                            if (autoSeen.has(key))
                                continue;
                            autoSeen.add(key);
                            links.push({ src_id: ia, dst_id: ib, kind: "relates_auto", context: `语义相似 ${s.toFixed(2)}`, auto: true });
                        }
                    }
                    // ② 子卡：任务卡向量 vs 记忆库 active 记忆向量 → 相似记忆 aux_memory
                    const SUB_SIM = 0.5;
                    const memById = new Map(getAllActiveVecs().map((v) => [v.id, v.vec]));
                    const seenMemNodes = new Set(nodes.map((n) => String(n.id)));
                    const memByCard = new Set(memRows.map((m) => m.card_id + ":" + m.memory_id));
                    const memContent = new Map(); // 需要时再补拉 content（仅命中者）
                    const fetchMem = (ids) => {
                        if (!ids.length)
                            return;
                        const ph = ids.map(() => "?").join(",");
                        db.prepare(`SELECT id, content FROM memories WHERE id IN (${ph})`).all(...ids).forEach((r) => memContent.set(r.id, r.content));
                    };
                    const pending = [];
                    for (const card of tasks) {
                        const cv = vecByCard.get(card.id);
                        const scored = [...memById.entries()]
                            .map(([mid, mv]) => ({ mid, s: cosine(cv, mv) }))
                            .filter((x) => x.s >= SUB_SIM)
                            .sort((a, b) => b.s - a.s)
                            .slice(0, 3); // 每卡最多 3 个语义相似子卡
                        for (const hit of scored) {
                            const memId = -(1000000 + hit.mid);
                            if (memByCard.has(card.id + ":" + hit.mid))
                                continue;
                            if (!seenMemNodes.has(String(memId))) {
                                pending.push(hit.mid);
                                seenMemNodes.add(String(memId));
                                nodes.push({ id: memId, board: "default", kind: "aux_memory", title: "", body: null, status: "", assignee: null, priority: 0, meta: {}, ref_kind: null, ref_id: null, created_at: "" });
                            }
                            links.push({ src_id: card.id, dst_id: memId, kind: "aux_memory", context: `语义匹配 · ${hit.s.toFixed(2)}`, auto: true });
                        }
                    }
                    // 补拉命中的记忆正文 → 填子卡 title
                    fetchMem(pending);
                    nodes.forEach((n) => {
                        if (typeof n.id === "number" && n.id < 0 && String(n.kind).startsWith("aux_")) {
                            const mid = (-n.id) - 1000000;
                            const c = memContent.get(mid) ?? "";
                            n.title = c.replace(/\s+/g, " ").slice(0, 80) || `记忆#${mid}`;
                        }
                    });
                }
            }
            catch {
                // embedding 不可用 → 静默跳过自动关联（不崩溃）
            }
        }
        // 序列化统一转字符串（数字卡片 id 与 "mem-N" 字符串 id 均可；前端 Number() 容错数字）
        const serializable = (v) => String(v);
        // ★ 2026-09-15（看板 58→25 根治）：状态语义归一。给每个节点补 bucket：
        //   active（todo/triage/ready/running/blocked/failed=未完成且需要关注）/ done / terminal（archived/cancelled=已终结）
        //   aux 子卡无任务状态 → bucket=null。前端未完成计数只取 bucket==='active'，终结态不再混入。
        //   ★ 修 #15（2026-09-19）：failed 移出终结桶 —— 迁移白名单允许 failed→todo/blocked 恢复，
        //   归 terminal 会让未完成计数漏掉待恢复的失败卡。
        const TERMINAL = new Set(["archived", "cancelled"]);
        const nodesWithBucket = nodes.map((n) => {
            const kind = String(n.kind ?? "");
            const bucket = kind.startsWith("aux_") || kind === "aux" ? null
                : n.status === "done" ? "done"
                    : TERMINAL.has(String(n.status)) ? "terminal"
                        : "active";
            return { ...n, bucket };
        });
        // ★ 节点画布：边持久化实体（card_edges）随图返回；智能体卡附载体在位标记（探测失败降级不阻断出图）
        let edges = [];
        try {
            edges = db.prepare(`SELECT id, source_id, target_id, kind, dispatch_id, status FROM card_edges ORDER BY id`).all()
                .map((e) => ({ ...e, source_id: serializable(e.source_id), target_id: serializable(e.target_id) }));
        }
        catch { /* 旧库未迁移时降级为无边 */ }
        try {
            // ★ 2026-10-15（第三批）：await 共享探测——冷启动首屏若 worker 预热未完成，
            //   等同一份结果（事件循环不被 spawnSync 堵，其他请求并行）而非降级丢载体标记。
            const _scanV = getScanCachedShared() ?? (await scanAgentsAsync());
            const scanKeys = _scanV ? new Set((_scanV.agents ?? []).map((a) => String(a.id ?? ""))) : scanKeysSafe();
            if (scanKeys)
                for (const n of nodesWithBucket) {
                    if (n.kind !== "agent")
                        continue;
                    const pid = Number(n.meta?.profile_id) || 0;
                    // ★ 2026-10-05：与 agent-profiles / agent-cards/:id/state 统一走 carrierMissingOf。
                    //   原实现只比 scanKeys：launch_overrides 已给 exe/cmd 的档案、以及 queue 通道/
                    //   未绑档案的智能体卡，都在任务地图被误报「⚠️ 载体缺失」。
                    const prof = pid ? db.prepare(`SELECT agent_key, channel, launch_overrides FROM agent_profiles WHERE id=?`).get(pid) : null;
                    n.profileMissing = carrierMissingOf(prof, scanKeys);
                    // ★ 2026-10-05 批1：通道随节点下发。派发目标选择器要按通道如实标注 ——
                    //   queue 卡派了不会拉起任何外部智能体（用户报「派发后智能体卡不控制智能体」的头号形态），
                    //   原来只有一个 profileMissing 布尔，说不清「为什么点了没反应」。
                    n.profileChannel = String(prof?.channel ?? "queue");
                }
        }
        catch { /* 载体探测失败不标记，宁报在线不误报缺失 */ }
        return {
            ok: true,
            auto: String(req.query.auto ?? "0") !== "0",
            nodes: nodesWithBucket.map((n) => ({ ...n, id: serializable(n.id) })),
            links: links.map((l) => ({ ...l, src_id: serializable(l.src_id), dst_id: serializable(l.dst_id) })),
            edges,
        };
    });
    // （旧版 position.set / positions.reset 已于批次 E2a 改薄适配收进 cards-domain.js，见下方统一适配器）
    // ★ 批次 E2a：领域计算已收进 cards-domain.js::setCardPosition（op `cards.position.set`）
    app.post("/api/cards/:id/position", async (req, reply) => {
        const r = await invokeOp("cards.position.set", { id: Number(req.params.id), b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        return { ok: true, id: r.id, view: r.view, x: r.x, y: r.y };
    });
    // ★ 批次 E2a：领域计算已收进 cards-domain.js::resetCardPositions（op `cards.positions.reset`）；范围解析（D-13）留传输层
    app.delete("/api/cards/positions", async (req) => {
        // 可选范围：?ids=1,2,3 / ?id=1 —— 不给则全表清空（保持旧契约）
        const qids = req.query && req.query.ids !== undefined ? String(req.query.ids) : (req.query && req.query.id !== undefined ? String(req.query.id) : '');
        const scope = qids ? [...new Set(qids.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0))] : [];
        const r = await invokeOp("cards.positions.reset", { scope }, CARDS_CTX);
        return { ok: true, cleared: r.cleared, clearedIds: r.clearedIds, scoped: r.scoped };
    });
    // ★ 批次 E2a：领域计算已收进 cards-domain.js::getArchivePolicy（op `cards.archive.get`）
    app.get("/api/cards/archive", async () => {
        const r = await invokeOp("cards.archive.get", {}, CARDS_CTX);
        return { ok: true, mode: r.mode, days: r.days };
    });
    // ★ 批次 E2a：领域计算已收进 cards-domain.js::setArchivePolicy（op `cards.archive.set`）；mode 非法 400 由领域哨兵映射
    app.post("/api/cards/archive", async (req, reply) => {
        const r = await invokeOp("cards.archive.set", { b: req.body ?? {} }, CARDS_CTX);
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        if (r?.mode !== undefined && r?.run === undefined)
            return { ok: true, mode: r.mode };
        if (r?.days !== undefined && r?.run === undefined)
            return { ok: true, days: r.days };
        return { ok: true, run: r.run, mode: r.mode };
    });
    /** ★ 2026-09-20：归档中心 —— 归档卡片按主题分组（只读）。★ 批次 E2a：领域计算已收进 cards-domain.js::listArchiveGrouped（op `cards.archive.grouped`） */
    app.get("/api/cards/archive/grouped", async (req) => {
        const r = await invokeOp("cards.archive.grouped", { by: String(req.query.by ?? "topic").trim() || "topic" }, CARDS_CTX);
        return { ok: true, by: r.by, total: r.total, groups: r.groups };
    });
    // 卡片 ↔ MCP 任务：把卡片状态/标题回写到绑定的 task 记忆头（ref_kind='memory' 且 ref_id 有效）。
    // 幂等：状态已一致 → {noop:true}；否则重写 content 头 → {from,to,memory_id}。返回结构见前端 pushMcpBtn。
    app.post("/api/cards/:id/push-to-task", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (c.ref_kind !== "memory" || !c.ref_id)
            return reply.code(400).send({ ok: false, error: "卡片未绑定 MCP 任务" });
        const memoryId = Number(c.ref_id);
        // ★ 修 #4（2026-09-19）三处：
        //   ① 映射改用权威对照表 CARD_TO_TASK —— 原内联 TASK_MAP 是一致性③漏网的第 5 份副本；
        //     表内仅 triage/todo 无映射，两者的任务态即 pending。
        //   ② 原裸 `UPDATE memories SET content=?, status='active'` 不递增 version、不同步 FTS/2-gram
        //     （一致性②同款坑，MCP 侧 CAS 感知不到本写），改走 updateMemory 正门 CAS（2 次重试，
        //     持续漂移让位交对账，同 syncCardToTask 口径）。
        //   ③ 无条件置 status='active' 会复活已 cancelled/merged 的任务记忆 —— 改为非 active/trial
        //     直接 409 拒推，不再触碰记忆 status 列。
        const toStatus = CARD_TO_TASK[c.status] ?? "pending";
        const toAssignee = c.assignee ?? "";
        for (let attempt = 0; attempt < 2; attempt++) {
            const m = db.prepare(`SELECT id, content, version, status FROM memories WHERE id=?`).get(memoryId);
            if (!m)
                return reply.code(404).send({ ok: false, error: "绑定任务记忆不存在" });
            if (!["active", "trial"].includes(String(m.status)))
                return reply.code(409).send({ ok: false, error: `任务记忆 #${memoryId} 已终结（status=${m.status}），不允许推送` });
            // 解析现有 content 头
            const am = m.content.match(/\[assignee:([^\]]*)\]/);
            const sm = m.content.match(/\[status:([^\]]*)\]/);
            const curStatus = sm ? sm[1] : null;
            const curAssignee = am ? am[1] : "";
            // 归一旧头状态方便比对
            const normFrom = curStatus ? (TASK_NORMALIZE[curStatus] ?? curStatus) : null;
            const noop = normFrom === toStatus && curAssignee === toAssignee;
            if (noop)
                return { ok: true, noop, from: curStatus ?? null, to: toStatus, memory_id: memoryId };
            const head = `[task][assignee:${toAssignee}][status:${toStatus}]`;
            // ★（2026-09-14 实证）一次replace误二次replace导致头重复追加：
            //   若已有完整头 → 原位替换；否则整体前置新头（保留原正文/依赖段）。
            let newContent;
            if (/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/.test(m.content)) {
                newContent = m.content.replace(/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/, head);
            }
            else {
                newContent = `${head} ${m.content}`;
            }
            const ok = updateMemory(db, memoryId, { content: newContent, expectedVersion: m.version }); // ★ 正门 CAS
            if (ok) {
                writeCardEvent(id, "human:dashboard", "push_to_task", null, null, `卡 #${id} → 任务头 ${normFrom ?? "?"} → ${toStatus}`);
                return { ok: true, noop: false, from: curStatus ?? null, to: toStatus, memory_id: memoryId };
            }
            // 版本漂移：重读再试（第二次仍漂移 = MCP 侧正在改写 → 让位）
        }
        console.error(`[push-to-task] 卡片 #${id} → 任务 #${memoryId} 头回写让位：版本持续漂移（MCP 侧正在改写），交由对账对齐`);
        return reply.code(409).send({ ok: false, error: "任务头版本持续漂移（MCP 侧正在改写），已让位；请稍后重试或等对账对齐" });
    });
    // —— 卡片上下文（★ 2026-09-14 v2：给智能体消费的完整语义上下文）——
    // 返回本卡详情 + 手动绑定的记忆全文 + 语义最相似记忆全文 + 关联卡片标题。
    // 目的：自动关联仅存在于 dashboard 视图层（不落库），MCP/agent 读不到；
    //   此端点是它们获取「本卡该知道什么」的入口 —— 把动态记忆匹配固化到可调用 API。
    app.get("/api/cards/:id/context", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const meta = readCardMeta(c);
        // 手动绑定记忆（card_memory）+ 绑定任务记忆（ref）
        const boundRows = db.prepare(`SELECT cm.memory_id, cm.relation FROM card_memory cm WHERE cm.card_id=?`).all(id);
        const related = new Map();
        boundRows.forEach((b) => related.set(b.memory_id, b.relation));
        if (c.ref_kind === "memory" && c.ref_id)
            related.set(Number(c.ref_id), "task-ref");
        // 发文链接（卡片互链）
        const outLinks = db.prepare(`SELECT dst_id, kind FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id IS NOT NULL`).all(id);
        // 语义最相似记忆（取本卡向量 vs 记忆向量）
        const similar = [];
        try {
            const embedder = await getEmbedder();
            const text = `${c.title}\n${c.body ?? ""}`.trim();
            const [cv] = await embedder.embedTexts([text]);
            if (cv && cv.length) {
                const memvec = getAllActiveVecs().filter((v) => !related.has(v.id));
                const scored = memvec.map((v) => ({ memory_id: v.id, sim: cosine(cv, v.vec) })).filter((x) => x.sim >= 0.5).sort((a, b) => b.sim - a.sim).slice(0, 5);
                // 去重：排除已手动绑定的
                scored.forEach((s) => similar.push(s));
            }
        }
        catch {
            // embedding 不可用 → 仅返回手动绑定
        }
        const ids = [...related.keys(), ...similar.map((s) => s.memory_id)];
        const memFull = new Map();
        if (ids.length) {
            const ph = ids.map(() => "?").join(",");
            db.prepare(`SELECT id, content, type, confidence, created_at FROM memories WHERE id IN (${ph}) AND sensitivity != 'secret'`).all(...ids).forEach((r) => memFull.set(r.id, { content: r.content, type: r.type, confidence: r.confidence, created_at: r.created_at }));
        }
        // 关联卡标题
        const linkedCards = new Map();
        if (outLinks.length) {
            const ph = outLinks.map(() => "?").join(",");
            db.prepare(`SELECT id, title FROM cards WHERE id IN (${ph})`).all(...outLinks.map((l) => l.dst_id)).forEach((r) => linkedCards.set(r.id, r.title));
        }
        return {
            ok: true,
            card: { id: c.id, kind: c.kind, title: c.title, body: c.body, status: c.status, assignee: c.assignee, priority: c.priority, ref_kind: c.ref_kind, ref_id: c.ref_id, meta },
            bound_memories: [...related.entries()].map(([mid, relation]) => ({ memory_id: mid, relation, ...memFull.get(mid) })).filter((m) => m.content),
            similar_memories: similar.map((s) => ({ memory_id: s.memory_id, sim: s.sim, ...memFull.get(s.memory_id) })).filter((m) => m.content),
            linked_cards: [...outLinks.map((l) => ({ dst_id: l.dst_id, kind: l.kind, title: linkedCards.get(l.dst_id) ?? "" }))],
        };
    });
    // —— Dispatcher（H3 租约回收 / M1 triage 超时 / M3 依赖提升 / 熔断 / H6 前瞻联动）——
    app.post("/api/dispatch", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardDispatch");
        const out = { leased_back: 0, promoted: [], blocked: [], auto_refined: [], auto_archived: [], prospective_cards: [] };
        const now = new Date().toISOString();
        txBegin(); // ★ 修 #9：事务内事件入队
        try {
            // ① 租约贴条（⑦/H3 演进 → ⑧ 批次 B1 只标不回收）：过期不再自动抢回 —— 打 lease_notice_at 标记、卡保持
            //    running（与任务头一致零震荡）；认领者 heartbeat 续期/收口即撕条。超期裁决由 reapExpiredLeases
            //    阶段二统一处理（⑧：只标 lease_stale_at + dispatch 置 stale，不回收、不放回池子）。
            //    replace(' ','T')：lease_expires_at 存量含 SQLite 空格格式，与 JS ISO 裸比较「同日恒真」，先归一再比。
            const expired = db
                .prepare(`SELECT id, assignee FROM cards WHERE status='running' AND lease_expires_at IS NOT NULL AND replace(lease_expires_at,' ','T') < ? AND lease_notice_at IS NULL`)
                .all(now);
            for (const e of expired) {
                const upd = db.prepare(`UPDATE cards SET lease_notice_at=?, updated_at=? WHERE id=? AND status='running' AND lease_notice_at IS NULL`).run(now, now, e.id);
                if (Number(upd.changes) === 0)
                    continue;
                writeCardEvent(e.id, "dispatcher", "lease_expired", "running", "running", `租约过期（原 ${e.assignee ?? "?"}）——贴条待确认：heartbeat 续期 / 收口；超 24h 无人理转「待裁决」（⑧ 只标不回收）`);
                out.leased_back++;
            }
            // ② triage 超时（M1）：>N 小时未动 → todo（C4：N 可配——#9「缩短自动回收的判定时间」；默认 24 不变）
            // ★ 2026-09-19（弊端 L5）：created_at 混 JS ISO（T/Z）与 SQLite 空格格式——裸比较同日条目判偏；
            //   归一为 T 格式后与 JS 侧截止时间比较（租约「同日恒真」同类修复）
            const refineH = Math.max(0.5, Number(process.env.CARD_AUTO_REFINE_HOURS ?? 24) || 24);
            const staleCutoff = new Date(Date.now() - refineH * 3600000).toISOString();
            const stale = db
                .prepare(`SELECT id FROM cards WHERE status='triage' AND replace(created_at,' ','T') < ?`)
                .all(staleCutoff);
            for (const s of stale) {
                db.prepare(`UPDATE cards SET status='todo', updated_at=? WHERE id=?`).run(now, s.id);
                writeCardEvent(s.id, "dispatcher", "auto_refine", "triage", "todo", `${refineH}h 未动自动提升`);
                out.auto_refined.push(s.id);
            }
            // ③ 依赖提升（M3）：todo 且 depends 全已满足（done/archived）→ ready
            const todos = db.prepare(`SELECT id FROM cards WHERE status='todo'`).all();
            for (const t of todos) {
                if (cardDependsDone(t.id)) {
                    db.prepare(`UPDATE cards SET status='ready', updated_at=? WHERE id=?`).run(now, t.id);
                    writeCardEvent(t.id, "dispatcher", "auto_ready", "todo", "ready", "依赖已满足");
                    out.promoted.push(t.id);
                }
            }
            // ④ 熔断：failure_count>=2 且 failed → blocked
            const failed = db.prepare(`SELECT id FROM cards WHERE status='failed' AND failure_count>=2`).all();
            for (const f of failed) {
                db.prepare(`UPDATE cards SET status='blocked', updated_at=? WHERE id=?`).run(now, f.id);
                writeCardEvent(f.id, "dispatcher", "circuit_break", "failed", "blocked", "连续失败≥2 熔断");
                out.blocked.push(f.id);
            }
            // ④-b ★ B3（2026-10-18 · P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：gate 连续失败熔断——
            //   与 daemon.js ③-b 同判据同口径（ready 且 gate_fail_count>=2 → blocked）。web 侧手动触发
            //   housekeep 时不依赖 daemon 周期，两边独立覆盖同一不变量。
            if (gateBreakerOn()) {
                const gateFailed = db.prepare(`SELECT id FROM cards WHERE status='ready' AND gate_fail_count>=2`).all();
                for (const f of gateFailed) {
                    db.prepare(`UPDATE cards SET status='blocked', updated_at=? WHERE id=? AND status='ready'`).run(now, f.id);
                    writeCardEvent(f.id, "dispatcher", "circuit_break", "ready", "blocked", "gate 连续失败≥2 熔断");
                    out.blocked.push(f.id);
                }
            }
            // ⑥ done 自动归档（改进方案 P2⑨，2026-10-07）：done 超 N 天自动 archived——「归档」只是清理
            //    动作（/api/cards 活跃面本就剔除 archived），不值得人工惦记。CARD_AUTO_ARCHIVE_DAYS 环境变量
            //    可调天数，0=关闭；默认 7 天。replace(' ','T') 与上方 ② 同口径（防双格式「同日恒真」）。
            const archDays = Number(process.env.CARD_AUTO_ARCHIVE_DAYS ?? 7);
            if (Number.isFinite(archDays) && archDays > 0) {
                const archCutoff = new Date(Date.now() - archDays * 86400000).toISOString();
                const dones = db.prepare(`SELECT id FROM cards WHERE status='done' AND replace(updated_at,' ','T') < ?`).all(archCutoff);
                for (const d0 of dones) {
                    db.prepare(`UPDATE cards SET status='archived', updated_at=? WHERE id=? AND status='done'`).run(now, d0.id);
                    writeCardEvent(d0.id, "dispatcher", "auto_archive", "done", "archived", `完成满 ${archDays} 天自动归档`);
                    out.auto_archived.push(d0.id);
                }
            }
            // ⑤ 前瞻联动（H6）：cron 到期 → 自动建卡（防重放由 due 内部处理）
            const dueRes = await (async () => {
                const rows = db
                    .prepare(`SELECT id, content, trigger_action, trigger_kind, valid_until FROM memories
             WHERE sector='prospective' AND status='active' AND trigger_kind='cron'
               AND valid_until IS NOT NULL AND julianday(valid_until) <= julianday('now')`)
                    .all();
                const created = [];
                for (const r of rows) {
                    // ★ 修 #6：同 /api/prospective/due —— LIKE 子串误伤改 json_extract 精确比对
                    const dup = db.prepare(`SELECT id FROM cards WHERE json_extract(CASE WHEN json_valid(meta) THEN meta END, '$.from_prospective') = ? LIMIT 1`).get(r.id);
                    if (dup)
                        continue;
                    const ins = db
                        .prepare(`INSERT INTO cards(board,kind,title,status,meta) VALUES ('default','task',?,'triage',?)`)
                        .run(String(r.trigger_action ?? r.content ?? "前瞻提醒").slice(0, 200), JSON.stringify({ from_prospective: r.id }));
                    const cid = Number(ins.lastInsertRowid);
                    writeCardEvent(cid, "dispatcher", "create", null, "triage", `前瞻 cron 命中 #${r.id}`);
                    created.push(cid);
                }
                return created;
            })();
            out.prospective_cards = dueRes;
            txCommit();
        }
        catch (e) {
            txRollback();
            throw e;
        }
        return { ok: true, ...out };
    });

    // ═══════════ 节点画布（P0，2026-10-04）：类型注册表 / 改型 / 边 / 智能体档案 ═══════════
    // 设计依据：D4（Agent 卡 = cards.kind='agent' 投影卡 + meta.profile_id）、D11（先建卡后选型）、
    //           连线方向按 card_types 四端口行为档位判定；可回滚 = drop card_types/card_edges/agent_profiles 三张新表。
    /** ★ 2026-10-05 批2：向导「模型」下拉的数据源。刻意**不**内置厂商模型清单（会过期、本机也没验证过），
     *  只回三类真数据：① 设置页当前默认模型 ② 本机 Ollama /api/tags 实探（1.5s 超时，没起就跳过）
     *  ③ 本机各智能体档案**已经用过**的模型（历史复用）。supportsModelFlag 决定前端是否如实标注
     *  「该载体填了也不会传给 CLI」。 */
    app.get("/api/agent-models", async (req) => {
        const key = String(req.query?.agent_key ?? "").trim();
        const models = [];
        const seen = new Set();
        const add = (id, source) => {
            const v = String(id ?? "").trim();
            if (v && !seen.has(v)) {
                seen.add(v);
                models.push({ id: v, source });
            }
        };
        try {
            const cfg = (ctx.readDiskConfig ? ctx.readDiskConfig() : {}) || {};
            const url = String(cfg.llmUrl || process.env.LLM_BASE_URL || process.env.MIMOS_URL || "").trim();
            add(cfg.llmModel || process.env.LLM_MODEL || process.env.INGEST_MODEL || "", "config");
            if (!url || /:11434|ollama/i.test(url)) {
                const base = (url || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), 1500);
                try {
                    const r = await fetch(base + "/api/tags", { signal: ctl.signal });
                    if (r.ok)
                        for (const m of ((await r.json()).models || []))
                            add(m?.name, "ollama");
                }
                catch (e) {
                    // 探测失败按「未安装 Ollama」降级：只回清单类数据，不拦向导下拉（留痕防静默）
                    console.warn('[agent-models] Ollama /api/tags 探测失败，降级为只回配置与历史清单：' + (e instanceof Error ? e.message : e));
                }
                finally { clearTimeout(timer); }
            }
        }
        catch (e) {
            console.warn('[agent-models] 读磁盘 LLM 配置失败，清单端点降级为空：' + (e instanceof Error ? e.message : e));
        }
        for (const r of db.prepare(`SELECT DISTINCT model FROM agent_profiles WHERE model IS NOT NULL AND model <> '' ORDER BY model`).all())
            add(r.model, "profile");
        const supports = key ? cliAcceptsModel(key) : true;
        return {
            ok: true, agent_key: key, models, supportsModelFlag: supports,
            note: key && !supports ? "该载体预设未接入模型参数：填了也不会传给 CLI（要控模型请在高级栏 args 里自行加旗标）" : "",
        };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js（op `card-types.list`）
    app.get("/api/card-types", async () => {
        const r = await invokeOp("card-types.list", {}, CARDS_CTX);
        return { ok: true, types: r.types };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::createCardType（op `card-types.create`）；非法 key 400 / 保留字·重复 409 由领域哨兵映射
    app.post("/api/card-types", async (req, reply) => {
        const r = await invokeOp("card-types.create", { b: req.body ?? {} }, CARDS_CTX);
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, type_key: r.type_key };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::updateCardType（op `card-types.update`）
    app.put("/api/card-types/:key", async (req, reply) => {
        const r = await invokeOp("card-types.update", { key: String(req.params.key), b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "类型不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, type_key: r.type_key };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::deleteCardType（op `card-types.delete`）；内置/有卡使用 409 由领域哨兵映射
    app.delete("/api/card-types/:key", async (req, reply) => {
        const r = await invokeOp("card-types.delete", { key: String(req.params.key) }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "类型不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::retypeCard（op `cards.retype`）；未知类型 400 / running·派发连线 409 由领域哨兵映射
    app.post("/api/cards/:id/retype", async (req, reply) => {
        const r = await invokeOp("cards.retype", { id: Number(req.params.id), b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return r.unchanged ? { ok: true, id: r.id, kind: r.kind, unchanged: true } : { ok: true, id: r.id, kind: r.kind, profile_id: r.profile_id };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::listAgentProfiles（op `agent-profiles.list`）
    app.get("/api/agent-profiles", async () => {
        const r = await invokeOp("agent-profiles.list", {}, CARDS_CTX);
        return { ok: true, profiles: r.profiles };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::createAgentProfile（op `agent-profiles.create`）；名称/工作区 400 由领域哨兵映射，事务异常抛错 → 500
    app.post("/api/agent-profiles", async (req, reply) => {
        try {
            const r = await invokeOp("agent-profiles.create", { b: req.body ?? {} }, CARDS_CTX);
            if (r?.error)
                return reply.code(400).send({ ok: false, error: r.error });
            return { ok: true, profile_id: r.profile_id, card_id: r.card_id };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e instanceof Error ? e.message : e) });
        }
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::updateAgentProfile（op `agent-profiles.update`）；派发中 409 由领域哨兵映射
    app.put("/api/agent-profiles/:id", async (req, reply) => {
        const r = await invokeOp("agent-profiles.update", { id: Number(req.params.id), b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "智能体档案不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, id: r.id };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::deleteAgentProfile（op `agent-profiles.delete`）
    app.delete("/api/agent-profiles/:id", async (req, reply) => {
        const r = await invokeOp("agent-profiles.delete", { id: Number(req.params.id) }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "智能体档案不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::addCardEdge（op `card-edges.add`）；端口档位 409 / 重复连线 409 由领域哨兵映射
    app.post("/api/card-edges", async (req, reply) => {
        const r = await invokeOp("card-edges.add", { b: req.body ?? {} }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "边端点卡片不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        if (r?.error)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, id: r.id };
    });

    // ★ 批次 E2a：领域计算已收进 cards-domain.js::deleteCardEdge（op `card-edges.delete`）；dispatch 边 409 由领域哨兵映射
    app.delete("/api/card-edges/:id", async (req, reply) => {
        const r = await invokeOp("card-edges.delete", { id: Number(req.params.id) }, CARDS_CTX);
        if (!r)
            return reply.code(404).send({ ok: false, error: "边不存在" });
        if (r?.conflict)
            return reply.code(409).send({ ok: false, error: r.error });
        return { ok: true };
    });

    // 智能体卡状态唯一出口：档位/载体在位/队列深度（前端禁自行探测进程，见报告 §5.4）
    app.get("/api/agent-cards/:id/state", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c || String(c.kind) !== "agent")
            return reply.code(404).send({ ok: false, error: "智能体卡不存在" });
        const p = profileOfCard(c);
        const keys = scanKeysSafe();
        const queue = db.prepare(`
            SELECT e.id edge_id, e.source_id card_id, k.title, d.generation, d.heartbeat_at, d.lease_expires_at
            FROM card_edges e
            LEFT JOIN dispatches d ON d.id = e.dispatch_id
            LEFT JOIN cards k ON k.id = e.source_id
            WHERE e.target_id=? AND e.kind='dispatch' AND e.status='active'
            ORDER BY e.id`).all(id);
        return {
            ok: true, id,
            name: p?.name ?? c.title,
            channel: p?.channel ?? "queue",
            agent_key: p?.agent_key ?? null,
            workspace: p?.workspace ?? null, model: p?.model ?? null, reasoning: p?.reasoning ?? null, context_tokens: p?.context_tokens ?? null,
            carrier_missing: carrierMissingOf(p, keys), // p=null → 落 queue 通道，不报缺失（见 carrierMissingOf）
            queue_depth: queue.length,
            queue,
        };
    });
}
