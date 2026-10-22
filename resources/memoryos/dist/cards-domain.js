/** 架构收敛 · 第2条 批次 E1（2026-10-16）：cards 域领域层 —— 单一真相源。
 * helpers 自 dashboard-reg-cards.js 原 15-359 / 553-562 / 1296-1302 / 1571-1586 / 1819-1907 行**逐字搬移**
 * （factory 闭包持有事件总线/事务队列/向量缓存等可变状态，经 createCardsDomain(deps) 每进程实例化一次）；
 * E1 的 14 条领域函数自原路由 handler 逐字搬移 —— HTTP 协议外壳（RESTRICTED / 400 参数校验 / 状态码映射）留传输层，
 * 领域层返回**裸领域值**或**哨兵对象**（{ error } / { error, conflict } / { error, forbidden } / { error, missing } / null→404），
 * 文案逐字同改前。后续批次（E2 dispatch/LLM/SSE 等）在既有 helper 上继续收口。
 * 门禁：dist/smoke-ops.js 批次 E1（21 探针逐字节 + 注册表不变量）。 */
import { updateMemory, settleDispatch, setCardEvtPusher, readConfig, writeConfig } from "./db.js";
import { depValidateOn, gateBreakerOn } from "./task-domain.js"; // ★ C1（P0）：依赖校验开关 + B3（P2）：门控熔断开关（cards-domain → task-domain 无环：task-domain 不 import 本模块）
import { bufToVec } from "./embed.js";
import { randomBytes } from "node:crypto";
import { CARD_TO_TASK } from "./task-status-map.js";
import { getScanCachedShared } from "./scan.js"; // 节点画布：智能体卡载体在位探测（agent_key 对账）
import { overridesOf } from "./dashboard-exec-util.js"; // ★ 批1：launch_overrides 解析与两个执行器同口径（含双重编码容错）
import fs from "node:fs";
import path from "node:path";

export function createCardsDomain(deps) {
    const { db } = deps;
    // ═══════════════════════════════════════════════════════════════════════════
    // ★ P3 卡片看板 + 知识图谱 + 记忆模块 API（第四轮评审 H1-H6 / M1-M8 合入）
    // ═══════════════════════════════════════════════════════════════════════════
    /** 10 态状态机（Hermes + A2A + 现有七态融合）；迁移白名单与 plan.schema.json status_transitions 对齐 */
    const CARD_STATES = ["triage", "todo", "ready", "running", "review", "done", "failed", "cancelled", "blocked", "archived"];
    const CARD_TRANSITIONS = {
        triage: ["todo", "cancelled"],
        todo: ["ready", "cancelled", "blocked"],
        ready: ["running", "cancelled"],
        running: ["review", "failed", "blocked"],
        review: ["done", "failed"],
        blocked: ["todo", "ready", "running", "cancelled"],
        failed: ["blocked", "todo", "cancelled"],
        done: ["archived"],
        cancelled: [],
        archived: [],
    };
    // ★ 2026-10-07（辅助卡缺陷修复）：aux_* 挂载线入白名单——前端「挂辅助卡」建卡后连
    //   aux_project/aux_memory/aux_rule/aux_skill/aux_error 五种卫星线，缺了会 400「非法关系」。
    //   这五种线不参与 depends 前置校验（dispatchPrecheck 只看 depends），不阻塞派发。
    const CARD_LINK_KINDS = ["depends", "blocks", "relates", "spawned_by", "duplicates", "handoff",
        "aux_project", "aux_memory", "aux_rule", "aux_skill", "aux_error"]; // ★ P4：handoff=交接文档挂边（任务卡→交接卡，图上派生视觉边）
    /** M6：卡片 kind → sector 映射（cards/:id/to-memory 用） */
    const CARD_TO_SECTOR = {
        task: "social",
        note: "semantic",
        message: "meta",
        artifact: "procedural",
        memory: "episodic",
    };
    /* ★ 实时看板：卡片事件总线。所有变更都经过 writeCardEvent → 推给 /api/cards/stream 的 SSE 订阅者。
     *  订阅者是 SSE 写函数，写失败（连接已断）即摘除。心跳防断连由 SSE 路由侧负责。 */
    const cardSubs = new Set();
    // ★ 修 #13（2026-09-19）：auto 模式卡向量缓存（key=卡id+标题+正文前600字）—— 原每次请求全量重嵌，
    //   把嵌入 API 打成 O(n)/请求；未变更的卡直接复用上次向量。超 2000 条整体清空防膨胀（宁重嵌不涨内存）。
    const cardVecCache = new Map();
    function pushCardEvt(evt) {
        const payload = `event: card\ndata: ${JSON.stringify(evt)}\n\n`;
        for (const sub of [...cardSubs]) {
            try { sub(payload); } catch { cardSubs.delete(sub); }
        }
    }
    if (deps.setCardEvtPusher) deps.setCardEvtPusher(pushCardEvt); // ★ 2026-09-25 方案A：db.js convergeLinkedCards 同进程写 card_events 时即时推 SSE
    /* ★ 跨进程事件补流（2026-09-18）：MCP server / daemon 等独立进程直写 card_events
     *  （task_claim/task_done/task_release、apply-plan、mcp_reopen…），不经过本进程 pushCardEvt。
     *  有订阅者时以 2s 轮询 card_events 增量补推（水位线 lastId）；与进程内即时推送重复无害
     *  （前端 800ms 防抖合并）；无订阅者即停轮询。 */
    let evtWatermark = 0, evtPoller = null;
    function ensureEvtPoller() {
        if (evtPoller)
            return;
        evtWatermark = Number(db.prepare(`SELECT COALESCE(MAX(id),0) m FROM card_events`).get()?.m ?? 0);
        evtPoller = setInterval(() => {
            try {
                // ★ 2026-09-19（弊端 L2）：补流排空（500 条/批 × 最多 5 批/拍）——原单批 100 条，事件速率 >50/s 时水位永久落后
                for (let i = 0; i < 5; i++) {
                    const rows = db.prepare(`SELECT id, card_id, actor, action, from_status, to_status FROM card_events WHERE id > ? ORDER BY id LIMIT 500`).all(evtWatermark);
                    if (!rows.length)
                        break;
                    for (const r of rows) {
                        evtWatermark = Math.max(evtWatermark, Number(r.id));
                        pushCardEvt({ type: r.action, cardId: Number(r.card_id), from: r.from_status ?? null, to: r.to_status ?? null, actor: r.actor, ts: Date.now() });
                    }
                    if (rows.length < 500)
                        break;
                }
            }
            catch { /* 单轮失败下轮重试 */ }
        }, 2000);
        evtPoller.unref?.();
    }
    function stopEvtPoller() {
        if (evtPoller) {
            clearInterval(evtPoller);
            evtPoller = null;
        }
    }
    function cardRowOf(r) {
        return {
            id: Number(r.id), board: r.board, kind: r.kind, title: r.title, body: r.body, status: r.status,
            assignee: r.assignee, lane: r.lane, priority: Number(r.priority ?? 0), failure_count: Number(r.failure_count ?? 0),
            claim_lock: r.claim_lock, lease_expires_at: r.lease_expires_at, heartbeat_at: r.heartbeat_at, lease_notice_at: r.lease_notice_at ?? null, lease_stale_at: r.lease_stale_at ?? null,
            workspace: r.workspace, workspace_kind: r.workspace_kind, ref_kind: r.ref_kind, ref_id: r.ref_id,
            meta: r.meta, created_at: r.created_at, updated_at: r.updated_at,
        };
    }
    function readCard(id) {
        const r = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id);
        return r ? cardRowOf(r) : null;
    }
    function readCardMeta(c) {
        try {
            return c.meta ? JSON.parse(c.meta) : {};
        }
        catch {
            return {};
        }
    }
    /* ★ 修 #9（2026-09-19）：事务内事件先入队、COMMIT 后再推 —— 原 pushCardEvt 在 BEGIN IMMEDIATE
     *  事务（dispatch / archive / apply-plan）里同步直推，一旦 ROLLBACK 前端已收到实际没发生的假事件。
     *  txBegin/txCommit/txRollback 是本模块事务的统一入口；不经过它们的事务不写卡片事件，互不影响。 */
    let txEvtQueue = null;
    function txBegin() { db.exec("BEGIN IMMEDIATE"); txEvtQueue = []; }
    function txCommit() {
        db.exec("COMMIT");
        const q = txEvtQueue;
        txEvtQueue = null;
        for (const e of q) { try { pushCardEvt(e); } catch { /* 订阅者写失败由 pushCardEvt 自行摘除 */ } }
    }
    function txRollback() { db.exec("ROLLBACK"); txEvtQueue = null; }
    function writeCardEvent(cardId, actor, action, fromStatus, toStatus, detail) {
        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail)
       VALUES (?,?,?,?,?,?)`).run(cardId, actor, action, fromStatus ?? null, toStatus ?? null, detail ?? null);
        const evt = { type: action, cardId: Number(cardId), from: fromStatus ?? null, to: toStatus ?? null, actor, ts: Date.now() };
        // ★ 2026-10-05 批1：detail 随事件下发（前端「失败冒泡」用）。原实现只发状态流转，
        //   执行器写进 detail 的真因（如「未找到该智能体的可执行文件」）留在库里，
        //   用户看到的就是「点了派发，卡悄悄变红，不知道为什么」。additive 字段，老前端忽略即可。
        if (detail)
            evt.detail = String(detail).slice(0, 160);
        if (txEvtQueue) { txEvtQueue.push(evt); return; }
        try { pushCardEvt(evt); } catch { /* 推送失败不影响落库 */ }
    }
    /** ★ 2026-09-15：卡片状态 → 关联 task 记忆状态头回写（task_assign 建的卡 ref_kind='memory'，dispatch 关联）。
     *  卡片流转会同步 memories 里对应 type='task' 的内容头 [status:]，保持「地图卡 ↔ MCP 任务」双向一致。
     *  ★ 一致性②（2026-09-19）：改走 db.updateMemory() 正门 —— 原裸 `UPDATE memories SET content=?` 不递增
     *  version、不同步 FTS/2-gram：① MCP 侧 CAS（WHERE version=?）感知不到本回写，认领会把看板改动覆盖回去
     *  （丢失更新）；② 检索索引脏读（原 128-129 行注释自认的既有坑）。现 CAS 写入一次完成 version+1 + 索引同步；
     *  版本漂移（MCP 侧刚改过头）→ 让位不硬写：卡向头对齐是 C-5 投影口径，30s 任务桥 / 5min 对账兜底，
     *  盲目硬写会与 MCP 打架（后写覆盖前写）。
     *  ★ 修 #10（2026-09-19）：opts.assignee 传入时同步回写头的 [assignee:] 段（看板认领用）——
     *  原来只写 status，看板认领后头里 assignee 恒 ?，后续凭据归属/心跳权限判断全失准。 */
    function syncCardToTask(cardId, opts = {}) {
        try {
            // 定位关联 task 记忆：优先 ref_kind='memory'，其次 card_memory dispatch 关联
            const card = readCard(cardId);
            if (!card)
                return;
            const memRow = (card.ref_kind === "memory" && card.ref_id
                ? db.prepare(`SELECT id FROM memories WHERE id=?`).get(card.ref_id)
                : undefined) ??
                db.prepare(`SELECT memory_id id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(cardId);
            if (!memRow)
                return;
            // 卡片状态 → 任务状态头映射（★ 一致性③：改用权威对照表 task-status-map.js；E-0：review→in_progress / failed→blocked / archived→archived）
            const toSt = CARD_TO_TASK[card.status];
            if (!toSt)
                return;
            const newAssignee = opts.assignee === undefined ? null : String(opts.assignee ?? "");
            for (let attempt = 0; attempt < 2; attempt++) {
                const mem = db.prepare(`SELECT id, content, version FROM memories WHERE id=? AND type='task' AND status IN ('active','trial')`).get(memRow.id);
                if (!mem)
                    return;
                const st = mem.content.match(/\[status:([^\]]+)\]/);
                if (!st)
                    return;
                const curAssignee = mem.content.match(/\[assignee:([^\]]*)\]/)?.[1];
                if (st[1] === toSt && (newAssignee === null || curAssignee === newAssignee))
                    return; // 头已是目标态（含他人刚对齐），无事可做
                let newContent = mem.content.replace(`[status:${st[1]}]`, `[status:${toSt}]`);
                if (newAssignee !== null) {
                    if (/\[assignee:[^\]]*\]/.test(newContent))
                        newContent = newContent.replace(/\[assignee:[^\]]*\]/, `[assignee:${newAssignee}]`);
                    else
                        newContent = newContent.replace(`[status:${toSt}]`, `[assignee:${newAssignee}][status:${toSt}]`); // 头缺 assignee 段（legacy）→ 补进 status 前
                }
                const ok = updateMemory(db, mem.id, { content: newContent, expectedVersion: mem.version }); // ★ 正门 CAS
                if (ok)
                    return; // version+1 + FTS/2-gram 同步已随写入完成
                // 版本漂移：重读一次再试（第二次仍漂移 = MCP 侧正在改写 → 让位，交对账兜底）
            }
            console.error(`[syncCardToTask] 卡片 #${cardId} → 任务头回写让位：任务 #${memRow.id} 版本持续漂移（MCP 侧正在改写），交由对账对齐`);
        }
        catch (e) {
            /* 回写失败不阻断卡片流程 —— 但必须留痕：静默会让"卡已流转、任务头未跟"完全隐身（2026-09-16 A 分区验收口径） */
            console.error(`[syncCardToTask] 卡片 #${cardId} → 任务头回写失败：${e.message}`);
        }
    }
    /** ★ ①（2026-09-24）：agent 名写凭据校验（web 卡面 4 端点闭合 L1/L2 冒名闭环）。
     *  规则：actor 非 kebab（human 前缀/unassigned/?/空等人类或缺省流量）→ null 直接放行，行为零变化；
     *  kebab 名 → 查 agent_credentials 有效写凭据（owner 匹配 / 未吊销 / 未过期 / scope≠read）；
     *  无效且 MEMORYOS_A1_ENFORCE=1（硬模式）→ 返回 403 错误串；软模式 → 放行（与 MCP 侧 A1 口径一致）。 */
    const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
    function actorCredError(actor, credential) {
        const a = String(actor ?? "").trim();
        if (!AGENT_NAME_RE.test(a))
            return null; // 非 kebab：human:dashboard / unassigned / "?" / 空 → 人类或异常流量，原语义不变
        const credRows = credential
            ? db.prepare(`SELECT agent, scope, expires_at, revoked_at FROM agent_credentials WHERE credential=?`).all(String(credential))
            : [];
        const credOk = credRows.some((r) => r.agent === a && !r.revoked_at && !(r.expires_at && r.expires_at <= new Date().toISOString()) && r.scope !== "read"); // 与 MCP isCredentialValid 口径一致
        if (credOk)
            return null;
        if (process.env.MEMORYOS_A1_ENFORCE === "1")
            return `A1 硬模式：agent「${a}」无有效写凭据（MEMORYOS_A1_ENFORCE=1），本操作拒绝；请携带有效 credential 参数或改用 task_* MCP 工具`;
        return null; // 软模式：放行（与 MCP checkWriteCredential 同口径）
    }
    /** 依赖「已满足」的状态集：`done` 与 `archived` 都算完成。
     *  状态机 `done: ["archived"]` —— archived 是「干完并归档」的下游终态。
     *  ★ 2026-10-05 根治：旧判据只认 done → 依赖卡一旦归档，依赖它的卡被永久判「依赖未完成」，
     *    永远派发不出去（生产实证：todo 卡 #110/#111/#112/#113 全卡在已归档的 #109，
     *    且 409 只说「需可认领 ready」，真正卡点一个字没提）。同类先例：共享记忆 #4258、
     *    `server-reg-task.js` 的依赖死端检测（M6）。 */
    const DEP_SATISFIED = new Set(["done", "archived"]);
    /** 未满足的 depends 入边清单（含「依赖卡已删除」死端），供 409 文案与前端预检逐条透出 */
    function pendingDepends(cardId) {
        const deps = db
            .prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`)
            .all(cardId);
        const out = [];
        for (const d of deps) {
            const s = db.prepare(`SELECT status, title FROM cards WHERE id=?`).get(d.dst_id);
            if (!s)
                out.push({ id: Number(d.dst_id), status: "gone", note: "依赖卡已删除" });
            else if (!DEP_SATISFIED.has(s.status))
                out.push({
                    id: Number(d.dst_id),
                    status: s.status,
                    note: s.status === "cancelled" ? "已取消·永远不会完成" : "",
                    title: String(s.title ?? "").slice(0, 16),
                });
        }
        return out;
    }
    /** 卡片全部 depends 入边是否已满足（M3：只认 depends） */
    function cardDependsDone(cardId) {
        return pendingDepends(cardId).length === 0;
    }
    /** 409 文案：把真正卡住的依赖逐条列出 + 可行动指引（替代「需可认领 ready」这类误导话术） */
    function depPendingMsg(pend) {
        const brief = (p) => `#${p.id}${p.title ? `「${p.title}」` : ""}(${p.status}${p.note ? `·${p.note}` : ""})`;
        const dead = pend.some((p) => p.note);
        return `依赖未完成，暂不可派发：${pend.map(brief).join("、")}`
            + (dead ? "。已取消/已删除的依赖永远不会完成——右键那条依赖线删除即可解锁" : "。完成这些依赖，或右键删掉这条依赖线");
    }
    /* ★ A1 一键派发收口（对标 orca worker_done）：run 终态回调 —— 卡片 running →
     *   review（成功，交回人工验收）/ failed（失败，failure_count+1），并结算工作证。
     *  幂等三层：① 卡已不在 running（agent 自己 task_done 已收口 / 人工已流转）→ 只补结算不改状态；
     *  ② settleDispatch 自带 WHERE state='active' 守卫，重复结算天然无害；
     *  ③ 全程 try 包裹 —— 收口失败不能反噬 run 终态。 */
    function finalizeCardDispatch(info) {
        const cardId = Number(info?.cardId);
        if (!cardId)
            return { ok: false, reason: "no-card" };
        const c = readCard(cardId);
        if (!c)
            return { ok: false, reason: "card-gone" };
        const actor = String(info.actor || "dispatch-agent");
        const detail = String(info.detail ?? "").slice(0, 160);
        let statusChanged = null;
        // 只收口「本派发自己领的那张卡」（他人中途接管则让位，交对账/人工）
        if (c.status === "running" && (!c.assignee || c.assignee === "unassigned" || c.assignee === actor)) {
            const to = info.ok ? "review" : "failed";
            if (CARD_TRANSITIONS[c.status]?.includes(to)) {
                const g = db
                    .prepare(`UPDATE cards SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='running'`)
                    .run(to, cardId);
                if (Number(g.changes)) {
                    statusChanged = to;
                    writeCardEvent(cardId, actor, "status_changed", "running", to, detail);
                    // 三清（锁 + 租约窗 + 贴条/裁决标记）：run 已终态，残留锁会卡死后续认领
                    db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cardId);
                    if (to === "failed")
                        db.prepare(`UPDATE cards SET failure_count=failure_count+1 WHERE id=?`).run(cardId);
                    syncCardToTask(cardId); // 头状态回写（review→in_progress / failed→blocked）
                }
            }
        }
        let settled = false;
        if (info.dispatchId) {
            settled = settleDispatch(db, info.dispatchId, info.ok ? "succeeded" : "failed", detail || (info.runId ? `run ${info.runId}` : "dispatch-agent"));
            // ★ 节点画布：派发边随工作证终态翻投影状态（边表永不裁决，只跟随真源）
            try {
                db.prepare(`UPDATE card_edges SET status=? WHERE dispatch_id=? AND kind='dispatch' AND status='active'`)
                    .run(info.ok ? "completed" : "cancelled", info.dispatchId);
            }
            catch (e) { console.error("[cards] 派发边随工作证翻状态失败（容忍：边表异常不反噬收口）", e); }
        }
        else {
            // ★ 卡级派发（无关联任务记忆 → 无工作证）：按源卡翻边，防边永远停在 active
            try {
                db.prepare(`UPDATE card_edges SET status=? WHERE source_id=? AND kind='dispatch' AND status='active'`)
                    .run(info.ok ? "completed" : "cancelled", cardId);
            }
            catch (e) { console.error("[cards] 卡级派发边翻状态失败（容忍：不反噬收口）", e); }
        }
        // ★ P4 交接文档卡：仅成功收口生成（失败不产交接噪音，防 board 无界膨胀；失败教训在 run 日志与任务记忆）。
        //   内容优先级：任务记忆「→ 结论(AGENT)：」段 > run 最终回复 > 收口 detail；
        //   消费规则：下游注入取 dispatch generation 最新的那张（D9）。
        if (info.ok) {
            try {
            //   失败收口不产交接（设计选择：防看板被失败任务淹没；失败教训在 run 日志与任务记忆）
            const memRow = (c.ref_kind === "memory" && c.ref_id
                ? db.prepare(`SELECT id, content FROM memories WHERE id=?`).get(c.ref_id)
                : undefined) ??
                db.prepare(`SELECT m.id id, m.content content FROM card_memory cm JOIN memories m ON m.id=cm.memory_id WHERE cm.card_id=? AND cm.relation='dispatch' LIMIT 1`).get(cardId);
            // 核心结论：任务记忆「→ 结论(AGENT)：」段 > run 最终回复 > 收口 detail
            let core = "";
            if (memRow?.content) {
                const idx = String(memRow.content).lastIndexOf("→ 结论(AGENT)：");
                if (idx >= 0)
                    core = String(memRow.content).slice(idx + "→ 结论(AGENT)：".length).trim().slice(0, 2000);
            }
            if (!core)
                core = String(info.answer ?? "").trim().slice(0, 2400);
            if (!core)
                core = detail;
            // ★ P4 详版交接：结构化分节，下游开局即有完整上下文（总量上限 4000）
            const parts = [`【结论】${core}`];
            if (info.files?.length)
                parts.push(`【改动文件】\n${info.files.map((f) => `- ${f}`).join("\n")}`);
            const dur = Number(info.durationMs) > 0 ? ` · 耗时 ${Math.round(Number(info.durationMs) / 1000)}s` : "";
            parts.push(`【执行信息】run ${info.runId ?? "无"}${info.dispatchId ? ` · 工作证 #${info.dispatchId}` : ""}${dur}${info.channel ? ` · ${info.channel} 通道` : ""}`);
            if (info.logFile)
                parts.push(`【完整日志】${info.logFile}`);
            const body = parts.join("\n").slice(0, 4000);
            if (body) {
                const hIns = db.prepare(`INSERT INTO cards(board,kind,title,body,status,meta) VALUES ('default','handoff',?,?,'done',?)`)
                    .run(`交接文档 · ${String(c.title ?? "").slice(0, 80)}`.slice(0, 120), body,
                        JSON.stringify({ from_card: cardId, run_id: info.runId ?? null, dispatch_id: info.dispatchId ?? null, outcome: info.ok ? "succeeded" : "failed" }));
                db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind) VALUES (NULL,'card',?,'card',?,'handoff')`)
                    .run(cardId, Number(hIns.lastInsertRowid));
                writeCardEvent(Number(hIns.lastInsertRowid), info.actor || "dispatch-agent", "create", null, "done", `交接文档生成（run ${info.runId ?? "无"}）`);
            }
            }
            catch (e) { console.error("[cards] 交接文档生成失败（容忍：不反噬收口）", e); }
        }
        return { ok: true, statusChanged, settled };
    }
    /** depends 图成环检测（DFS；从 src 沿 depends 向后遍历是否可达 dst） */
    function dependsPathExists(fromCard, toCard, seen = new Set()) {
        if (fromCard === toCard)
            return true;
        if (seen.has(fromCard))
            return false;
        seen.add(fromCard);
        const next = db
            .prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`)
            .all(fromCard);
        return next.some((n) => dependsPathExists(n.dst_id, toCard, seen));
    }
    /** 兜底列选择（P3 内联）：与 memories 全部列一致但显式列出，避免 * 依赖列顺序 */
    function BASE_CARD_QUERY_FALLBACK() {
        return "id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence, conflict_with, superseded_by, derived_from, hit_count, last_hit_at, created_at, sector, form, salience, decay_lambda, last_seen_at, valid_from, valid_until, trigger_cond, trigger_kind, trigger_action, valence, arousal, source_ref, sensitivity, pinned";
    }
    /** julianday 解析（兼容 ISO 'T' 与 SQLite 空格两种时间格式）；坏值兜底 0 */
    const jdOf = (s) => {
        const r = db.prepare(`SELECT julianday(?) j`).get(s);
        return typeof r?.j === "number" && Number.isFinite(r.j) ? r.j : 0;
    };
    const jdNow = () => db.prepare(`SELECT julianday('now') j`).get().j;
    // 取全部 active 非 secret 记忆向量（跨 project；卡片无语义归属，需匹配全库）
    const getAllActiveVecs = () => {
        const rows = db
            .prepare(`SELECT mv.memory_id, mv.embedding FROM memory_vectors mv JOIN memories m ON m.id=mv.memory_id
                WHERE m.status='active' AND m.sensitivity != 'secret' AND m.embedding_stale=0`)
            .all();
        return rows.map((r) => ({ id: Number(r.memory_id), vec: bufToVec(r.embedding) }));
    };
    /** ★ 2026-09-20：卡片主题解析（归档分组用，只读）。
     *  优先级：cards.topic 列 > meta.topic > 标题内 [topic:xxx] > '未分类'。
     *  注：cardRowOf 不返回 topic（避免改动 /api/cards 等既有响应体），故此处直接读原始行。 */
    function topicOfCardRow(r) {
        const t = String(r.topic ?? "").trim();
        if (t)
            return t;
        try {
            const m = r.meta ? JSON.parse(r.meta) : {};
            if (m && typeof m.topic === "string" && m.topic.trim())
                return m.topic.trim();
        }
        catch { /* meta 非 JSON：忽略，落到标题解析 */ }
        const mt = /\[topic:([^\]]+)\]/.exec(String(r.title || ""));
        return mt ? mt[1].trim() : "未分类";
    }
    // ═══════════ 节点画布（P0，2026-10-04）：类型注册表 / 改型 / 边 / 智能体档案 ═══════════
    // 设计依据：D4（Agent 卡 = cards.kind='agent' 投影卡 + meta.profile_id）、D11（先建卡后选型）、
    //           连线方向按 card_types 四端口行为档位判定；可回滚 = drop card_types/card_edges/agent_profiles 三张新表。
    const CARD_TYPE_FLAGS = ["can_dispatch_out", "can_dispatch_in", "can_inject_out", "can_inject_in"];
    const BUILTIN_TYPE_KEYS = new Set(["task", "agent", "handoff", "doc"]);
    const PROFILE_CHANNELS = ["cli", "cdp", "queue"]; // UIA 仅作 CDP 内部兜底，不设独立通道（D10）
    function typeRowOf(key) {
        return db.prepare(`SELECT * FROM card_types WHERE type_key=?`).get(String(key));
    }
    /** 智能体投影卡 → 档案行（meta.profile_id 反查） */
    function profileOfCard(c) {
        const pid = Number(readCardMeta(c).profile_id) || 0;
        return pid ? db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(pid) : null;
    }
    function projectionCardOfProfile(profileId) {
        for (const r of db.prepare(`SELECT id, meta FROM cards WHERE kind='agent'`).all()) {
            try {
                const m = JSON.parse(r.meta ?? "{}");
                if (Number(m.profile_id) === Number(profileId))
                    return Number(r.id);
            }
            catch { /* meta 非法忽略 */ }
        }
        return null;
    }
    /** 载体在位探测：scanAgents 的 CLI 版本探测走 spawnSync 很慢，
     *  graph 每请求都扫会拖慢画布刷新数秒。★ 2026-10-15（第三批）：本地 TTL 收敛到
     *  scan.js 共享缓存（desktop/cards/plans 三域共用一次探测 + worker 预热）；
     *  未命中返回 null（= 原失败/未就绪降级口径，不阻断出图）。 */
    function scanKeysSafe() {
        const v = getScanCachedShared();
        if (!v)
            return null;
        return new Set((v.agents ?? []).map((a) => String(a.id ?? "")));
    }
    /** 档案是否已显式指定可执行文件（launch_overrides.exe/cmd）——指定了就不算「载体缺失」
     *  （如 opencode 完整 exe 路径 / zcode node+cjs 路径：不在 scan 清单但可用）。 */
    function profileHasOverrideExe(p) {
        // ★ 2026-10-05 批1：改用执行器同一解析器（overridesOf 容忍双重编码存量档案 #8）——
        //   旧口径 JSON.parse 一次拿到字符串 → ov.exe/ov.cmd 取不到 → 明明配了 exe 却被判「载体缺失」。
        const ov = overridesOf(p);
        return !!(ov && (String(ov.exe ?? "").trim() || String(ov.cmd ?? "").trim()));
    }
    /** 载体缺失判定：不在扫描清单 且 未显式指定可执行文件 才算缺失（2026-10-05 修：
     *  原实现只看扫描清单，launch_overrides 已给 exe/cmd 的档案被误报「载体缺失」）。 */
    function carrierMissingFor(p, keys) {
        if (!p?.agent_key)
            return false;
        if (!keys)
            return false; // 探测失败按旧口径不误报
        return !keys.has(String(p.agent_key)) && !profileHasOverrideExe(p);
    }
    /** 对外口径的「载体缺失」——只有真正要 spawn 外部载体的通道（cli/cdp）才检查。
     *  queue 通道走 MemoryOS 内部 agent 领单（见 dispatch-agent：无档案即 channel="queue"），
     *  不拉起任何外部 CLI，天然不缺载体。原实现在 queue/无档案时也报 true，
     *  后果：未绑定档案的智能体卡在任务地图被标「⚠️ 载体缺失」、点派发被前端按 carrier_missing
     *  拦死（而同一批卡走 API 却能正常派单）——即用户报的「为什么这么多不能用的」。 */
    function carrierMissingOf(p, keys) {
        if (String(p?.channel ?? "queue") === "queue")
            return false;
        return carrierMissingFor(p, keys);
    }
    function validProfileChannel(v) {
        return PROFILE_CHANNELS.includes(String(v ?? "")) ? String(v) : "queue";
    }
    /** ★ 2026-10-05 批2：工作区入参校验 —— 空 = 跟随默认（放行），非空必须是真实存在的目录。
     *  原实现照单全收 ⇒ 拼错/已删的路径存进档案后，CLI 落 `os.homedir()`、驾驶开空窗
     *  （`cliexec:158` / `cdpexec:425` 的兜底），故障点离真因太远，用户只看到「智能体在乱跑」。 */
    function workspaceError(v) {
        const s = String(v ?? "").trim();
        if (!s)
            return null;
        let abs = "";
        try {
            abs = path.resolve(s);
        }
        catch {
            return `工作区路径无法解析：${s}`;
        }
        if (!fs.existsSync(abs))
            return `工作区目录不存在：${abs}（点「📂 选择」挑一个真实目录，或先建好它）`;
        try {
            if (!fs.statSync(abs).isDirectory())
                return `工作区必须是目录，现在指向文件：${abs}`;
        }
        catch (e) {
            return `工作区不可读：${abs}（${e instanceof Error ? e.message : e}）`;
        }
        return null;
    }

    /* ═══════════ 批次 E1：14 条领域函数（自 dashboard-reg-cards.js 原路由逐字搬移）═══════════
     *  哨兵协议：null → 404；{ error } → 400；{ error, conflict } → 409；{ error, forbidden } → 403；
     *  { error, missing } → 404（连线不存在）；成功 = 裸领域值（{ ok } 信封由传输层加）。 */
    // —— 卡片列表（H3 看板主查询；P1-7 默认滤终态）——
    function listCards(args = {}) {
        const q = args ?? {};
        const where = [];
        const params = [];
        if (q.board) {
            where.push("board=?");
            params.push(q.board);
        }
        if (q.status) {
            where.push("status=?");
            params.push(q.status);
        }
        if (q.assignee) {
            where.push("assignee=?");
            params.push(q.assignee);
        }
        if (q.lane) {
            where.push("lane=?");
            params.push(q.lane);
        }
        // ★ P1-7：默认不返回终态卡（archived/cancelled）。实测 76 张卡中 46 张为终态，
        //   原实现无默认过滤 → 看板与统计被归档噪声填满。显式 ?status= 或 ?include_terminal=1 可绕过。
        if (!q.status && String(q.include_terminal ?? "") !== "1")
            where.push(`status NOT IN ('archived','cancelled')`);
        const rows = (where.length
            ? db.prepare(`SELECT * FROM cards WHERE ${where.join(" AND ")} ORDER BY priority DESC, id DESC`).all(...params)
            : db.prepare(`SELECT * FROM cards ORDER BY priority DESC, id DESC`).all());
        const list = rows.map(cardRowOf);
        const buckets = {};
        for (const s of CARD_STATES)
            buckets[s] = [];
        for (const c of list) {
            // ★ 修 #16（2026-09-19）：非法/历史状态卡不再静默丢出桶（原 total 与 buckets 求和可能不一致）
            //   —— 未知状态原样保留为动态键，total 恒等于各桶长度之和。
            (buckets[c.status] ??= []).push(c);
        }
        return { total: list.length, buckets, lanes: [...new Set(list.map((c) => c.lane).filter(Boolean))] };
    }
    // —— 卡片详情（H3 ③：含出链与记忆关联）——
    function readCardDetail(id) {
        const c = readCard(id);
        if (!c)
            return null;
        const linksOut = db
            .prepare(`SELECT dst_kind, dst_id, dst_title, kind FROM links WHERE src_kind='card' AND src_id=?`)
            .all(c.id);
        const memRows = db
            .prepare(`SELECT memory_id, relation FROM card_memory WHERE card_id=?`)
            .all(c.id);
        return { card: { ...c, meta: readCardMeta(c), links_out: linksOut, memories: memRows } };
    }
    // —— 新建卡片（C-04 标题上限 / C-06 重名软提示 / C-11 状态显式校验 / C-12 租约补偿 / P2⑦ 模板）
    function createCard(args = {}) {
        const b = args.b ?? {};
        let title = String(b.title ?? "").trim();
        // （空标题 400 属协议校验，留传输层；此处从 TITLE_MAX 起，顺序与改前一致）
        // ★ 2026-10-06（C-04）：标题长度上限 —— 前后端此前均无校验，1200 字可全量入库
        //   （实测 maxlength=-1、dashboard-reg-cards.js:644 无截断），导致详情/搜索/导出
        //   全部承载超长文本。前端 input 加 maxlength 后，后端同步兜底（UI 之外的调用方也受约束）。
        const TITLE_MAX = 200;
        if (title.length > TITLE_MAX)
            return { error: `卡片标题过长（${title.length} 字），上限 ${TITLE_MAX} 字` };
        // ★ 2026-10-06（C-06）：此前前后端均无重复检测（实测可建任意多张同名卡）。
        //   改为**软提示**而非硬拒（同标题卡在看板上有合理场景，如批量冒烟卡）——
        //   响应回 `duplicate: true` + 同名卡清单，由前端决定是否提示；`?strict_dup=1` 时才 409。
        let dupInfo = null;
        {
            const same = db.prepare(`SELECT id, kind, status FROM cards WHERE title=? AND board=? ORDER BY id DESC LIMIT 5`)
                .all(title, String(b.board ?? "default").trim() || "default");
            if (same.length) dupInfo = { count: same.length, ids: same.map(r => r.id) };
        }
        if (dupInfo && args.strictDup)
            return { error: `已存在同名卡片（共 ${dupInfo.count} 张，如 #${dupInfo.ids.slice(0, 3).join(' #')}）`, duplicate: true, count: dupInfo.count, ids: dupInfo.ids, conflict: true };
        // ★ 节点画布（D11 先建卡后选型）：缺省改为中性文档卡；kind 必须在类型注册表内（含自定义类型）
        const kind = String(b.kind ?? "doc").trim() || "doc";
        if (!db.prepare(`SELECT 1 x FROM card_types WHERE type_key=?`).get(kind))
            return { error: `未知卡片类型：${kind}` };
        // ★ 2026-10-06（C-11，收养 wt/card-fixes-20261006）：原 `CARD_STATES.includes(...) ? ... : 缺省`
        //   会把非法 status 静默吞成缺省（HTTP 200、无提示），调用方意图被丢弃。改为显式 400。
        //   仅当调用方**确实传了** status 才校验；不传走缺省。
        // ★ 2026-10-07（改进方案 P0①）：人工建卡缺省从 triage 改 todo —— triage 是采集/导入链路的
        //   「待分流」态，人工建卡时人已完成分流；默认 triage 会把新卡挡在派发预检外，逼用户多
        //   手动流转一步。采集路径（计划/记忆/笔记等）各自显式写 'triage'，不受此处影响。
        let status = "todo";
        if (b.status !== undefined && b.status !== null && String(b.status) !== "") {
            const want = String(b.status);
            if (!CARD_STATES.includes(want))
                return { error: `未知卡片状态：${want}（合法值：${CARD_STATES.join(' / ')}）` };
            status = want;
        }
        // ★ 2026-10-07（改进方案 P2⑦）建卡模板：card_types.meta.template = { title_prefix, body_skeleton }。
        //   命中模板自动套标题前缀 + 正文骨架；幂等——标题已带前缀、或正文调用方已给值时不重复套。
        //   收敛在后端单点应用：任何建卡入口（前端弹窗/探针/未来接入面）行为一致，且可探针实证。
        let body = String(b.body ?? "").trim() || null;
        const tRow = db.prepare(`SELECT meta FROM card_types WHERE type_key=?`).get(kind);
        if (tRow && tRow.meta) {
            try {
                const m = JSON.parse(tRow.meta);
                const tpl = m && m.template && typeof m.template === "object" ? m.template : null;
                if (tpl) {
                    if (tpl.title_prefix && !title.startsWith(String(tpl.title_prefix)))
                        title = String(tpl.title_prefix) + title;
                    if (tpl.body_skeleton && !body)
                        body = String(tpl.body_skeleton);
                }
            }
            catch {
                // meta 非法 JSON → 视为无模板，建卡不受阻
            }
        }
        const ins = db
            .prepare(`INSERT INTO cards(board,kind,title,body,status,assignee,priority,meta)
           VALUES (?,?,?,?,?,?,?,?)`)
            .run(String(b.board ?? "default").trim() || "default", kind, title, body, status, String(b.assignee ?? "").trim() || null, Math.max(0, Math.floor(Number(b.priority ?? 0) || 0)), b.meta ? JSON.stringify(b.meta) : null);
        const id = Number(ins.lastInsertRowid);
        // ★ 2026-10-06（C-12）：原逻辑对 status=running 的建卡**自动发放 10 分钟租约**
        //   （2026-09-19 弊端 M2 的补偿：否则租约回收器看不见它 → 僵尸泳道）。
        //   但这让人工/自动化建卡会静默占住执行槽位 10 分钟（实测 claim_lock+lease 三列均被写）。
        //   → 改为需显式 `lease=1` 才发放；否则给 running 卡一个「无租约」标记，让回收器按孤儿处理。
        if (status === "running") {
            if (String(b.lease ?? "") === "1" || String(b.assignee ?? "").trim()) {
                // ★ 2026-10-16（收养修正）：分支原文此处修饰符为 ' +10 minutes'（前导空格）——SQLite 判
                //   非法修饰符 → strftime 返回 NULL → lease_expires_at 恒空，10 分钟租约变永久锁
                //   （本会话隔离实例探针实证抓到）。去掉空格，与下方 claim 端点写法对齐。
                const lock = randomBytes(12).toString("hex");
                db.prepare(`UPDATE cards SET claim_lock=?, lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(lock, id);
            }
        }
        writeCardEvent(id, "human:dashboard", "create", null, status, title.slice(0, 80));
        // ★ 2026-10-06（C-06）：把同名卡检测结果透出，供前端提示（见上方 dupInfo）
        return dupInfo ? { id, status, kind, duplicate: true, count: dupInfo.count, ids: dupInfo.ids }
            : { id, status, kind };
    }
    // —— 更新卡片（COALESCE 局部更新；标题显式传空串 → 400）——
    function updateCardRow(id, b = {}) {
        const c = readCard(id);
        if (!c)
            return null;
        const title = b.title !== undefined ? String(b.title).trim() : null;
        if (title === "")
            return { error: "标题不能为空" };
        db.prepare(`UPDATE cards SET title=COALESCE(?,title), body=COALESCE(?,body), priority=COALESCE(?,priority),
        lane=COALESCE(?,lane), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(title, b.body !== undefined ? String(b.body) : null, b.priority !== undefined ? Math.max(0, Number(b.priority) || 0) : null, b.lane !== undefined ? String(b.lane) : null, c.id);
        writeCardEvent(c.id, "human:dashboard", "update", null, null, "卡片信息更新");
        return { id: c.id };
    }
    // —— 删除卡片（★ 绑定任务守卫：开放态任务 409 拒删，防孤儿任务）——
    function deleteCardRow(id) {
        const c = readCard(id);
        if (!c)
            return null;
        // ★ 2026-09-19（实操复盘查漏）：删卡先查绑定任务 —— ref_kind/dispatch 关联的任务记忆若仍在
        //   开放态（pending/in_progress/blocked），删卡会留「孤儿任务」继续出现在 task_next 可做集。
        //   非开放态（done/cancelled/merged/archived）或纯笔记/辅助卡不受影响。
        const boundIds = new Set();
        if (c.ref_kind === "memory" && c.ref_id)
            boundIds.add(Number(c.ref_id));
        for (const cm of db.prepare(`SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch'`).all(c.id))
            boundIds.add(Number(cm.memory_id));
        for (const mid of boundIds) {
            // 判定以 [task] 头文本为准（type 字段可能被 dashboard 写入路径静默降级，头才是事实源）
            const m = db.prepare(`SELECT id, content FROM memories WHERE id=? AND status IN ('active','trial')`).get(mid);
            if (!m)
                continue;
            // ★ 修 #11（2026-09-19）：原正则要求头部严格 [task][assignee:..][status:..] 三段序 —— 头部段序
            //   不同/带 deps 段/legacy 缺段就解析失败 → 误判非开放任务照删出孤儿。改 split 松解析（同 reconcile 口径）。
            const content = String(m.content ?? "");
            const st = content.startsWith("[task]") ? (content.split("[status:")[1]?.split("]")[0]?.trim() ?? "") : "";
            if (["pending", "in_progress", "blocked"].includes(st))
                return { error: `卡片 #${c.id} 绑定着未闭环任务 #${mid}（status=${st}）：请先 task_release / task_admin(action=verify) / task_supersede 或在记忆侧归档该任务，再删卡；直接删除会产生孤儿任务。`, conflict: true };
        }
        db.prepare(`DELETE FROM card_memory WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM links WHERE (src_kind='card' AND src_id=?) OR (dst_kind='card' AND dst_id=?)`).run(c.id, c.id);
        db.prepare(`DELETE FROM card_edges WHERE source_id=? OR target_id=?`).run(c.id, c.id); // ★ 节点画布：防悬挂边（源/目标指向已删卡）
        db.prepare(`DELETE FROM card_events WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM card_comments WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM cards WHERE id=?`).run(c.id);
        return { removed: c.id };
    }
    // —— 卡片事件流 + 评论（H3 ④：详情页时间线；?since= 增量）——
    function readCardEvents(id, since = "") {
        const c = readCard(id);
        if (!c)
            return null;
        const rows = (since
            ? db.prepare(`SELECT * FROM card_events WHERE card_id=? AND created_at>? ORDER BY id`).all(id, since)
            : db.prepare(`SELECT * FROM card_events WHERE card_id=? ORDER BY id`).all(id));
        const comments = db
            .prepare(`SELECT * FROM card_comments WHERE card_id=? ORDER BY id`)
            .all(id);
        return { events: rows, comments, latest: rows.length ? rows[rows.length - 1].created_at : null };
    }
    // —— 发评论（Agent 间协议；H4/R5-3：secret 内容扫描拒绝）——
    function addCardComment(id, b = {}) {
        const body = String(b.body ?? "").trim();
        if (!body)
            return { error: "评论不能为空" };
        const c = readCard(id);
        if (!c)
            return null;
        const author = String(b.author ?? "").trim() || "human:dashboard";
        const secretPat = /(secret|密码|passwd|token|api[_-]?key|私密)/i;
        if (secretPat.test(body) && !author.startsWith("human")) {
            return { error: "评论疑似含敏感信息，仅 human 可强制写入", forbidden: true };
        }
        db.prepare(`INSERT INTO card_comments(card_id, author, body, ref_card_ids) VALUES (?,?,?,?)`).run(id, author, body, Array.isArray(b.ref_card_ids) ? JSON.stringify(b.ref_card_ids) : null);
        writeCardEvent(id, author, "comment", null, null, body.slice(0, 80));
        return { id };
    }
    // —— 评论列表 ——
    function listCardComments(id) {
        const rows = db.prepare(`SELECT id, author, body, created_at FROM card_comments WHERE card_id=? ORDER BY id ASC`).all(id);
        return { comments: rows };
    }
    // —— H1 卡片互链：写统一 links 表 + depends 成环校验 ——
    function addCardLink(id, b = {}) {
        const dst = Number(b.dst_card_id);
        const kind = String(b.kind ?? "depends").trim();
        if (!CARD_LINK_KINDS.includes(kind))
            return { error: `非法关系 ${kind}` };
        const c = readCard(id);
        const d = readCard(dst);
        if (!c || !d)
            return null;
        // ★ 根治二版（2026-10-06）：depends 边的「前置」只能是任务卡（handoff 豁免——它天生 done）。
        //   首版只拦 agent/aux，结果 doc 卡（running）依赖照样把任务永久卡死（用户二次踩坑）。
        //   凡没有「经工作流到达 done」语义的卡（智能体/辅助/文档/…）一律不许当前置。
        if (["depends", "blocks"].includes(kind)) {
            const prereq = kind === "blocks" ? c : d;
            if (!["task", "handoff"].includes(String(prereq.kind))) {
                const kindLabel = { agent: "智能体卡", aux: "辅助卡", doc: "文档卡", handoff: "交接卡" }[String(prereq.kind)] || String(prereq.kind) + " 卡";
                return { error: `依赖线只能指向任务卡，不能指向${kindLabel}「${String(prereq.title || "").slice(0, 20)}」（#${prereq.id}）：它没有可完成的任务流，这条线大概率永远满足不了。` };
            }
            // ★ 2026-10-07（改进方案 P1⑤）：智能体卡也不能当「依赖方」——它没有可完成的任务流，
            //   「智能体卡依赖任务卡」没有业务含义（既不会被派发也不会 done），只会积累噪音边。
            //   要把任务交给它，用任务卡上的「⚡ 派发给…」：派发边由派发动作自动建立、跟工作证生命周期走。
            const consumer = kind === "blocks" ? d : c;
            if (String(consumer.kind) === "agent") {
                return { error: `智能体卡不参与依赖线：「智能体卡依赖任务卡」没有业务含义。要把任务 #${kind === "blocks" ? dst : id} 交给它，请在任务卡上用「⚡ 派发给…」。` };
            }
        }
        // blocks → 反向 depends（M3）
        const finalKind = kind === "blocks" ? "depends" : kind;
        if (finalKind === "depends") {
            // ★ 修 #1（2026-09-19）：原 dir 三元判的是 finalKind（恒为 'depends'）→ blocks 也存成
            //   「id 依赖 dst」，方向整个反了。正确语义：depends = id 依赖 dst（src=id）；blocks =
            //   id 阻塞 dst ⇔ dst 依赖 id（src=dst）。成环检测跟着方向走：加边 X→Y 前查 Y 是否已可达 X。
            const forward = kind !== "blocks"; // true=存 src=id → dst
            const cycle = forward ? dependsPathExists(dst, id) : dependsPathExists(id, dst);
            if (cycle)
                return { error: kind === "blocks" ? "成环：本卡已（传递）依赖 dst，无法再阻塞它" : "成环：dst 已依赖本卡", conflict: true };
            const dir = forward ? [id, dst] : [dst, id];
            // ★ 2026-10-06 修复（L-07）：`INSERT OR IGNORE` 遇重复边**静默忽略**，但端点仍返
            //   `{ok:true}` 且 UI toast「已连线」→ 用户以为改了连线实则毫无变化，且 writeCardEvent
            //   仍在后面无条件执行 → card_events +1（审计记账与实际不一致）。实测：重复连同一对，
            //   links 行数未变但 API 200、card_events +1。改为先判存在性，明确回报「已存在」。
            const dup = db.prepare(`SELECT 1 x FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id=? AND kind='depends'`).get(dir[0], dir[1]);
            if (dup)
                return { error: `该依赖线已存在（#${dir[0]} → #${dir[1]}）`, already_exists: true, from: id, to: dst, kind: finalKind, conflict: true };
            db.prepare(`INSERT INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind)
           VALUES (NULL,'card',?,'card',?,'depends')`).run(dir[0], dir[1]);
            writeCardEvent(id, "human:dashboard", "link", null, null, kind === "blocks" ? `blocks → #${dst}（存为 depends：#${dst} → #${id}）` : `depends → #${dst}`);
        }
        else {
            const dup = db.prepare(`SELECT 1 x FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id=? AND kind=?`).get(id, dst, finalKind);
            if (dup)
                return { error: `该关系已存在（${finalKind} → #${dst}）`, already_exists: true, from: id, to: dst, kind: finalKind, conflict: true };
            db.prepare(`INSERT INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind)
           VALUES (NULL,'card',?,'card',?,?)`).run(id, dst, finalKind);
            writeCardEvent(id, "human:dashboard", "link", null, null, `${finalKind} → #${dst}`);
        }
        return { from: id, to: dst, kind: finalKind };
    }
    // —— 删连线（★ L-08：先判存在性，删从未存在的边显式 404）——
    function deleteCardLink(id, dst, kind) {
        // ★ 2026-10-06 修复（L-08）：原直接 DELETE 无存在性校验 → 删从未存在的边也返 {ok:true}，
        //   前端无法区分「删成功」与「本来就没有」（实测 dst=999999 仍 200）。改为先判存在性。
        const exists = db.prepare(`SELECT 1 x FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id=? AND kind=?`).get(id, dst, kind);
        if (!exists)
            return { error: `连线不存在（#${id} → #${dst}，${kind}）`, missing: true };
        const info = db.prepare(`DELETE FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id=? AND kind=?`).run(id, dst, kind);
        return { removed: info.changes };
    }
    // —— 状态流转（H3 ②：WHERE status=expected_from 前置校验 + 白名单 + 验收门 + TOCTOU 守卫）——
    function transitionCard(id, b = {}, actor, credential) {
        const to = String(b.status ?? "").trim();
        const expectedFrom = String(b.expected_from ?? "").trim() || undefined;
        const credErr = actorCredError(actor, credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403）
        if (credErr)
            return { error: credErr, forbidden: true };
        if (!CARD_STATES.includes(to))
            return { error: `非法状态 ${to}` };
        const c = readCard(id);
        if (!c)
            return null;
        if (!CARD_TRANSITIONS[c.status]?.includes(to)) {
            return { error: `非法迁移 ${c.status} → ${to}`, conflict: true };
        }
        // ★ 修 #7（2026-09-19）：M2 验收门 —— 卡带验收标准（meta.acceptance 非空）时不允许经 /status
        //   直达 done，必须走 /api/cards/:id/accept 显式验收。原 /accept 注释声明了该契约但 /status
        //   不检查，agent 可一步绕过验收。
        if (to === "done") {
            const acc = readCardMeta(c).acceptance;
            const hasAcc = acc != null && !(Array.isArray(acc) && acc.length === 0);
            if (hasAcc)
                return { error: "卡带验收标准（meta.acceptance），须经 /api/cards/:id/accept 验收后才能 done", conflict: true };
        }
        if (c.status === "running" && c.assignee && c.assignee !== "unassigned" && !actor.startsWith("human") && actor !== c.assignee) {
            return { error: "非认领者无权流转", forbidden: true };
        }
        // ★ 修 #8（2026-09-19）：迁移白名单/权限检查都基于先读的 c.status，原 UPDATE 仅在显式传
        //   expectedFrom 时才带状态守卫 → 读改之间被并发改写时，校验过的迁移会被无条件覆盖（TOCTOU）。
        //   现恒以「读到的状态」（或显式 expectedFrom）作 WHERE 守卫，白名单校验与落笔原子化。
        const guardFrom = expectedFrom ?? c.status;
        const info = db
            .prepare(`UPDATE cards SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status=?`)
            .run(to, id, guardFrom);
        if (Number(info.changes) === 0) {
            return { error: `状态前置不符（期望 ${guardFrom}），可能已被其他操作改写`, conflict: true };
        }
        writeCardEvent(id, actor, "status_changed", c.status, to);
        if (to === "done")
            // ★ 2026-09-19（弊端 L4）：三清对齐 MCP 侧（锁 + 租约窗 + 贴条）——原仅清 claim_lock 残留过期租约
            db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(id);
        if (to === "failed")
            db.prepare(`UPDATE cards SET failure_count=failure_count+1 WHERE id=?`).run(id);
        // ★ B3（2026-10-18 · P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：门控失败计数清零。
        //   仅两个"洗白"点：成功收口（to=done）与人工介入（human:  actor，含人工认领/改派/reopen）；
        //   agent 自流转不清零——agent 重领若清零，熔断计数永远累加到不了 2（详见 task-domain.gateBreakerOn）。
        if (gateBreakerOn() && (to === "done" || actor.startsWith("human")))
            db.prepare(`UPDATE cards SET gate_fail_count=0 WHERE id=?`).run(id);
        syncCardToTask(id); // ★ 2026-09-15：卡片状态回写关联 task 记忆状态头
        return { id, from: c.status, to };
    }
    // —— M2 验收：review → done（meta.acceptance 存在时必须走此端点）——
    function acceptCard(id, actor, credential) {
        const credErr = actorCredError(actor, credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403）
        if (credErr)
            return { error: credErr, forbidden: true };
        const c = readCard(id);
        if (!c)
            return null;
        if (c.status !== "review")
            return { error: "仅 review 状态可验收", conflict: true };
        db.prepare(`UPDATE cards SET status='done', updated_at=datetime('now') WHERE id=? AND status='review'`).run(id);
        if (gateBreakerOn()) // ★ B3（P2 · 开关默认关）：验收收口清零门控失败计数（与 transitionCard done 同口径）
            db.prepare(`UPDATE cards SET gate_fail_count=0 WHERE id=?`).run(id);
        writeCardEvent(id, actor, "accept", "review", "done", "验收通过");
        syncCardToTask(id); // ★ 验收 → 关联 task 回写 done
        return { id };
    }
    // —— CAS 认领（H3 ①）——
    function claimCard(id, actor, credential) {
        const credErr = actorCredError(actor, credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403）
        if (credErr)
            return { error: credErr, forbidden: true };
        // ★ C1（P0 · 开关 MEMORYOS_DEP_VALIDATE=1，默认关）：卡级依赖闸门——与 dispatch-agent 的
        //   pendingDepends 预检同口径（task_assign 带头依赖建卡时同步写 depends 边，两边判据自此收敛，§0.3）。
        if (depValidateOn()) {
            const pend = pendingDepends(id);
            if (pend.length)
                return { error: depPendingMsg(pend), conflict: true };
        }
        const lock = randomBytes(12).toString("hex");
        const info = db
            .prepare(`UPDATE cards SET status='running', assignee=?, claim_lock=?,
           lease_expires_at=datetime('now','+10 minutes'), heartbeat_at=datetime('now'), updated_at=datetime('now')
         WHERE id=? AND status='ready' AND claim_lock IS NULL`)
            .run(actor, lock, id);
        if (Number(info.changes) === 0)
            return { error: "认领失败：卡片不在 ready 或已被认领", conflict: true };
        writeCardEvent(id, actor, "claim", "ready", "running", `CAS 认领（lock=${lock.slice(0, 8)}…）`);
        syncCardToTask(id, { assignee: actor }); // ★ 认领 → 关联 task 回写 in_progress + assignee（修 #10）
        return { id, assignee: actor, lock };
    }
    // —— 心跳续租（R6-4：常规续窗不写 events；续期同时撕贴条与 stale 裁决标记）——
    function heartbeatCard(id, actor, credential) {
        const credErr = actorCredError(actor, credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403；人类缺省流量不变）
        if (credErr)
            return { error: credErr, forbidden: true };
        // ★ 修 #2（2026-09-19）：续期同时撕 lease_notice_at（与 MCP task_heartbeat 同口径）。
        //   原来看板心跳只续窗不清贴条，导致漏一次心跳被贴条后，活跃认领者的卡被误判。
        //   撕条是状态变更，写一条事件留痕（R6-4 的"心跳静默"口径仅指常规续窗，不含贴条撕除）。
        // ★ 批次 B1（2026-10-03）：心跳=**正面存活证明** → 同时撤 lease_stale_at 裁决标记（reaper 已改
        //   「只标不回收」，撤销标记即回到正常持有态；卡恢复 running 全权）。
        const had = db.prepare(`SELECT lease_notice_at FROM cards WHERE id=? AND assignee=?`).get(id, actor);
                // ★ 2026-09-19（弊端 M3）：心跳续租仅限 running 态卡——done/blocked 卡不再被静默续租
        const info = db
            .prepare(`UPDATE cards SET heartbeat_at=datetime('now'), lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), lease_notice_at=NULL, lease_stale_at=NULL WHERE id=? AND assignee=? AND status='running'`)
            .run(id, actor);
        if (Number(info.changes) === 0)
            return { error: "心跳失败：非认领者 / 无此卡 / 卡片不在 running 态", conflict: true };
        if (had?.lease_notice_at)
            writeCardEvent(id, actor, "lease_notice_cleared", "running", "running", "看板心跳续期，撕除租约过期贴条");
        return { id };
    }

    /* ═══════════ 批次 E2a：工作台配置面 16 条领域函数（自原路由逐字搬移）═══════════ */
    // —— 类型注册表（节点画布 D4：四端口行为档位）——
    function listCardTypes() {
        return { types: db.prepare(`SELECT * FROM card_types ORDER BY builtin DESC, type_key`).all() };
    }
    function createCardType(b = {}) {
        const key = String(b.type_key ?? "").trim();
        if (!/^[a-z][a-z0-9_]{1,31}$/.test(key))
            return { error: "类型标识需为小写字母开头、2-32 位的小写字母/数字/下划线" };
        if (BUILTIN_TYPE_KEYS.has(key) || key.startsWith("aux"))
            return { error: "该标识为系统保留，不能用作自定义类型", conflict: true };
        const label = String(b.label ?? "").trim();
        if (!label)
            return { error: "类型显示名不能为空" };
        if (typeRowOf(key))
            return { error: `类型已存在：${key}`, conflict: true };
        db.prepare(`INSERT INTO card_types(type_key,label,color,builtin,can_dispatch_out,can_dispatch_in,can_inject_out,can_inject_in,meta)
            VALUES (?,?,?,0,?,?,?,?,?)`)
            .run(key, label, String(b.color ?? "").trim() || null,
                ...CARD_TYPE_FLAGS.map((f) => (b[f] ? 1 : 0)), b.meta ? JSON.stringify(b.meta) : null);
        return { type_key: key };
    }
    function updateCardType(key, b = {}) {
        const row = typeRowOf(String(key));
        if (!row)
            return null;
        if (row.builtin)
            return { error: "系统内置类型不可修改", conflict: true };
        const label = b.label !== undefined ? String(b.label).trim() : row.label;
        if (!label)
            return { error: "类型显示名不能为空" };
        db.prepare(`UPDATE card_types SET label=?, color=?, can_dispatch_out=?, can_dispatch_in=?, can_inject_out=?, can_inject_in=?, meta=? WHERE type_key=?`)
            .run(label,
                b.color !== undefined ? (String(b.color).trim() || null) : row.color,
                ...CARD_TYPE_FLAGS.map((f) => (b[f] !== undefined ? (b[f] ? 1 : 0) : (Number(row[f]) ? 1 : 0))),
                // ★ 2026-10-07（P2⑦）：PUT 支持 meta（模板等）；未传保持原值
                b.meta !== undefined ? (b.meta ? JSON.stringify(b.meta) : null) : (row.meta ?? null),
                row.type_key);
        return { type_key: row.type_key };
    }
    function deleteCardType(key) {
        const row = typeRowOf(String(key));
        if (!row)
            return null;
        if (row.builtin)
            return { error: "系统内置类型不可删除", conflict: true };
        const used = Number(db.prepare(`SELECT COUNT(*) n FROM cards WHERE kind=?`).get(row.type_key).n);
        if (used > 0)
            return { error: `仍有 ${used} 张卡片使用该类型，不能删除`, conflict: true };
        db.prepare(`DELETE FROM card_types WHERE type_key=?`).run(row.type_key);
        return {};
    }
    // —— 改型（先建卡后选型的核心端点；PUT /api/cards/:id 不支持改 kind，故单列）——
    function retypeCard(id, b = {}) {
        const c = readCard(id);
        if (!c)
            return null;
        const kind = String(b.kind ?? "").trim();
        const t = typeRowOf(kind);
        if (!t)
            return { error: `未知卡片类型：${kind}` };
        if (c.kind === kind)
            return { id, kind, unchanged: true };
        if (String(c.status) === "running")
            return { error: "卡片执行中，不能改型", conflict: true };
        const activeEdge = db.prepare(`SELECT id FROM card_edges WHERE (source_id=? OR target_id=?) AND kind='dispatch' AND status='active'`).get(id, id);
        if (activeEdge)
            return { error: "卡片存在进行中的派发连线，不能改型", conflict: true };
        const meta = readCardMeta(c);
        // 切入智能体卡：请求内直接建档案（一步到位，免两跳）
        if (kind === "agent" && !meta.profile_id) {
            const p = b.profile ?? {};
            const name = String(p.name ?? c.title ?? "").trim();
            if (!name)
                return { error: "切换为智能体卡需要提供名称（profile.name）" };
            const ins = db.prepare(`INSERT INTO agent_profiles(name,agent_key,channel,workspace,model,context_tokens,reasoning,launch_overrides)
                VALUES (?,?,?,?,?,?,?,?)`)
                .run(name, String(p.agent_key ?? "").trim() || null, validProfileChannel(p.channel),
                    String(p.workspace ?? "").trim() || null, String(p.model ?? "").trim() || null,
                    Number(p.context_tokens) > 0 ? Math.floor(Number(p.context_tokens)) : null,
                    String(p.reasoning ?? "").trim() || null, p.launch_overrides ? JSON.stringify(p.launch_overrides) : null);
            meta.profile_id = Number(ins.lastInsertRowid);
        }
        // 切出智能体卡：档案随卡删除（配置不留孤儿）
        if (String(c.kind) === "agent" && kind !== "agent" && meta.profile_id) {
            db.prepare(`DELETE FROM agent_profiles WHERE id=?`).run(Number(meta.profile_id));
            delete meta.profile_id;
        }
        // ★ meta 必须随改型写回：切入 agent 时 profile_id 只在此处落库（否则投影卡永远找不到档案）
        db.prepare(`UPDATE cards SET kind=?, meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(kind, JSON.stringify(meta), id);
        if (kind === "task" && !CARD_STATES.includes(String(c.status)))
            db.prepare(`UPDATE cards SET status='triage' WHERE id=?`).run(id); // 非法态兜底进任务状态机
        writeCardEvent(id, "human:dashboard", "retype", String(c.kind), kind, `改型 ${c.kind} → ${kind}`);
        return { id, kind, profile_id: meta.profile_id ?? null };
    }
    // —— 智能体档案（投影卡同事务，不留孤儿）——
    function listAgentProfiles() {
        const rows = db.prepare(`SELECT * FROM agent_profiles ORDER BY id`).all();
        const cardByProfile = new Map();
        for (const r of db.prepare(`SELECT id, meta, status FROM cards WHERE kind='agent'`).all()) {
            try {
                const m = JSON.parse(r.meta ?? "{}");
                if (m.profile_id)
                    cardByProfile.set(Number(m.profile_id), { card_id: Number(r.id), status: String(r.status ?? "") });
            }
            catch { /* meta 非法忽略 */ }
        }
        const keys = scanKeysSafe();
        return {
            profiles: rows.map((p) => ({
                ...p,
                card: cardByProfile.get(Number(p.id)) ?? null,
                carrier_missing: carrierMissingOf(p, keys),
            })),
        };
    }
    function createAgentProfile(b = {}) {
        const name = String(b.name ?? "").trim();
        if (!name)
            return { error: "智能体卡名称不能为空" };
        const channel = validProfileChannel(b.channel);
        const wsErr = workspaceError(b.workspace); // ★ 批2：先校验再开事务，非法路径不落库
        if (wsErr)
            return { error: wsErr };
        txBegin(); // 档案 + 投影卡一笔事务：不留孤儿半截
        let profileId = 0, cardId = 0;
        try {
            const ins = db.prepare(`INSERT INTO agent_profiles(name,agent_key,channel,workspace,model,context_tokens,reasoning,concurrency,launch_overrides,meta)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
                .run(name, String(b.agent_key ?? "").trim() || null, channel,
                    String(b.workspace ?? "").trim() || null, String(b.model ?? "").trim() || null,
                    Number(b.context_tokens) > 0 ? Math.floor(Number(b.context_tokens)) : null,
                    String(b.reasoning ?? "").trim() || null,
                    Number(b.concurrency) > 0 ? Math.floor(Number(b.concurrency)) : 1,
                    b.launch_overrides ? JSON.stringify(b.launch_overrides) : null,
                    b.meta ? JSON.stringify(b.meta) : null);
            profileId = Number(ins.lastInsertRowid);
            const meta = { profile_id: profileId };
            const pos = b.meta?.map_pos;
            // ★ 2026-10-06 修复（手工测试 C-10 严重）：原把智能体卡位置硬包进废弃的 `c` 桶
            //   （`c` 是已删「节点画布」时代的落点），而看板读侧只认 h/v → 位置 100% 失效。
            //   同时前端 agent 路径发的是 `{map_pos:{x,y}}`（无 h 包装），与普通卡的 `{h:{x,y}}`
            //   两种形状不一致，极易再错位。→ 统一收敛到 `h` 桶，并兼容两种入参形状。
            if (pos) {
                const px = Number(pos.h?.x ?? pos.x);
                const py = Number(pos.h?.y ?? pos.y);
                if (Number.isFinite(px) && Number.isFinite(py))
                    meta.map_pos = { h: { x: Math.round(px), y: Math.round(py) } };
            }
            const cIns = db.prepare(`INSERT INTO cards(board,kind,title,body,status,meta) VALUES ('default','agent',?,NULL,'todo',?)`)
                .run(name, JSON.stringify(meta));
            cardId = Number(cIns.lastInsertRowid);
            writeCardEvent(cardId, "human:dashboard", "create", null, "todo", `新建智能体卡 ${name}`);
            txCommit();
        }
        catch (e) {
            try { txRollback(); }
            catch (e2) { console.error("[cards] agent-profiles 建档案回滚异常", e2); }
            console.error("[cards] agent-profiles 建档案失败（已回滚，不留孤儿）", e);
            throw e; // 500 属传输层协议行为（C 批 embed.recompute 同口径：抛错由适配器映射）
        }
        return { profile_id: profileId, card_id: cardId };
    }
    function updateAgentProfile(id, b = {}) {
        const p = db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(Number(id));
        if (!p)
            return null;
        const cardId = projectionCardOfProfile(p.id);
        if (cardId) {
            const busy = db.prepare(`SELECT id FROM card_edges WHERE target_id=? AND kind='dispatch' AND status='active'`).get(cardId);
            if (busy)
                return { error: "该智能体卡有进行中的派发，执行完再改配置", conflict: true };
        }
        const name = b.name !== undefined ? String(b.name).trim() : p.name;
        if (!name)
            return { error: "名称不能为空" };
        if (b.workspace !== undefined) { // ★ 批2：编辑态同样校验（原实现照单全收 → 档案里存着不存在的路径）
            const wsErr = workspaceError(b.workspace);
            if (wsErr)
                return { error: wsErr };
        }
        db.prepare(`UPDATE agent_profiles SET name=?, agent_key=?, channel=?, workspace=?, model=?, context_tokens=?, reasoning=?, concurrency=?, launch_overrides=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(name,
                b.agent_key !== undefined ? (String(b.agent_key).trim() || null) : p.agent_key,
                b.channel !== undefined ? validProfileChannel(b.channel) : p.channel,
                b.workspace !== undefined ? (String(b.workspace).trim() || null) : p.workspace,
                b.model !== undefined ? (String(b.model).trim() || null) : p.model,
                b.context_tokens !== undefined ? (Number(b.context_tokens) > 0 ? Math.floor(Number(b.context_tokens)) : null) : p.context_tokens,
                b.reasoning !== undefined ? (String(b.reasoning).trim() || null) : p.reasoning,
                b.concurrency !== undefined ? (Number(b.concurrency) > 0 ? Math.floor(Number(b.concurrency)) : 1) : p.concurrency,
                b.launch_overrides !== undefined ? (b.launch_overrides ? JSON.stringify(b.launch_overrides) : null) : p.launch_overrides,
                p.id);
        if (cardId && b.name !== undefined) // 投影卡标题随档案名同步
            db.prepare(`UPDATE cards SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(name, cardId);
        return { id: p.id };
    }
    function deleteAgentProfile(id) {
        const p = db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(Number(id));
        if (!p)
            return null;
        const cardId = projectionCardOfProfile(p.id);
        if (cardId) {
            const busy = db.prepare(`SELECT id FROM card_edges WHERE target_id=? AND kind='dispatch' AND status='active'`).get(cardId);
            if (busy)
                return { error: "该智能体卡有进行中的派发，不能删除", conflict: true };
            db.prepare(`DELETE FROM card_edges WHERE source_id=? OR target_id=?`).run(cardId, cardId);
            db.prepare(`DELETE FROM cards WHERE id=?`).run(cardId);
        }
        db.prepare(`DELETE FROM agent_profiles WHERE id=?`).run(p.id);
        return {};
    }
    // —— 前情注入边（派发边只由 dispatch-agent 在派发事务内创建，避免绕过唯一 active/fencing）——
    function addCardEdge(b = {}) {
        const kind = String(b.kind ?? "").trim();
        if (kind !== "inject")
            return { error: "此端点仅创建前情注入边（派发边由「派发」动作自动建立）" };
        const sourceId = Number(b.source_id) || 0, targetId = Number(b.target_id) || 0;
        if (!sourceId || !targetId)
            return { error: "缺少边端点（source_id/target_id）" };
        if (sourceId === targetId)
            return { error: "不能连接到自身" };
        const s = readCard(sourceId), t = readCard(targetId);
        if (!s || !t)
            return null;
        const st = typeRowOf(String(s.kind)), tt = typeRowOf(String(t.kind));
        if (!st?.can_inject_out)
            return { error: `「${st?.label ?? s.kind}」类型不能发起前情注入`, conflict: true };
        if (!tt?.can_inject_in)
            return { error: `「${tt?.label ?? t.kind}」类型不能接收前情注入`, conflict: true };
        try {
            const ins = db.prepare(`INSERT INTO card_edges(source_id,target_id,kind,status) VALUES (?,?,'inject','active')`).run(sourceId, targetId);
            return { id: Number(ins.lastInsertRowid) };
        }
        catch (e) {
            // 唯一索引冲突=重复连线（预期 409）；其他异常也如实落日志，避免误报成「重复连线」掩盖真错误
            console.error("[cards] card-edges 建注入边失败（常见为重复连线）", e);
            return { error: "该交接文档已注入此任务（重复连线）", conflict: true };
        }
    }
    function deleteCardEdge(id) {
        const e = db.prepare(`SELECT * FROM card_edges WHERE id=?`).get(Number(id));
        if (!e)
            return null;
        if (e.kind === "dispatch")
            return { error: "派发边是历史链的一部分，不可手删（随派发终态自动翻状态）", conflict: true };
        db.prepare(`DELETE FROM card_edges WHERE id=?`).run(e.id);
        return {};
    }
    // —— 位置持久化 / 重置（D-13）——
    function setCardPosition(id, b = {}) {
        const c = readCard(id);
        if (!c)
            return null;
        const view = String(b.view ?? "h").trim().slice(0, 8) || "h";
        const x = Math.round(Number(b.x) || 0);
        const y = Math.round(Number(b.y) || 0);
        const meta = readCardMeta(c);
        const mapPos = (meta.map_pos && typeof meta.map_pos === "object" ? meta.map_pos : {});
        mapPos[view] = { x, y };
        meta.map_pos = mapPos;
        db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify(meta), id);
        return { id, view, x, y };
    }
    /** scope 由传输层解析（?ids=1,2,3 / ?id=1 → 正整数数组；空 = 全表清空保持旧契约） */
    function resetCardPositions(scope = []) {
        const rows = scope.length
            ? db.prepare(`SELECT id, meta FROM cards WHERE id IN (${scope.map(() => '?').join(',')})`).all(...scope)
            : db.prepare(`SELECT id, meta FROM cards`).all();
        const upd = db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
        let cleared = 0;
        const clearedIds = [];
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const r of rows) {
                let meta = {};
                try {
                    meta = r.meta ? JSON.parse(r.meta) : {};
                }
                catch { /* 坏 JSON 忽略 */ }
                if (!meta.map_pos)
                    continue;
                delete meta.map_pos;
                upd.run(JSON.stringify(meta), r.id);
                cleared++; clearedIds.push(r.id);
            }
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return { cleared, clearedIds, scoped: scope.length > 0 };
    }
    // —— 归档策略（config 表 cards.archive_mode / cards.archive_days）——
    function getArchivePolicy() {
        const mode = String(readConfig(db, "cards.archive_mode", "auto") ?? "auto");
        const days = Number(readConfig(db, "cards.archive_days", 7) ?? 7);
        return { mode: mode === "manual" ? "manual" : "auto", days };
    }
    function setArchivePolicy(b = {}) {
        if (b.mode !== undefined) {
            const mode = String(b.mode).trim();
            if (mode !== "auto" && mode !== "manual")
                return { error: "mode 仅支持 auto/manual" };
            writeConfig(db, "cards.archive_mode", mode);
            return { mode };
        }
        if (b.days !== undefined) {
            const days = Math.max(1, Math.floor(Number(b.days) || 7));
            writeConfig(db, "cards.archive_days", days);
            return { days };
        }
        // now:true 立即归档：done 且完成时间（updated_at）超阈值 → archived（写事件留痕）
        const days = Number(readConfig(db, "cards.archive_days", 7) ?? 7);
        const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        const done = db.prepare(`SELECT id FROM cards WHERE status='done' AND COALESCE(updated_at, created_at) < ?`).all(cutoff);
        const upd = db.prepare(`UPDATE cards SET status='archived', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='done'`);
        let archived = 0;
        txBegin(); // ★ 修 #9：事务内事件入队
        try {
            for (const c of done) {
                const info = upd.run(c.id);
                if (Number(info.changes)) {
                    writeCardEvent(c.id, "human:dashboard", "archive", "done", "archived", `手工归档（阈值 ${days} 天）`);
                    syncCardToTask(c.id); // ★ 修 #12（2026-09-19）：归档同步回写任务头 done→archived
                    archived++;
                }
            }
            txCommit();
        }
        catch (e) {
            txRollback();
            throw e;
        }
        return { run: { archived, cutoffDays: days }, mode: String(readConfig(db, "cards.archive_mode", "auto")) };
    }
    function listArchiveGrouped(by = "topic") {
        const rows = db
            .prepare(`SELECT id, kind, title, topic, meta, created_at, updated_at FROM cards WHERE status='archived' ORDER BY COALESCE(updated_at, created_at) DESC`)
            .all();
        const map = new Map();
        for (const r of rows) {
            const topic = topicOfCardRow(r);
            if (!map.has(topic))
                map.set(topic, []);
            map.get(topic).push({ id: Number(r.id), title: r.title, kind: r.kind, topic, at: r.updated_at || r.created_at });
        }
        const groups = [...map.entries()]
            .map(([topic, cards]) => ({
            topic,
            count: cards.length,
            first: cards[cards.length - 1]?.at ?? null,
            last: cards[0]?.at ?? null,
            cards,
        }))
            .sort((a, b) => b.count - a.count || String(a.topic).localeCompare(String(b.topic), "zh"));
        return { by, total: rows.length, groups };
    }

    return {
        CARD_STATES, CARD_TRANSITIONS, CARD_LINK_KINDS, CARD_TO_SECTOR, DEP_SATISFIED, AGENT_NAME_RE,
        pushCardEvt, cardSubs, ensureEvtPoller, stopEvtPoller, cardRowOf, readCard, readCardMeta,
        txBegin, txCommit, txRollback, writeCardEvent, syncCardToTask, actorCredError,
        pendingDepends, cardDependsDone, depPendingMsg, finalizeCardDispatch, dependsPathExists,
        BASE_CARD_QUERY_FALLBACK, jdOf, jdNow, topicOfCardRow, getAllActiveVecs,
        CARD_TYPE_FLAGS, BUILTIN_TYPE_KEYS, PROFILE_CHANNELS, typeRowOf, profileOfCard,
        projectionCardOfProfile, scanKeysSafe, profileHasOverrideExe, carrierMissingFor,
        carrierMissingOf, validProfileChannel, workspaceError,
        // E1 领域函数
        listCards, readCardDetail, createCard, updateCardRow, deleteCardRow,
        readCardEvents, addCardComment, listCardComments, addCardLink, deleteCardLink,
        transitionCard, acceptCard, claimCard, heartbeatCard,
        // E2a 领域函数（工作台配置面）
        listCardTypes, createCardType, updateCardType, deleteCardType, retypeCard,
        listAgentProfiles, createAgentProfile, updateAgentProfile, deleteAgentProfile,
        addCardEdge, deleteCardEdge, setCardPosition, resetCardPositions,
        getArchivePolicy, setArchivePolicy, listArchiveGrouped,
    };
}
