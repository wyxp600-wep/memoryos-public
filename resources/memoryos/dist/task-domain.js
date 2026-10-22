/**
 * MemoryOS — 任务域领域逻辑（架构重构第 2 条「统一操作注册表，消除双传输层」· 批次 A · 2026-10-14）
 *
 * ── 单一真相源 ──────────────────────────────────────────────────────
 *   本模块承载 REST `GET /api/tasks`（dashboard-reg-memory.js）那套领域语义：任务头解析 / 状态归一 /
 *   依赖提取 / 结论提取 / blocked 补标记 / 七态分桶装配。**逐字自原实现搬出，行为逐字节不变**
 *   （原实现见 git 历史 dashboard-reg-memory.js 中 `app.get("/api/tasks", ...)` 一段）。
 *   注册表（ops-registry.js 的 `tasks.list`）与 REST 路由都指向本模块 —— 领域逻辑只有一份。
 *
 * ── ★ 边界（本批刻意，勿越界"统一"）──────────────────────────────────
 *   仅承载 REST 看板语义。MCP `task_next`（server-reg-task.js）**未**并入本模块 ——
 *   实测两者**非同一套语义**，主要差异：
 *     ① 取数范围：REST = queryByType(status:'active') 取 limit*3；task_next = status IN('active','trial')
 *        且 project IN(?, 'global')，LIMIT 500，另全表扫描算 done 集合。
 *     ② 头字段作用域：REST 对**整段 content** 匹配 assignee/depends；task_next 只匹配**头行**（headLineOf）。
 *     ③ 头正则：REST 用共享 TASK_HEAD_RE（枚举态 | open|claimed）；task_next 用本地 /^...[status:([a-z_]+)]/（更宽）。
 *     ④ 无头处理：REST 回落 status="unknown"；task_next 直接跳过该行（readTaskState 返回 null）。
 *     ⑤ 正文剥离：REST 另剥 [plan:][taskid:] 与「→ 结论(...)」；task_next 只剥头与头行依赖段。
 *     ⑥ 输出形状：REST = 结构化行 + 分桶 JSON；task_next = 多段中文文案（可做集/阻塞/我在做/待决策 + 依赖
 *        传递解析(merged)/死端†/卡片优先级/会话隔离/租约提示等 REST 没有的语义）。
 *   强行合并会造成行为漂移，故本批**只做 REST 侧迁移**，task_next 留待后续批次按各自语义收敛。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────
 *   dashboard-task-util.js（头正则 / 依赖段 / 桶名 —— 与 REST 侧同一份共享常量，不新增副本）
 *   db.js（queryByType —— 只读查询，无写副作用）
 */
import { queryByType, writeMemory, updateMemory, readMemory, appendEvent, logUsage, bumpConfidence, markMerged, logExecAudit, createDispatch, readDispatchByKey, readActiveDispatch, settleDispatch, releaseDispatch } from "./db.js";
import { TASK_HEAD_RE, TASK_NORMALIZE, TASK_DEP_RE, TASK_BUCKETS } from "./dashboard-task-util.js";
import { TxAbort, runTaskTx, stateReceipt } from "./tx.js"; // ★ Step 0：事务/回执原语落叶子模块，双方共用无循环依赖
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 解析任务行：type='task' 且列 status=status 的记忆 → 结构化行数组（逐字段与原 REST 实现一致）。
 * @param {import("node:sqlite").Database} db
 * @param {{limit?:number, status?:string}} opts
 *   limit —— **调用方（传输适配器）须先行 clamp 到 [1,500]**；本函数按 limit*3 取原始窗口（与原实现同口径，
 *            多取以覆盖「头 status 与列 status 不一致」的存量行）。
 *   status —— 列过滤（REST 侧恒为 "active"）。
 * @returns 行数组：{id,status,assignee,submittedBy,deps,blocked,body,conclusion,concludedBy,confidence,created_at}
 */
export function parseTaskRows(db, { limit = 100, status = "active" } = {}) {
    const raw = queryByType(db, "task", { limit: limit * 3, status });
    const rows = raw.map((r) => {
        const m = r.content.match(TASK_HEAD_RE);
        const am = r.content.match(/\[assignee:([^\]]*)\]/);
        const cm = r.content.match(/→ 结论\(([^)]*)\)：([\s\S]*)$/);
        const dm = r.content.match(TASK_DEP_RE);
        const rawStatus = m ? m[1] : "unknown";
        const status = rawStatus === "unknown" ? "unknown" : (TASK_NORMALIZE[rawStatus] ?? rawStatus);
        const assignee = am ? am[1] : null;
        const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
        const body = r.content
            .replace(TASK_HEAD_RE, "")
            .replace(/\[plan:[^\]]+\]\[taskid:[^\]]+\]/g, "")
            .replace(TASK_DEP_RE, "")
            .replace(/→ 结论\(.*$/s, "")
            .trim();
        return { id: r.id, status, assignee, submittedBy: r.agent, deps, blocked: false, body: body.slice(0, 200), conclusion: cm ? cm[2].trim().slice(0, 200) : null, concludedBy: cm ? cm[1] : null, confidence: r.confidence, created_at: r.created_at };
    });
    markTaskBlocked(rows);
    return rows;
}

/**
 * 补 blocked 标记（原地写入行对象的既有 blocked 字段，不改变键序）：
 *   pending 且依赖未全部 done（done 集合仅取**本次行数组内** status==='done' 者，且依赖须在本行集内出现）。
 */
export function markTaskBlocked(rows) {
    const doneIds = new Set(rows.filter((t) => t.status === "done").map((t) => t.id));
    rows.forEach((t) => { t.blocked = t.status === "pending" && t.deps.some((d) => !doneIds.has(d) && rows.some((x) => x.id === d)); });
}

/**
 * 七态分桶装配（与原 REST 返回体同形）。
 * @returns {{total:number} & Record<string, Array>}  { total, pending, in_progress, blocked, done, cancelled, merged, archived }
 */
export function bucketizeTaskRows(rows) {
    const buckets = {};
    TASK_BUCKETS.forEach((b) => { buckets[b] = []; });
    for (const t of rows) {
        if (buckets[t.status])
            buckets[t.status].push(t);
    }
    return { total: rows.length, ...buckets };
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 2026-10-15（架构重构第 2 条「统一操作注册表」· 批次 B）：MCP `task_next` 的领域计算。
 *
 *   逐字自 server-reg-task.js 的 `task_next.execute` 搬出（**逻辑一字不改**），拆成两半：
 *     · nextTasks(ctx, args)          → 结构化领域值（可做集 / 本人在办 / 待决策 分段，含依赖拓扑入度、
 *                                       状态归一、卡片优先级、派发提示、租约、会话隔离、死端标记、跨 project 提示）；
 *     · renderTaskNextText(structured)→ 中文文案（**一个字符都不改**：空格 / 换行 / `#` / `†` / `…` / 括号 / 顺序）。
 *   这样领域逻辑只留一份，MCP 侧（server-reg-task.js）只做薄适配：invokeOp → renderTaskNextText。
 *
 *   ★ ctx 契约（身份必须在**调用时**解析，严禁注册期冻成常量 —— 那是 1b 刚修掉的坑）：
 *     { db, agentName, readTaskState, taskBody }
 *     · agentName —— accessor（函数），在 nextTasks 内部按调用时刻取值（决定 who 分支）；
 *     · readTaskState / taskBody —— 任务头解析器（server-reg-task.js 内的共享 helper，经 ctx 注入，
 *       **不在本模块复制一份**，避免"同名两份解析逻辑"重新长回来）。
 *
 *   ★ 与 REST 看板语义（parseTaskRows）**不是同一套**（6 处实质差异见文件头），故各自独立、不合并。
 * ══════════════════════════════════════════════════════════════════════ */
export function nextTasks(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const readTaskState = ctx.readTaskState;
    const taskBody = ctx.taskBody;
    const rows = db.prepare(`SELECT id, content, agent, source_ref, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY julianday(created_at) DESC, id DESC LIMIT 500`).all(args.project);
    // ★ 2026-09-19（弊端 M5）：按创建时间降序（新任务优先）+ 超上限显式提示——原升序在积压超 500 条时把新任务埋没
    const totalOpen = db.prepare(`SELECT COUNT(*) n FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'`).get(args.project).n;
    // 全体任务状态/依赖解码 + done 集合
    const states = new Map();
    const invalid = []; // ★ C2：头格式异常的任务显式入列（原静默跳过——agent 看不到 = 任务静默消失，问题 #7）
    for (const r of rows) {
        const st = readTaskState(r.content);
        if (!st) {
            invalid.push({ id: r.id, head: headLineOf(r.content).slice(0, 80) });
            continue;
        }
        states.set(r.id, { st });
    }
    // ★ 2026-09-19（实操复盘查漏）：依赖判定不能只看 active/trial 行 —— 实测 31 条「头 done 但列已归档」
    //   的任务不在上面查询结果里，依赖它们的 pending 任务被永久误判阻塞（生产库实证 6 条假阻塞）。
    //   done 判据改为「头文本 done，不看列」；列 merged 的行不播种（由 winner 状态裁决），
    //   依赖指向 merged 的沿 superseded_by 传递解析到 winner（带环保护）。
    const allTasks = db.prepare(`SELECT id, content, status, superseded_by FROM memories WHERE type='task' AND sensitivity != 'secret'`).all();
    const mergeTo = new Map();
    for (const t of allTasks) {
        if (t.status === "merged" && t.superseded_by != null)
            mergeTo.set(Number(t.id), Number(t.superseded_by));
    }
    const resolveTaskId = (id, seen = new Set()) => {
        let cur = Number(id);
        while (mergeTo.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = mergeTo.get(cur);
        }
        return cur;
    };
    const doneIds = new Set();
    for (const t of allTasks) {
        const st = readTaskState(t.content);
        if (st?.status === "done" && t.status !== "merged")
            doneIds.add(resolveTaskId(t.id));
    }
    const depDoneOf = (deps) => deps.every((d) => doneIds.has(resolveTaskId(d)));
    // ★ 2026-09-19（弊端 M6）：依赖死端检测——依赖处于终态（cancelled/archived）或不存在时永远等不到 done，
    //   标注出来让调用方重挂依赖，而不是永久挂起
    const taskById = new Map(allTasks.map((t) => [Number(t.id), t]));
    const depDeadOf = (d) => {
        const t = taskById.get(resolveTaskId(d));
        if (!t)
            return true;
        const stt = readTaskState(t.content)?.status;
        return String(t.status) === "archived" || stt === "cancelled" || stt === "archived";
    };
    const who = !args.as || args.as === "any" ? agentName() : args.as;
    // ★ 2026-09-19（实操问题 #7）：同 agent 多会话隔离 —— 取最近 task_claim 事件的 session_id，
    //   与调用方 session_id 比对：非本会话 → 单列「同名其他会话」，消除「我在做」串台。
    const claimSessionOf = (mid) => {
        try {
            const ev = db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_claim' ORDER BY id DESC LIMIT 1`).get(mid);
            return ev ? (JSON.parse(ev.payload).session_id ?? null) : null;
        }
        catch { return null; }
    };
    const mineOther = [];
    // ★ 2026-09-19（实操问题 #12）：task_next 信息增强 —— mine 附租约剩余（julianday 差值，UTC 安全），
    //   blocked 附最后活动时间（memory_events 最晚一条），减少「要另开接口/直读库才知道」的绕行。
    const leaseTagOf = (mid) => {
        try {
            const r = db.prepare(`SELECT (julianday(lease_expires_at) - julianday('now')) * 1440 AS m FROM cards WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).get(mid);
            if (!r || r.m == null)
                return " [无租约]";
            return r.m <= 0 ? " [租约已过期，待回收]" : ` [租约剩 ${Math.round(r.m)}min]`;
        }
        catch { return ""; }
    };
    const lastEvtOf = (mid) => {
        try {
            const r = db.prepare(`SELECT julianday('now') - MAX(julianday(created_at)) AS d FROM memory_events WHERE memory_id=?`).get(mid);
            if (!r || r.d == null)
                return "";
            return r.d >= 1 ? ` · 最后活动 ${Math.floor(r.d)} 天前` : ` · 最后活动 ${Math.max(1, Math.round(r.d * 24))} 小时前`;
        }
        catch { return ""; }
    };
    const avail = [];
    const blocked = [];
    const mine = [];
    // ★ A 2026-09-14：区分卡任务 vs 手动任务；B：优先取卡片 priority 排序
    const isCardTask = (r) => String(r.source_ref ?? "").startsWith("card:");
    // ★ P15（开关默认关）：source_ref 取不到时（task_assign 直派任务），经 dispatch 链接回退——
    //   默认关时 cardOf 恒走 source_ref 单路，与改前逐字节一致。
    const dspMap = prioViaDispatchOn() ? dispatchCardMap(db, rows.map((r) => r.id)) : new Map();
    const cardOf = (r) => {
        const m = String(r.source_ref ?? "").match(/^card:(\d+)$/);
        if (m)
            return Number(m[1]);
        return dspMap.get(Number(r.id)) ?? null;
    };
    // 一次性拉取所涉卡片的 priority
    const cardIds = [...new Set(rows.map(cardOf).filter((n) => n !== null))];
    const cardPrio = new Map();
    if (cardIds.length) {
        const ph = cardIds.map(() => "?").join(",");
        db.prepare(`SELECT id, priority FROM cards WHERE id IN (${ph})`).all(...cardIds).forEach((r) => cardPrio.set(r.id, Number(r.priority ?? 0)));
    }
    const srcTag = (r) => {
        if (isCardTask(r))
            return `[卡片#${cardOf(r)}]`;
        return "[agent任务]";
    };
    const prioOf = (r) => {
        const cid = cardOf(r);
        return cid !== null ? (cardPrio.get(cid) ?? 0) : 0;
    };
    const tsOf = (r) => Date.parse(r.created_at) || 0;
    for (const r of rows) {
        const s = states.get(r.id)?.st;
        if (!s)
            continue;
        const depDone = depDoneOf(s.deps);
        const blockedBy = s.deps.filter((d) => !doneIds.has(resolveTaskId(d)));
        const depLabel = blockedBy.map((dd) => "#" + dd + (depDeadOf(dd) ? "†" : "")).join(", ");
        if (s.status === "pending") {
            if (!args.as || args.as === "any" || s.assignee === who || s.assignee === "?") {
                if (depDone)
                    avail.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} → ${s.assignee}: ${taskBody(r.content).slice(0, 80)} ${isCardTask(r) ? "(卡)" : ""}` });
                else
                    blocked.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} 阻塞（等 ${depLabel}）→ ${taskBody(r.content).slice(0, 60)}${lastEvtOf(r.id)}${blockedBy.some(depDeadOf) ? "（†=依赖已终态/不存在：需重挂依赖才能解锁）" : ""}` });
            }
        }
        else if (s.status === "in_progress" && s.assignee === who) {
            const label = `#${r.id} ${srcTag(r)} 进行中(已认领 by ${s.assignee}): ${taskBody(r.content).slice(0, 80)}`;
            const sid = claimSessionOf(r.id);
            const isThisSession = !args.session_id || !sid || sid === args.session_id;
            const leaseTag = leaseTagOf(r.id); // ★ #12：租约剩余一目了然
            (isThisSession ? mine : mineOther).push(isThisSession ? label + leaseTag : `${label}${leaseTag}（会话 ${sid}）`);
        }
    }
    // ★ B 排序：卡片 priority 高优先，同优先级按创建时间旧的在前
    const sortLane = (a, b) => b.prio - a.prio || a.key - b.key;
    avail.sort(sortLane);
    blocked.sort(sortLane);
    // ★ 2026-10-03（批次 A2）：待决策段 —— 把「租约到期仍挂着 / 已贴条待回收」的活显式列出。
    //   对标 Orca J2：到期与沉默只是检查点，不授权回收；但必须让人看得见，否则无人裁决 = 永久积压。
    const fmtDur = (min) => {
        const m = Math.max(0, Number(min) || 0);
        if (m < 60)
            return `${Math.round(m)} 分钟`;
        if (m < 1440)
            return `${Math.round(m / 60)} 小时`;
        return `${Math.round(m / 1440)} 天`;
    };
    const pendMap = new Map(); // memoryId（卡无关联任务时退化为 card:<id>）→ { who, tags[] }
    try {
        const overdue = db.prepare(`SELECT memory_id, agent, (julianday('now') - julianday(lease_expires_at)) * 1440 AS m
           FROM dispatches WHERE state='active' AND julianday(lease_expires_at) < julianday('now')
           ORDER BY lease_expires_at ASC LIMIT 50`).all();
        for (const o of overdue) {
            const mid = Number(o.memory_id);
            const e = pendMap.get(mid) ?? { who: o.agent, tags: [] };
            e.tags.push(`工作证过期 ${fmtDur(o.m)}`);
            pendMap.set(mid, e);
        }
        // ★ 批次 B1（2026-10-03）：stale 工作证（reaper 已标「待裁决」）显式进「待处理」——
        //   不再自动回收后，这是人/agent 发现积压卡的**唯一入口**；据此决定 heartbeat 复活 / takeover 接管 / release 归还。
        const staleDsp = db.prepare(`SELECT memory_id, agent, generation FROM dispatches WHERE state='stale' ORDER BY id ASC LIMIT 50`).all();
        for (const s of staleDsp) {
            const mid = Number(s.memory_id);
            const e = pendMap.get(mid) ?? { who: s.agent, tags: [] };
            e.tags.push(`工作证已置 stale（gen=${s.generation}，待裁决：heartbeat 复活 / takeover 接管 / release 归还）`);
            pendMap.set(mid, e);
        }
    }
    catch { /* 待决策段失败不影响主清单 */ }
    try {
        const graceH = Math.max(0, Number(process.env.MEMORYOS_LEASE_GRACE_HOURS ?? 24));
        const noticed = db.prepare(`SELECT id AS card_id, assignee, (julianday('now') - julianday(lease_notice_at)) * 24 AS h
           FROM cards WHERE status='running' AND lease_notice_at IS NOT NULL
           ORDER BY lease_notice_at ASC LIMIT 50`).all();
        for (const n of noticed) {
            let mid = null;
            try {
                const rel = db.prepare(`SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(Number(n.card_id));
                mid = rel ? Number(rel.memory_id) : null;
            }
            catch { mid = null; }
            const key = mid ?? `card:${n.card_id}`;
            const e = pendMap.get(key) ?? { who: n.assignee, tags: [] };
            e.tags.push(`已贴提醒条 ${fmtDur(Number(n.h) * 60)}（超 ${graceH} 小时转「待裁决」，不再自动回收）`);
            pendMap.set(key, e);
        }
    }
    catch { /* 同上：卡片侧查询失败不阻断 */ }
    const pendingDecisions = [];
    for (const [key, e] of pendMap) {
        if (typeof key === "number") {
            const row = taskById.get(key);
            const body = row ? ` ${taskBody(row.content).slice(0, 50)}` : "";
            pendingDecisions.push(`#${key} ${e.who ?? "?"} · ${e.tags.join(" · ")}${lastEvtOf(key)}${body}`);
        }
        else
            pendingDecisions.push(`卡片 #${String(key).slice(5)} ${e.who ?? "?"} · ${e.tags.join(" · ")}`);
    }
    // ★ 2026-09-15：跨 project 回退提示 —— 指定 project 无开放任务且确实存在其他 project 的任务时，
    //   明确提示而非静默空结果（避免『任务存在但领不到』）。
    //   （原实现把这段拼在文案末尾；此处归为**领域计算**：它要查库，只把结果串交给渲染层）
    let crossProjectHint = "";
    if (avail.length === 0 && args.project !== "global") {
        try {
            const other = db.prepare(`SELECT project, COUNT(*) c FROM memories WHERE type='task' AND status IN ('active','trial') AND project != 'global' AND project != ? AND sensitivity != 'secret' GROUP BY project`).all(args.project);
            if (other.length) {
                crossProjectHint = `\n\n跨 project 提示：当前 project='${args.project}' 无可用任务。其他 project 有开放任务 ${other.map((o) => `${o.project}(${o.c})`).join("、")}，可用 project 参数切换查询。`;
            }
        }
        catch {
            /* 统计失败不回退原返回 */
        }
    }
    return {
        who,
        avail: avail.map((x) => x.label),
        blocked: blocked.map((x) => x.label),
        mine,
        mineOther,
        pendingDecisions,
        invalid, // ★ C2：格式异常段（空集时渲染层不输出，零漂移）
        crossProjectHint,
        totalOpen,
        rowsShown: rows.length,
    };
}

/**
 * 把 nextTasks 的结构化领域值渲染成 MCP 文案（**逐字自原 execute 末尾搬移，一个字符都不改**）。
 * @param {{who:string, avail:string[], blocked:string[], mine:string[], mineOther:string[],
 *          pendingDecisions:string[], crossProjectHint:string, totalOpen:number, rowsShown:number}} s
 * @returns {string}
 */
export function renderTaskNextText(s) {
    let out = `【task_next · as=${s.who}】\n`;
    out += `可做（pending 且依赖done，按优先级）:\n${s.avail.length ? s.avail.join("\n") : "（暂无，检查阻塞项）"}\n\n`;
    out += `阻塞（依赖未完成）:\n${s.blocked.length ? s.blocked.join("\n") : "（无）"}\n\n`;
    out += `我在做:\n${s.mine.length ? s.mine.join("\n") : "（无进行中任务）"}`;
    if (s.mineOther.length)
        out += `\n\n同名其他会话进行中（非本会话，勿动）:\n${s.mineOther.join("\n")}`;
    // ★ 2026-10-03（批次 A2）：待决策栏输出 —— 空集也显式写「（无）」，避免「查不到」与「确实没有」混淆。
    out += `\n\n待处理（需要拿主意）:\n${s.pendingDecisions.length ? s.pendingDecisions.join("\n") : "（无）"}`;
    // ★ C2：格式异常段（空集不输出——治「任务静默消失」同时零文本漂移）
    if (s.invalid?.length)
        out += `\n\n格式异常（任务头无法解析，工具/地图均不可见，需修 content 首行头）:\n${s.invalid.map((x) => `#${x.id} ${x.head}`).join("\n")}`;
    if (s.crossProjectHint)
        out += s.crossProjectHint;
    // ★ 2026-09-19（弊端 M5）：超上限显式提示——任务数超过 500 条窗口时旧部分不显示
    if (s.totalOpen > s.rowsShown)
        out += "\n（上限提示：共 " + s.totalOpen + " 条任务，仅显示最近 " + s.rowsShown + " 条）";
    return out;
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 2026-10-15（批次 B）：REST `POST /api/task`（看板人工建任务）的领域逻辑。
 *   逐字自 dashboard-reg-memory.js 该路由搬出（**入参校验后的 content 拼装 + embedding + 写库**），
 *   RESTRICTED 门禁与「标题非空」400 校验留在**传输层**（属 HTTP 协议行为，不属领域）。
 *   返回值 = 裸领域结果 `{ ok:true, id, status, assignee, deps }`（与改前响应体逐字节一致）。
 *   ctx 契约：{ db, writeMemory, logUsage, logDaemon, getEmbedder }（embed 经 ctx 注入，
 *   使本模块**不**依赖 embed.js/ML 层 —— 避免把 543MB ONNX 运行时拖进 MCP 工具面）。
 * ══════════════════════════════════════════════════════════════════════ */
export async function createTaskMemory(ctx, args = {}) {
    const { db, writeMemory, logUsage, logDaemon, getEmbedder } = ctx;
    const b = args ?? {};
    const title = String(b.title ?? "").trim();
    const statusRaw = String(b.status ?? "pending").trim();
    const status = TASK_BUCKETS.includes(statusRaw) ? statusRaw : "pending";
    const assignee = String(b.assignee ?? "").trim() || "unassigned";
    const deps = Array.isArray(b.depends)
        ? b.depends.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
    const summary = String(b.summary ?? "").trim();
    const depTag = deps.length ? `[depends:${deps.join(",")}]` : "";
    const content = `[task][assignee:${assignee}][status:${status}]${depTag} ${title}${summary ? "\n\n" + summary : ""}`;
    let embedding = null;
    try {
        const [v] = await (await getEmbedder()).embedTexts([content]);
        embedding = v ?? null;
    }
    catch {
        embedding = null; // 嵌入暂不可用 → 建任务照常
    }
    const row = writeMemory(db, {
        content,
        type: "task",
        agent: "human:dashboard",
        agent_fpath: null,
        project: String(b.project ?? "global").trim() || "global",
        embedding,
        confidence: 0.8,
    });
    logUsage(db, { memory_id: row.id, event: "write", reader_agent: "human:dashboard", writer_agent: "human:dashboard", project: row.project });
    logDaemon(db, {
        task: "manual-task",
        op: "create",
        memory_id: row.id,
        operator: "human:dashboard",
        detail: `看板新建任务 #${row.id}（${status} · ${assignee}）：${title.slice(0, 60)}`,
    });
    return { ok: true, id: row.id, status, assignee, deps };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ★ Step 0（2026-10-18）：MCP task_* 写工具的**领域核心** —— 自 server-reg-task.js 注册闭包**逐字搬出**。
 *
 * 动机：写逻辑此前窝在传输层闭包里，探针无法调用真实代码（只能复述行号），也违反本仓
 *   「传输层零领域逻辑」纪律。搬出后：MCP 传输层只留 zod 入参 + 幂等包装 + addTool 注册 +
 *   文案组装入口；领域函数可被探针/其他传输直接调用。
 *
 * ctx 契约（调用方注入，**调用时解析**，严禁注册期冻成常量——1b 刚修掉的坑）：
 *   {
 *     db,                    // DatabaseSync
 *     agentName, agentFpath, // 调用方身份 accessor（server-tools.js · AsyncLocalStorage）
 *     envCredential,         // MCP 配置注入的本 agent 凭据 accessor
 *     isCredentialValid,     // A1 凭据校验（server-tools.js）
 *     nowIso,                // ISO 时间
 *     requestAbortSignal,    // 请求取消信号（direct 模式恒 null）
 *     killTree,              // exec-tools.js：验收子进程被取消时杀进程树
 *   }
 *
 * 纪律：① 回执文案（含 ⟨state⟩ 终态行）属领域回执，逐字节不变——冒烟 smoke-mcp / smoke-p26 断言即契约；
 *   ② 与 REST 看板语义（parseTaskRows 等）仍**不是同一套**（6 处差异见文件头），各自独立不合并；
 *   ③ 慢活（runTaskGate 子进程）绝不进事务；卡片投影 best-effort（失败留痕不阻断）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** ★ E-0 裁决落码：持久状态集合（review/failed 已取消，存量经 TASK_NORMALIZE 归一；archived 为记忆轴终态） */
export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled", "merged", "archived"];
/** 合法迁移白名单：源状态 → 允许的目标状态；终态不可直接转回，重开走 task_reopen（reopened 语义留痕） */
export const TASK_TRANSITIONS = {
    pending: ["in_progress", "cancelled"],
    in_progress: ["blocked", "done", "cancelled"],
    blocked: ["in_progress", "cancelled"],
    done: [],
    cancelled: [],
    merged: [],
    archived: [],
};
/** 校验迁移合法性，非法返回错误提示；空/可写由调用方决定 */
export function assertTransition(from, to) {
    const allowed = TASK_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
        return `非法状态迁移 ${from} → ${to}（白名单: ${allowed.join(", ") || "终态不可迁移"}）`;
    }
    return null;
}
/** ★ 2026-09-19（实操问题 #6）：assignee 白名单 —— 小写 kebab；"?" 为未指派哨兵放行 */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export function assertAssignee(name) {
    if (name === undefined || name === null || name === "" || name === "?")
        return null;
    if (typeof name !== "string" || !AGENT_NAME_RE.test(name))
        return `assignee「${name}」不合规：须为小写字母开头的 kebab 标识（[a-z][a-z0-9_-]{0,31}，如 codex/trae/zcode/workbuddy）；"?" 表示未指派。`;
    return null;
}
/** ★ 2026-09-18（实操问题 #1，P0）：按 id 分支的列守卫。readMemory 是裸 WHERE id=?（无 status 过滤），
 *  实测 29 条任务「头 pending 但列已 archived/merged」——列表分支有列过滤挡住，按 id 分支只看头文本会放行。 */
export function assertTaskAlive(row) {
    if (!["active", "trial"].includes(String(row.status ?? ""))) {
        return `#${row.id} 列状态为 ${row.status}（${row.status === "merged" ? "已被其他任务取代" : "已归档"}），不可按 id 操作；请用 task_next 取当前可做集。`;
    }
    return null;
}
/** content 头正则：兼容七态 + 存量三态（open/claimed/done）。
 *  ⚠ 与 REST 侧 dashboard-task-util.js 的 TASK_HEAD_RE **同名不同义**（枚举态集合不同）——故此处加 _MCP 后缀防混用。 */
const TASK_HEAD_RE_MCP = /^\[task\]\[assignee:[^\]]*\]\[status:([a-z_]+)\]/;
export function taskHead(status, assignee) {
    return `[task][assignee:${assignee}][status:${status}]`;
}
/** ★ 2026-09-19（弊端 H4/H5）：头字段（status/assignee/depends/gate）只解析头行——正文里引用的标记视为普通正文 */
export function headLineOf(content) {
    const s = String(content ?? "");
    const i = s.indexOf("\n");
    return i < 0 ? s : s.slice(0, i);
}
export function readTaskState(content) {
    const m = String(content ?? "").match(TASK_HEAD_RE_MCP);
    if (!m)
        return null;
    const hl = headLineOf(content);
    const am = hl.match(/\[assignee:([^\]]*)\]/);
    const dm = hl.match(TASK_DEP_RE);
    const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
    return { assignee: am ? am[1] : "?", status: TASK_NORMALIZE[m[1]] || m[1], deps };
}
/** 拆掉状态头和头行依赖段的纯正文（正文中引用的 [depends:] 属正文，不剥） */
export function taskBody(content) {
    return String(content ?? "").replace(TASK_HEAD_RE_MCP, "").replace(/^\s*\[depends:[^\]]*\]/, "").trim();
}
/** 构造正文时保留依赖段 */
export function taskBodyWithDep(status, assignee, deps, body) {
    const depStr = deps.length ? ` [depends:${deps.join(",")}]` : "";
    return `${taskHead(status, assignee)}${depStr} ${body}`;
}
/** ★ 2026-09-19（弊端 H4，纵深一层）：写入任务正文的自由文本（结论/原因）中性化其可能引用的状态标记 */
export function sanitizeTaskText(t) {
    return String(t ?? "").replace(/\[(status|depends|gate|assignee):/g, "〔$1:");
}
/** ★ A1 身份与认证层：写工具统一入口。带凭据 → 严格校验（归属 + 未撤销未过期 + scope>=write）；
 *  不带凭据 → 软模式放行（事件留痕 cred_id=null），MEMORYOS_A1_ENFORCE=1 时硬拒绝（fail-closed）。 */
export function checkWriteCredential(ctx, who, credential) {
    const db = ctx.db;
    const HARD = process.env.MEMORYOS_A1_ENFORCE === "1";
    const cred = credential || ctx.envCredential();
    if (!cred) {
        if (HARD)
            return { ok: false, credId: null, msg: `A1 硬模式（MEMORYOS_A1_ENFORCE=1）：${who} 必须携带 scope>=write 的凭据——先 memory_credential(action=issue, scope=write) 签发后随 credential 入参携带，或在 MCP 配置注入 MEMORYOS_A1_CREDENTIAL 环境变量（node dist/a1-bootstrap.js 一键签发）。` };
        return { ok: true, credId: null, msg: "" };
    }
    const row = db.prepare(`SELECT id, agent, scope, expires_at, revoked_at FROM agent_credentials WHERE credential=?`).get(String(cred));
    if (!row || row.agent !== who)
        return { ok: false, credId: null, msg: `A1 拒绝：凭据不属于 ${who} 或不存在（不接受他人凭据改写任务归属）。` };
    if (!ctx.isCredentialValid(row))
        return { ok: false, credId: row.id, msg: `A1 拒绝：凭据已${row.revoked_at ? "撤销" : "过期"}（id=${row.id}）；请 memory_credential(action=issue) 重新签发。` };
    if (row.scope === "read")
        return { ok: false, credId: row.id, msg: `A1 拒绝：凭据 scope=read 不足，改写任务需 scope>=write（id=${row.id}）。` };
    return { ok: true, credId: row.id, msg: "" };
}
/** ★ 2026-10-03 批次 A1（Dispatch 语义·**软模式**）：六处写入点的权威提示 —— 只告警不拒绝。
 *  判据与 task_done 硬校验同源：① key 可解析；② memory_id 相符；③ state='active'；④ agent 相符。 */
export function softDispatchNotice(ctx, memoryId, dispatchKey, who) {
    const db = ctx.db;
    const active = readActiveDispatch(db, memoryId);
    if (!dispatchKey) {
        return active
            ? `\ndispatch 提示（软模式）：任务 #${memoryId} 已有 active dispatch（${String(active.dispatch_key).slice(0, 12)}…，持有者 ${active.agent}，gen=${active.generation}），本次未携带 dispatch_key —— 已放行；接管/换代后建议携带以证明权威。`
            : `\ndispatch 提示（软模式）：任务 #${memoryId} 当前无 active dispatch（未经 task_claim 认领），本次未携带 dispatch_key —— 已放行。`;
    }
    const d = readDispatchByKey(db, dispatchKey);
    if (!d)
        return `\ndispatch 提示（软模式）：dispatch_key=${String(dispatchKey).slice(0, 12)}… 不存在，本次已放行。`;
    if (Number(d.memory_id) !== Number(memoryId))
        return `\ndispatch 提示（软模式）：该 dispatch 归属任务 #${d.memory_id} ≠ #${memoryId}（跨任务），本次已放行。`;
    if (d.state !== "active")
        return `\ndispatch 提示（软模式）：该 dispatch 已 ${d.state}（你已被取代或已结算）——权威只来自 active dispatch，本次已放行。`;
    if (d.agent !== who)
        return `\ndispatch 提示（软模式）：该 dispatch 由 ${d.agent} 持有，本次调用方为 ${who}，本次已放行。`;
    return "";
}
/** ★ 2026-10-03 批次 A3（fenced 位）：被取代者从心跳回执**主动**得知（对标 Orca fencing），
 *  避免「旧持有者继续写」的孤儿写入。A3 行优先于 A1 提示（语义重叠只播一次）。 */
export function fencedLine(ctx, memoryId, dispatchKey, who) {
    const db = ctx.db;
    const active = readActiveDispatch(db, memoryId);
    let mine = dispatchKey ? readDispatchByKey(db, dispatchKey) : null;
    if (!mine) {
        try {
            mine = db.prepare(`SELECT * FROM dispatches WHERE memory_id=? AND agent=? ORDER BY generation DESC LIMIT 1`).get(Number(memoryId), String(who)) ?? null;
        }
        catch {
            mine = null;
        }
    }
    if (!mine)
        return "";
    const fenced = String(mine.state) === "superseded" || (active != null && Number(active.id) !== Number(mine.id));
    if (!fenced)
        return `\nfenced=false：你的 dispatch（gen=${mine.generation}）仍为当前权威。`;
    return `\nfenced=true：你持有的 dispatch（gen=${mine.generation}）已被取代 —— 当前权威为 ${active ? `${String(active.dispatch_key).slice(0, 12)}… / gen=${active.generation} / ${active.agent}` : "无（已结算或释放）"}；请停止对该任务的写入，重新 task_next / task_claim 后再继续。`;
}
/** P3 确定性门控预设（融合架构「不信任 Agent 报告，由确定性代码验证」）：argv 全部字面量常量，
 *  固定 node 解释器 + 参数数组、shell:false，请求值仅做枚举匹配，绝不参与命令构造（Mimosa 命令注入防御）。 */
export const GATE_PRESETS = {
    "lint-sql": { label: "lint-sql", argv: ["dist/lint-sql-arity.js"] },
    "lint-catch": { label: "lint-catch", argv: ["dist/lint-silent-catch.js"] },
    "smoke-mcp": { label: "smoke-mcp", argv: ["dist/smoke-mcp.js"] },
    "smoke-task": { label: "smoke-task", argv: ["dist/smoke-task.js"] },
    "smoke-p26": { label: "smoke-p26", argv: ["dist/smoke-p26-lifecycle.js"] },
    "snapshot": { label: "snapshot --check", argv: ["dist/snapshot-routes.js", "--check"] },
};
export function taskGateName(content) {
    // ★ 弊端 H4：gate 标记只认头行——正文里引用的 [gate:预设] 不再触发验收（与 headLineOf 同源）
    const m = headLineOf(content).match(/\[gate:([a-z0-9-]+)\]/);
    return m ? m[1] : null;
}
/** 验收命令的确定性 cwd：resources/memoryos 目录（smoke 类脚本用 process.cwd() 拼相对路径）；
 *  env MEMORYOS_WORKSPACE 仅在显式注入时覆盖。 */
function _gateRoot() {
    const envRoot = (process.env.MEMORYOS_WORKSPACE || "").trim();
    if (envRoot)
        return envRoot;
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
/** ★ 2026-09-25 P0①：async（异步 execFile）——同步等待会把事件循环冻死（验收最长 180s）。
 *  ★ 1b：请求中断（核心侧 req close）→ killTree 杀掉验收子进程，不留孤儿。 */
export async function runTaskGate(ctx, gate, memoryId) {
    const db = ctx.db;
    const preset = GATE_PRESETS[gate];
    if (!preset) {
        const detail = `预设 '${gate}' 未定义（可选：${Object.keys(GATE_PRESETS).join(" / ")}）——fail-closed 不执行`;
        try { logExecAudit(db, { tool: "task_gate", risk: "L0", approval: "gate-reject", agent: ctx.agentName(), memory_id: memoryId, argsDigest: gate, detail, ok: false }); } catch { }
        return { ok: false, executed: false, detail };
    }
    const root = _gateRoot();
    let r;
    const sig = ctx.requestAbortSignal();
    let child = null;
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        if (child)
            ctx.killTree(child);
    };
    if (sig) {
        if (sig.aborted)
            onAbort();
        else
            sig.addEventListener("abort", onAbort, { once: true });
    }
    try {
        r = { status: 0, ...(await new Promise((resolve, reject) => {
            child = execFile("node", preset.argv, { shell: false, cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    reject(err);
                }
                else
                    resolve({ stdout, stderr });
            });
            if (sig && sig.aborted)
                onAbort();
        })) };
    }
    catch (e) {
        r = {
            status: typeof e?.code === "number" ? e.code : null,
            stdout: e?.stdout ?? "",
            stderr: e?.stderr ?? (e?.message ?? String(e)),
        };
    }
    finally {
        if (sig) { try { sig.removeEventListener("abort", onAbort); } catch { /* 忽略 */ } }
    }
    const ok = r.status === 0 && !aborted;
    const detail = aborted
        ? `验收被取消（MCP 请求中断）：已终止验收子进程（${preset.label}）`
        : `${preset.label} exit=${r.status} ${String(r.stdout || r.stderr || "").trim().slice(0, 200)}`;
    try { logExecAudit(db, { tool: "task_gate", risk: "L0", approval: aborted ? "request-aborted" : "gate-auto", agent: ctx.agentName(), memory_id: memoryId, argsDigest: gate, detail, ok }); } catch { }
    return { ok, executed: !aborted, detail };
}
/** P2-6（C-2/#4198）：任务记忆 → 派发卡片（card_memory dispatch 关系）。无卡返回 null。 */
export function cardOfTask(db, memoryId) {
    try {
        const rel = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1`).get(memoryId);
        if (!rel)
            return null;
        return db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(rel.card_id)) ?? null;
    }
    catch {
        return null;
    }
}
/** ★ ③-A（2026-09-24）：任务记忆 → 全部 dispatch 卡（多卡全集合；租约/fencing/门控/清锁链全走它） */
export function cardsOfTask(db, memoryId) {
    try {
        const rels = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch'`).all(memoryId);
        const out = [];
        for (const rel of rels) {
            const card = db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(rel.card_id));
            if (card)
                out.push(card);
        }
        return out;
    }
    catch {
        return [];
    }
}
/** P2-6（C-2）：卡片租约触达（认领时发 lease token；heartbeat 续窗）——默认 10 分钟，#13 可分级 10..120。
 *  ★ ③-A：全集合 running 卡逐张触达；⑦：续期即撕贴条；B1：心跳=正面存活证明，一并撤裁决标记。 */
export function touchCardLease(db, memoryId, lock, minutes = 10) {
    let n = 0;
    try {
        const min = Math.max(10, Math.min(120, Math.floor(Number(minutes) || 10)));
        for (const c of cardsOfTask(db, memoryId)) {
            if (c.status !== "running")
                continue;
            db.prepare(`UPDATE cards SET claim_lock=?, lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now', ?), heartbeat_at=datetime('now'), lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(lock, `+${min} minutes`, c.id);
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, "dispatcher", lock ? "lease_set" : "heartbeat", "running", "running", lock ? `MCP 租约锁定（${min}min，lock=${String(lock).slice(0, 8)}…）` : `MCP 心跳续窗（${min}min）`);
            n++;
        }
    }
    catch (e) {
        console.error(`[lease] 卡片租约触达失败（任务 #${memoryId}）：${e instanceof Error ? e.message : String(e)}`);
    }
    return n > 0;
}
/** ★ 2026-09-15 根治「智能体领取/上传与看板不一致」：任务状态变更 → 关联卡片同步。
 *  反向于 cards-domain.js 的 syncCardToTask()。⚠ 投影语义：卡片状态是任务头的投影（C-5 卡向头对齐），
 *  故 UPDATE 不走 cards 的 CARD_TRANSITIONS 白名单，属设计内差异而非绕过。
 *  ★ B1 前置（Step 0）：opts.source 标注写入方（'agent'|'human'|'reconciler'|'dispatcher'），
 *    随事件 detail 落痕——单写入口 applyTransition 的 source 优先级治理由此起步（行为当前不变）。 */
export function syncTaskToCard(db, memoryId, cardStatus, opts = {}) {
    try {
        // ★ 弊端 U2：同步本任务的全部 dispatch 卡（多卡时逐一，原 LIMIT 1 会让多余的卡永久失同步）
        const rels = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch'`).all(memoryId);
        if (!rels.length)
            return false;
        let synced = 0;
        for (const rel of rels) {
            const cid = Number(rel.card_id);
            const card = db.prepare(`SELECT status, meta FROM cards WHERE id=?`).get(cid);
            if (!card)
                continue;
            // ★ B1（P2 · 开关 MEMORYOS_REVIEW_GUARD=1，默认关）：agent 的 done 同步不得覆盖 review 卡
            //   （人工验收/待验收）——doneTaskDomain 守卫分支之后的竞态兜底（check→sync 之间人工拖入
            //   review）；非 agent 源（dispatcher/reconcile）不受此限（reconcile 本就不碰 review）。
            if (reviewGuardOn() && cardStatus === "done" && opts.source === "agent" && card.status === "review")
                continue;
            // ★ 方案A守卫：只收敛开放态卡；cardStatus='done' 额外允许 review（验收后收口）；
            //   failed/cancelled/archived 等终态不覆盖（原 WHERE id=? 盲写会把验收/租约流转撕坏）。
            // ★ 跨区补全：源卡 running 是「已认领」而非终态——漏列会把 block/流转的收敛整段跳过。
            const allowed = cardStatus === "done" ? new Set(["triage", "todo", "ready", "blocked", "running", "review"]) : new Set(["triage", "todo", "ready", "running", "blocked"]);
            if (!allowed.has(card.status))
                continue;
            // ★ opts.assignee 三态 —— undefined=保持原值 / null=清空 / 字符串=设为该值
            const setAssignee = opts.assignee === undefined ? "" : ", assignee=?";
            const upd = db.prepare(`UPDATE cards SET status=?${setAssignee}, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
            if (opts.assignee === undefined)
                upd.run(cardStatus, cid);
            else
                upd.run(cardStatus, opts.assignee, cid);
            if (cardStatus === "done") {
                db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cid);
                if (gateBreakerOn()) // ★ B3（P2 · 开关默认关）：成功收口清零门控失败计数（计数的"洗白"点之一；
                    db.prepare(`UPDATE cards SET gate_fail_count=0 WHERE id=?`).run(cid); //   人工介入清零见 cards-domain transitionCard/acceptCard）
            }
            const srcTag = opts.source ? `[source:${opts.source}]` : "";
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cid, opts.actor ?? "dispatcher", opts.action ?? "mcp_sync", card.status, cardStatus, `${srcTag}${opts.detail ?? `任务 #${memoryId} MCP 流转同步`}`);
            synced++;
        }
        return synced > 0;
    }
    catch (e) {
        // 原为静默 catch { return false }——状态同步失败会完全隐身（外观与"卡本来就对"相同）。仅加一行日志。
        console.error(`[syncTaskToCard] 卡侧同步失败（记忆 #${memoryId} → ${cardStatus}）：${e.message}`);
        return false;
    }
}

/* ── 领域执行体（原 server-reg-task.js 各 addTool 的 execute 逐字搬入） ───────────────────
 * 传输层职责收敛为：zod 入参声明 + 幂等包装 + 以下领域函数的薄调用。
 * 返回串 = 领域回执（含 ⟨state⟩ 终态行）——冒烟对文案的逐字节断言即契约，改动即违约。 */

/* ── ★ C1（2026-10-18 · P0）：依赖校验开关 + 依赖满足判据 ─────────────────────────────
 * 病灶（§0.3 实证）：头 [depends:] 只在 task_next 展示层过滤，MCP claim by id / REST claim /
 *   assign 建卡即 ready 三条路径全部绕过；两套依赖（头 vs 卡片 links）互不知晓。
 * 收敛方案（开关 MEMORYOS_DEP_VALIDATE=1，默认关=行为逐字节不变）：
 *   ① assignTaskDomain：depends_on 存在性校验（拒不存在/已终态 id）+ 带头依赖时建卡落 todo
 *      并写卡片依赖边（与 daemon ④ 提升 / dispatch-agent 预检同一套 links 判据）；
 *   ② claimTaskDomain：认领前依赖闸门（takeover 逃生路径豁免）；
 *   ③ cards-domain.js::claimCard：卡级 pendingDepends 闸门（与 dispatch-agent 同口径）。
 * ⚠ nextTasks 为 500 行窗口性能把 allTasks 一次性 hoist 出循环；本函数单次全表扫（认领低频可接受）。
 *   两处判据（done 集合按头文本 / merged 传递解析 / 死端定义）**改动必须同步**。 */
export function depValidateOn() {
    return process.env.MEMORYOS_DEP_VALIDATE === "1";
}
/** ★ B3（2026-10-18 · P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：gate 连续失败熔断。
 *  病灶（问题 #6）：gate 失败卡回 ready（fail-closed 可重试），而熔断判据是
 *  status='failed' AND failure_count>=2——计数涨了条件永远不满足，缺陷任务被反复领取。
 *  本开关打开后：① doneTaskDomain 门控失败路径给任务全部 dispatch 卡 gate_fail_count+1；
 *  ② daemon/web 两侧 housekeep 扩展判据 ready AND gate_fail_count>=2 → blocked；
 *  ③ 清零点=成功收口（syncTaskToCard done / transitionCard done|human / acceptCard）——
 *    **agent 重领不清零**：每次重试都经 claim，若 claim 清零则计数永远到不了 2、
 *    熔断器永不可达（与 #6 目标自相矛盾），故对"claim 时清零"的原始决策作此偏离，
 *    理由与实证见报告 §3-B3 与探针 P14d。
 *  config.json（gateBreaker）→ env 的回填在进程入口三处（dashboard/server/daemon）。 */
export function gateBreakerOn() {
    return process.env.MEMORYOS_GATE_BREAKER === "1";
}
/** ★ P15（2026-10-18 · 开关 MEMORYOS_PRIO_VIA_DISPATCH=1，默认关）：task_next/pick 的卡片 priority
 *  排序对 task_assign 直派任务回退取数。病灶（存量缺口，探针 P12a 首实证）：task_assign 建卡双写
 *  card_memory(dispatch) 但**不写** source_ref——而 priority 查找只认 source_ref 正则 → 直派任务的
 *  卡片 priority 对排序完全失效。**不补写 source_ref**：其语义=「卡派生任务」，兼管 search 排除规则
 *  （search.js:544-546 09-14 决策：卡片派发任务不进检索，而 agent 手动 task_assign **刻意保留**在
 *  检索当经验片）——补写会把 agent 任务挤出检索，违背该决策。故只修查找路径：开关开时经权威任务→卡
 *  链接（card_memory relation='dispatch'，syncTaskToCard/cardsOfTask 同源）回退取数。 */
export function prioViaDispatchOn() {
    return process.env.MEMORYOS_PRIO_VIA_DISPATCH === "1";
}
/** ★ B1（2026-10-18 · P2 · 开关 MEMORYOS_REVIEW_GUARD=1，默认关）：agent 收口不得覆盖 review 卡。
 *  病灶（问题 #3，实证比"互相 409"更尖锐——是**单向覆盖**）：人工把卡拖到/流转到 review（=发起验收，
 *  用户拍板的语义）后，agent 的 task_done 经 syncTaskToCard 的 done 允许集（含 review）把卡强收为
 *  done，而 reconcile 不碰 review → 无任何纠正机制，人的验收被静默作废。
 *  修法（与 B2 同一回执语义，评审③定序"B2 先于 B1"的落实）：命中 review 卡时**不标记头 done**——
 *  头保持 in_progress + 结论留痕 + 回执「已提交，等待验收」，人工 /accept 后经 syncCardToTask 收口；
 *  syncTaskToCard 侧对 source=agent 的 done 同步跳过 review 卡（关 check→sync 间竞态的兜底）。
 *  默认关时原成功路径逐字节不动（缺陷复现见探针 P16c）。 */
export function reviewGuardOn() {
    return process.env.MEMORYOS_REVIEW_GUARD === "1";
}
/** 任务→卡 的权威链接映射（memory_id → card_id，一任务多卡取首行）。仅供 priority 回退取数。 */
function dispatchCardMap(db, memoryIds) {
    const out = new Map();
    const ids = memoryIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length)
        return out;
    const ph = ids.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT memory_id, card_id FROM card_memory WHERE relation='dispatch' AND memory_id IN (${ph})`).all(...ids)) {
        const mid = Number(r.memory_id);
        if (!out.has(mid))
            out.set(mid, Number(r.card_id));
    }
    return out;
}
/** ★ P1 开关族（均默认关=行为逐字节不变；调用时解析，与既有 MEMORY_RESTRICTED 同口径） */
export function taskSettleOn() { return process.env.MEMORYOS_TASK_SETTLE === "1"; }
export function atomicClaimOn() { return process.env.MEMORYOS_ATOMIC_CLAIM === "1"; }
export function doneAutoreviewOn() { return process.env.MEMORYOS_DONE_AUTOREVIEW === "1"; }
/** 依赖满足判定：done 集合按**头文本**判定（不看列），merged 沿 superseded_by 传递解析到 winner（带环保护）；
 *  死端（不存在 / 列 archived / 头 cancelled|archived）单独列出（调用方标 †）。
 *  allTasks 可预取（pick=next 批量选取时一次性传入，避免 N×全表扫）——判据与预取与否无关。 */
export function depsStateOf(db, deps, allTasks = null) {
    const all = allTasks ?? db.prepare(`SELECT id, content, status, superseded_by FROM memories WHERE type='task' AND sensitivity != 'secret'`).all();
    const mergeTo = new Map();
    for (const t of all) {
        if (t.status === "merged" && t.superseded_by != null)
            mergeTo.set(Number(t.id), Number(t.superseded_by));
    }
    const resolveTaskId = (id, seen = new Set()) => {
        let cur = Number(id);
        while (mergeTo.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = mergeTo.get(cur);
        }
        return cur;
    };
    const doneIds = new Set();
    for (const t of all) {
        const st = readTaskState(t.content);
        if (st?.status === "done" && t.status !== "merged")
            doneIds.add(resolveTaskId(t.id));
    }
    const taskById = new Map(all.map((t) => [Number(t.id), t]));
    const pending = [];
    const dead = [];
    for (const d of deps) {
        const rid = resolveTaskId(d);
        if (doneIds.has(rid))
            continue;
        const t = taskById.get(rid);
        if (!t) {
            dead.push(Number(d));
            continue;
        }
        const stt = readTaskState(t.content)?.status;
        if (String(t.status) === "archived" || stt === "cancelled" || stt === "archived") {
            dead.push(Number(d));
            continue;
        }
        pending.push(Number(d));
    }
    return { satisfied: pending.length === 0 && dead.length === 0, pending, dead };
}
/** depends 字符串 → 正整数 id 数组（与 assign 入参过滤同口径） */
function parseDepIds(deps) {
    return String(deps ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
}

/** task_gate：查看任务 [gate:预设] 验收声明与结果 */
export function gateToolDomain(ctx, args = {}) {
    const db = ctx.db;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常。`;
    const gate = taskGateName(row.content);
    if (!gate)
        return `#${args.memory_id} 未声明验收门（任务头无 [gate:预设]）。task_done 不做确定性验收。白名单预设：${Object.keys(GATE_PRESETS).join(" / ")}`;
    const last = db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_gate' ORDER BY id DESC LIMIT 1`).get(row.id);
    let lastRes = null;
    try { lastRes = last ? JSON.parse(last.payload) : null; } catch { }
    return `#${args.memory_id} 验收门 = [gate:${gate}]（预设：${Object.keys(GATE_PRESETS).join(" / ")}）\n当前状态=${st.status}${lastRes ? `\n最近验收：${lastRes.ok ? "PASS" : "FAIL"}（${String(lastRes.detail ?? "").slice(0, 120)}）` : "\n尚无验收记录（task_done 时自动执行）。"}`;
}

/** task_assign：把任务交给指定 Agent（depends_on 拓扑；同步建卡） */
export function assignTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const agentFpath = ctx.agentFpath;
    const asgErr = assertAssignee(args.assignee);
    if (asgErr)
        return asgErr;
    const body = args.content.trim();
    const deps = (args.depends_on ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .join(",");
    // ★ C1（开关 MEMORYOS_DEP_VALIDATE=1，默认关）：depends_on 存在性校验——
    //   拒不存在/已终态 id（幽灵依赖/死端入库曾无任何校验，实证 P3d）。pending 依赖合法（等着即可）。
    if (depValidateOn() && deps) {
        const ds = depsStateOf(db, parseDepIds(deps));
        if (ds.dead.length)
            return `depends_on 校验拒绝：${ds.dead.map((d) => `#${d}（不存在或已终态，永远等不到 done）`).join("、")}——请修正后重试（当前 MEMORYOS_DEP_VALIDATE=1 校验中）。`;
    }
    const full = deps
        ? `${taskHead("pending", args.assignee)} [depends:${deps}] ${body}`
        : `${taskHead("pending", args.assignee)} ${body}`;
    // ★ 一致性①：记忆 + 事件 + 建卡 + 用量记账包成一笔事务——中途失败整体回滚，不出半笔账
    //   （建卡仍 best-effort：失败留文案，对账补卡兜底）。
    let row = null;
    let cardInfo = "";
    const asgAbort = runTaskTx(db, () => {
        row = writeMemory(db, {
            content: full,
            type: "task",
            agent: agentName(),
            agent_fpath: agentFpath(),
            project: args.project,
        });
        appendEvent(db, {
            memory_id: row.id,
            op: "task_assign",
            payload: JSON.stringify({ from: agentName(), to: args.assignee, project: args.project, depends: deps || null }),
            operator: `agent:${agentName()}`,
        });
        // ★ 2026-09-15：task_assign 同步建卡（默认开），避免任务地图无卡可领；
        //   复用 from-memory 的 ref 关联：ref_kind='memory', ref_id=task 记忆 id → 卡片状态流转可经此回写 memories。
        if (args.create_card !== false) {
            try {
                const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(row.id);
                const title = body.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim().slice(0, 120) || `任务 #${row.id}`;
                // ★ C1（开关默认关）：带头依赖时建卡落 todo + 写卡片依赖边——与 daemon ④（todo→ready 依赖提升）/
                //   dispatch-agent（pendingDepends 预检）同一套 links 判据，两套依赖系统自此收敛（§0.3）。
                const depOn = depValidateOn() && !!deps;
                const cardStatus = depOn ? "todo" : "ready";
                const cardId = dup
                    ? dup.id
                    : Number(db
                        .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,?,?,'memory',?,?,?)`)
                        .run(title, body.slice(0, 2000), cardStatus, row.id, 3, args.assignee).lastInsertRowid);
                db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
                if (depOn && !dup) {
                    // 依赖边 dst 须为**卡 id**：经 dep 任务的 dispatch 卡反查；无卡的依赖只靠 MCP 头侧闸门（已知边界）
                    for (const d of parseDepIds(deps)) {
                        const depCard = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1`).get(d);
                        if (depCard)
                            db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind) VALUES (NULL,'card',?,'card',?,'depends')`).run(cardId, Number(depCard.card_id));
                    }
                }
                cardInfo = ` + 地图卡 #${cardId}`;
            }
            catch (e) {
                console.error(`[task_assign] 建卡失败（任务 #${row.id}）: ${e instanceof Error ? e.message : String(e)}`);
                cardInfo = `（建卡失败：${e instanceof Error ? e.message : String(e)}）`;
            }
        }
        logUsage(db, {
            memory_id: row.id, event: "write", reader_agent: agentName(), writer_agent: agentName(),
            project: row.project, session_id: args.session_id, task_hint: args.task_hint,
        });
    });
    if (asgAbort)
        return asgAbort;
    return `已分派任务 #${row.id} → ${args.assignee}（status=pending）${cardInfo}[${row.type}|${row.agent}] ${row.content.replace(/\s+/g, " ").slice(0, 120)}`;
}

/** task_delegate：A2A 对等委派（复用 task_assign 的任务头/建卡/审计；目标无有效凭据 fail-closed 拒绝） */
export function delegateTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const agentFpath = ctx.agentFpath;
    const nowIso = ctx.nowIso;
    const caller = (args.from || agentName()).trim();
    // A1 认证层联动：目标 agent 必须持有有效（未撤销且未过期）凭据，否则 fail-closed 拒绝
    if (args.require_credential !== false) {
        const rows = db.prepare(`SELECT id FROM agent_credentials WHERE agent=? AND revoked_at IS NULL AND expires_at > ?`).all(args.to, nowIso());
        if (!rows.length)
            return `A2A 委派拒绝（fail-closed）：目标 agent=${args.to} 无有效凭据。请先 memory_credential(action=issue, agent=${args.to}) 签发短生命周期凭据，再委派。`;
    }
    const gate = args.gate && GATE_PRESETS[args.gate] ? args.gate : null;
    const body = `[a2a:${caller}→${args.to}]${gate ? ` [gate:${gate}]` : ""} ${args.content.trim()}`;
    const full = `${taskHead("pending", args.to)} ${body}`;
    let row = null;
    let cardInfo = "";
    const dlgAbort = runTaskTx(db, () => {
        row = writeMemory(db, {
            content: full,
            type: "task",
            agent: caller,
            agent_fpath: agentFpath(),
            project: args.project,
        });
        appendEvent(db, {
            memory_id: row.id,
            op: "task_delegate",
            payload: JSON.stringify({ from: caller, to: args.to, gate, protocol: "a2a", project: args.project }),
            operator: `agent:${caller}`,
        });
        try {
            const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(row.id);
            const title = `A2A ${caller}→${args.to}: ${args.content.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim().slice(0, 90)}`;
            const cardId = dup
                ? dup.id
                : Number(db
                    .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,'A2A 委派','ready','memory',?,?,?)`)
                    .run(title, row.id, 3, args.to).lastInsertRowid);
            db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
            cardInfo = ` + 地图卡 #${cardId}`;
        }
        catch (e) {
            console.error(`[task_delegate] 建卡失败（任务 #${row.id}）: ${e instanceof Error ? e.message : String(e)}`);
            cardInfo = `（建卡失败：${e instanceof Error ? e.message : String(e)}）`;
        }
        logUsage(db, {
            memory_id: row.id, event: "write", reader_agent: caller, writer_agent: caller,
            project: row.project, session_id: args.session_id, task_hint: args.task_hint,
        });
    });
    if (dlgAbort)
        return dlgAbort;
    return `A2A 已委派任务 #${row.id}：${caller} → ${args.to}${gate ? `（验收门 [gate:${gate}]，task_done 时确定性验收）` : ""}（status=pending）${cardInfo}`;
}

/** task_claim：领取 pending 任务（租约 10 分钟可延长；as=any 托管；takeover 接管须凭据） */
export function claimTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    if (args.memory_id) {
        const row = readMemory(db, args.memory_id);
        if (!row || row.type !== "task")
            return `#${args.memory_id} 不存在或非任务。`;
        const aliveErr = assertTaskAlive(row);
        if (aliveErr)
            return aliveErr;
        const st = readTaskState(row.content);
        if (!st)
            return `#${args.memory_id} 任务头格式异常，无法认领。`;
        // ★ 批次 B1（G2 裁决心跳）：接管路径——仅当调用方显式 takeover:true 且该任务当前**无 active dispatch**
        //   （被 reaper 标 stale，或已 release）时放行。依据 orca「absence never authorizes destruction」：
        //   缺席只标 stale，接力必须由新调度的**正向动作**完成；本分支即该正向入口。
        const takeover = args.takeover === true && st.status === "in_progress";
        if (st.status !== "pending" && !takeover)
            return `#${args.memory_id} 当前 status=${st.status}，仅 pending 可认领。` + (st.status === "in_progress" ? `若原认领者已失联（其工作证已 stale），可传 takeover=true 显式接管。` : "");
        if (takeover) {
            const act = readActiveDispatch(db, row.id);
            if (act)
                return `#${args.memory_id} 仍有 active dispatch（${String(act.dispatch_key).slice(0, 12)}… / ${act.agent} / gen=${act.generation}）——不得接管：原持有者权威仍有效。请等待其结算，或由本人 task_release 显式归还。`;
            const staleDsp = db.prepare(`SELECT id FROM dispatches WHERE memory_id=? AND state='stale'`).get(row.id);
            if (!staleDsp)
                return `#${args.memory_id} 无 stale dispatch 记录 —— 该任务不处于「待裁决」态，takeover 不适用（未认领走普通认领；已终态走 task_admin(action=reopen)）。`;
        }
        // ★ P2-6（C-2）fencing：乐观版本 + 租约锁——拒绝陈旧领取 / 僵尸领取
        // ★ ③-A：锁检查改全集合（存在锁且任一张锁不符才拒）
        const claimLocks = cardsOfTask(db, row.id).filter((cc) => cc.claim_lock);
        const claimMismatch = claimLocks.find((cc) => cc.claim_lock !== args.lease_token);
        if (args.lease_token && claimLocks.length && claimMismatch)
            return `#${args.memory_id} 租约已被他人接管（卡片 #${claimMismatch.id} 现锁 ${String(claimMismatch.claim_lock).slice(0, 8)}…），本次领取拒绝（fencing）；请重新 task_next 后再领。`;
        if (args.expected_version != null && args.expected_version !== row.version)
            return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：任务已被其他操作改写，本次领取拒绝；请刷新后再领。`;
        const who = args.as && args.as !== "any" && args.as !== agentName() ? args.as : agentName();
        const asgErr = assertAssignee(who);
        if (asgErr)
            return asgErr;
        const cred = checkWriteCredential(ctx, who, args.credential);
        if (!cred.ok)
            return cred.msg;
        // ★ 弊端 H2：as="any" 托管认领会改写归属——默认软模式无凭据放行是治理漏洞；
        //   as="any" 必须携带 scope>=write 凭据（硬模式口径天然满足；本人认领保持软模式兼容）。
        if (args.as === "any" && !args.credential)
            return `as="any" 托管认领会改写任务归属：请先 memory_credential(action=issue, scope=write) 签发凭据并随 credential 入参携带；若以本人身份认领则不传 as。`;
        if (takeover && !args.credential)
            return `takeover 接管会改写任务归属：请先 memory_credential(action=issue, scope=write) 签发凭据并随 credential 入参携带。`;
        if (args.as !== "any" && !takeover && st.assignee !== "?" && st.assignee !== who) {
            return `#${args.memory_id} 指派给 ${st.assignee}，你不是接收方（可传 as=any 强制托管认领）。`;
        }
        // ★ C1（开关默认关）：认领前依赖闸门——头 [depends:] 未满足即拒（与 task_next 可做集同判据）。
        //   takeover 逃生路径豁免：恢复卡死的任务不应被依赖二次卡住。
        if (depValidateOn() && !takeover && st.deps.length) {
            const ds = depsStateOf(db, st.deps);
            if (!ds.satisfied) {
                const pend = ds.pending.map((d) => `#${d}`).join(", ");
                const dead = ds.dead.map((d) => `#${d}†`).join(", ");
                return `#${args.memory_id} 依赖未满足（${pend}${dead ? `；死端 ${dead}（不存在/已终态，需重挂依赖）` : ""}）——按拓扑应等待其 done 后再认领（task_next 可做集同口径；当前 MEMORYOS_DEP_VALIDATE=1）。`;
            }
        }
        const newContent = taskBodyWithDep("in_progress", who, st.deps, taskBody(row.content));
        // ★ 并发竞态修复：CAS 认领——content 写 + version 递增原子化（WHERE version=?），
        //   两会话并发认领同一任务必有一个拿 null 拒绝，不再后写覆盖前写的 assignee/租约。
        // ★ 一致性①：CAS + 事件 + 卡投影 + 租约四笔写入包成一笔事务——中途失败整体回滚；
        //   锁竞争由 withTx 整段重试，事务回滚后 version 未变，「请刷新后重试」提示从此真实有效。
        let lock = null;
        let dsp = null;
        const claimAbort = runTaskTx(db, () => {
            const claimed = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
            if (!claimed)
                throw new TxAbort(`#${row.id} 并发认领冲突（版本已漂移 v${row.version}）：任务刚被其他会话领取或改写；请 task_next 刷新后重试。`);
            // ★ 2026-10-02：同一枚 token 同时是 dispatch_key——从「查不出持有者的锁」变为可查询/可换代/可取代的尝试句柄。
            //   形态保持纯 hex：既有冒烟断言 / 卡片 CAS 锁 / agent 侧解析均按 [0-9a-f]+ 提取，加前缀会被截断。
            lock = randomBytes(12).toString("hex");
            dsp = createDispatch(db, { key: lock, memoryId: row.id, agent: who, sessionId: args.session_id ?? null, credentialId: cred.credId, leaseMinutes: args.lease_minutes });
            appendEvent(db, { memory_id: row.id, op: takeover ? "task_takeover" : "task_claim", payload: JSON.stringify({ by: who, as_any: args.as === "any" || undefined, takeover: takeover || undefined, prev_assignee: takeover ? (st.assignee ?? null) : undefined, lease_token: lock, dispatch_id: dsp?.id, generation: dsp?.generation, superseded: dsp?.superseded ?? undefined, version: row.version + 1, session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
            syncTaskToCard(db, row.id, "running", { assignee: who, actor: `agent:${who}`, action: takeover ? "takeover" : "claim", source: "agent", detail: takeover ? `MCP 接管（agent ${who} ← ${st.assignee ?? "?"}，待裁决换代）` : `MCP 认领（agent ${who}）` });
            touchCardLease(db, row.id, lock, args.lease_minutes);
        });
        if (claimAbort)
            return claimAbort;
        return `已${takeover ? "接管（换代）" : "认领"}任务 #${row.id}（status=in_progress by ${who}）lease_token=${lock}（即 dispatch_key，task_done 时携带）：${newContent.replace(/\s+/g, " ").slice(0, 120)}` + stateReceipt({ op: takeover ? "task_takeover" : "task_claim", id: row.id, status: "in_progress", version: row.version + 1, assignee: who, lease_token: lock, dispatch_key: lock, dispatch_id: dsp?.id, generation: dsp?.generation, superseded: dsp?.superseded ?? undefined, cred_id: cred.credId, session_id: args.session_id ?? null });
    }
    // ★ A3（P1 · 原子认领）：pick="next" —— 选取 + 认领一次调用完成，消除 task_next→task_claim 两步窗口
    //   （窗口内 LLM 延迟可达数秒，多 agent 下输家白跑）。选取判据与 task_next 可做集**同源**
    //   （pending + 归属匹配 + 依赖满足；卡片 priority DESC、创建时间 ASC）；选定后**复用本函数
    //   memory_id 分支的完整校验链**（状态/归属/凭据/依赖闸门/CAS）——零重复零漂移，CAS 保证不双认领。
    //   开关 MEMORYOS_ATOMIC_CLAIM=1（默认关：传 pick 也走原列表路径并提示，行为不变）。
    if (!args.memory_id && args.pick === "next") {
        if (!atomicClaimOn())
            return `pick="next" 需要 MEMORYOS_ATOMIC_CLAIM=1（当前未开）——不传 pick 时行为不变。`;
        const who = args.as && args.as !== "any" && args.as !== agentName() ? args.as : agentName();
        const allTasks = db.prepare(`SELECT id, content, status, superseded_by FROM memories WHERE type='task' AND sensitivity != 'secret'`).all();
        const rows = db.prepare(`SELECT id, content, agent, source_ref, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY julianday(created_at) DESC, id DESC LIMIT 500`).all(args.project);
        // 卡片 priority 一次性批量取（同 nextTasks 口径；★ P15 开关开时对直派任务回退 dispatch 链接）
        const dspMap = prioViaDispatchOn() ? dispatchCardMap(db, rows.map((r) => r.id)) : new Map();
        const cardOfRow = (r) => {
            const m = String(r.source_ref ?? "").match(/^card:(\d+)$/);
            return m ? Number(m[1]) : (dspMap.get(Number(r.id)) ?? null);
        };
        const cardIds = [...new Set(rows.map(cardOfRow).filter((n) => n !== null))];
        const cardPrio = new Map();
        if (cardIds.length) {
            const ph = cardIds.map(() => "?").join(",");
            db.prepare(`SELECT id, priority FROM cards WHERE id IN (${ph})`).all(...cardIds).forEach((r) => cardPrio.set(r.id, Number(r.priority ?? 0)));
        }
        const cands = [];
        for (const r of rows) {
            const s = readTaskState(r.content);
            if (!s || s.status !== "pending")
                continue;
            if (!(args.as === "any" || !args.as || s.assignee === who || s.assignee === "?"))
                continue;
            if (!depsStateOf(db, s.deps, allTasks).satisfied)
                continue;
            const cid = cardOfRow(r); // ★ P15：source_ref 优先，开关开时回退 dispatch 链接
            cands.push({ id: r.id, prio: cid !== null ? (cardPrio.get(cid) ?? 0) : 0, ts: Date.parse(r.created_at) || 0 });
        }
        if (!cands.length)
            return `当前无可认领的 pending 任务（pick=next 选取范围：project='${args.project}' + global，判据同 task_next 可做集）。`;
        cands.sort((a, b) => b.prio - a.prio || a.ts - b.ts);
        // 依次尝试前 3 候选（选取与认领间仍有毫秒级竞态；CAS 失败即换下一个，全部落空则回最后一条文案）
        let last = "";
        for (const c of cands.slice(0, 3)) {
            last = claimTaskDomain(ctx, { ...args, pick: undefined, memory_id: c.id });
            if (last.includes("已认领任务") || last.includes("已接管"))
                return last;
        }
        return last;
    }
    // 列可领任务：type='task' 且状态头 pending（★ H4：secret 任务不进工具通道）
    const rows = db.prepare(`SELECT id, content, agent, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY created_at DESC LIMIT ?`).all(args.project, 50);
    const open = rows.filter((r) => readTaskState(r.content)?.status === "pending");
    if (!open.length) {
        // ★ 2026-09-15：跨 project 回退提示（与 task_next 同口径）
        let hint = "";
        if (args.project !== "global") {
            try {
                const other = db.prepare(`SELECT project, COUNT(*) c FROM memories WHERE type='task' AND status IN ('active','trial') AND project != 'global' AND project != ? AND sensitivity != 'secret' GROUP BY project`).all(args.project);
                if (other.length)
                    hint = `；其他 project 有开放任务 ${other.map((o) => `${o.project}(${o.c})`).join("、")}，可切换 project 查询`;
            } catch { /* 统计失败忽略 */ }
        }
        return `当前无可领的 pending 任务${hint}。`;
    }
    return open.map((r) => `#${r.id} [${readTaskState(r.content)?.assignee}] ${r.content.slice(30, 160)}`).join("\n");
}

/** ★ A1（P1 · task_settle）：凭 ticket 的结算/归还——治 #2「干完活交不了差」。
 *  上下文压缩丢 dispatch_key/lease_token/expected_version 后，agent 无法证明自己的认领；
 *  本工具让服务端反查票据完成收尾，**不需要 agent 记住任何令牌**。
 *  归属纪律（评审②）：只接受 dispatch_key，或 memory_id + session_id（必须命中该任务**当前 active 代**
 *  且 session 相符）——裸 memory_id 谁都能传=围栏失效，拒；已 superseded/settled 的代=僵尸会话，拒。
 *  效果：dispatch 结算/释放 + 任务头回 pending（CAS）+ 全集合卡回 ready 清锁 + 可选交接注记（结论留痕，
 *  活已干成但无法走 task_done 时把成果交给下一位，防「重试放弃或乱试」）。
 *  开关 MEMORYOS_TASK_SETTLE=1（默认关：工具不注册，工具面逐字节不变）。 */
export function settleTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    let dsp = null;
    if (args.dispatch_key) {
        dsp = readDispatchByKey(db, args.dispatch_key);
        if (!dsp)
            return `dispatch_key=${String(args.dispatch_key).slice(0, 12)}… 不存在——请确认票据来源（task_claim 回执的 lease_token/dispatch_key）。`;
        if (dsp.state !== "active")
            return `该 dispatch 已 ${dsp.state}（gen=${dsp.generation}）——权威只来自 active dispatch；已被取代/结算的票据不可再结算（防僵尸会话写）。`;
        if (args.session_id && dsp.session_id && dsp.session_id !== args.session_id)
            return `该 dispatch 属于会话 ${dsp.session_id}，与本次 session_id 不符——拒绝跨会话结算（同名 agent 多会话防串号）。`;
        if (dsp.agent !== agentName())
            return `该 dispatch 由 ${dsp.agent} 持有，你（${agentName()}）不是持有者——拒绝结算。`;
    }
    else {
        if (!args.memory_id || !args.session_id)
            return `task_settle 需要 dispatch_key，或 memory_id + session_id（二者齐备才能定位 active 代）——裸 memory_id 不接受（谁都能传 = 围栏失效）。`;
        const row0 = readMemory(db, args.memory_id);
        if (!row0 || row0.type !== "task")
            return `#${args.memory_id} 不存在或非任务。`;
        dsp = readActiveDispatch(db, args.memory_id);
        if (!dsp)
            return `任务 #${args.memory_id} 当前无 active dispatch——无需结算（未经认领、已释放或已结算）。`;
        if (dsp.session_id !== args.session_id)
            return `任务 #${args.memory_id} 的 active dispatch 属于会话 ${dsp.session_id ?? "?"}（${dsp.agent}），与本次 session_id 不符——拒绝跨会话结算（防同名 agent 多会话串号）。`;
        if (dsp.agent !== agentName())
            return `该 dispatch 由 ${dsp.agent} 持有，你（${agentName()}）不是持有者——拒绝结算。`;
    }
    const memoryId = Number(dsp.memory_id);
    const row = readMemory(db, memoryId);
    if (!row || row.type !== "task")
        return `#${memoryId} 不存在或非任务。`;
    const st = readTaskState(row.content);
    if (!st)
        return `#${memoryId} 任务头格式异常，无法结算。`;
    const conclusion = String(args.conclusion ?? "").trim();
    const failed = args.outcome === "failed";
    const settleAbort = runTaskTx(db, () => {
        const body = conclusion
            ? `${taskBody(row.content)}\n→ 交接(${agentName()})：${sanitizeTaskText(conclusion)}`
            : taskBody(row.content);
        const released = updateMemory(db, memoryId, { content: taskBodyWithDep("pending", st.assignee, st.deps, body), expectedVersion: row.version });
        if (!released)
            throw new TxAbort(`#${memoryId} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
        // 带交接注记 = 活已干成（succeeded + 证据）；无注记 = 未完工归还（release 语义）——两种原语不混用
        if (conclusion)
            settleDispatch(db, dsp.id, "succeeded", `task_settle by ${agentName()}：${conclusion.slice(0, 200)}`);
        else
            releaseDispatch(db, dsp.id, `task_settle by ${agentName()}${failed ? "（自报 failed）" : ""}`);
        appendEvent(db, { memory_id: memoryId, op: "task_settle", payload: JSON.stringify({ by: agentName(), dispatch_id: dsp.id, generation: dsp.generation, session_id: args.session_id ?? null, handoff: conclusion || null, outcome: conclusion ? "succeeded" : (failed ? "failed" : "released") }), operator: `agent:${agentName()}` });
        try {
            for (const c2 of cardsOfTask(db, memoryId)) { // ★ ③-A：全集合归还（review 卡一并回 ready——B2 转入待验收后也可凭 ticket 反悔）
                if (c2.status !== "running" && c2.status !== "review")
                    continue;
                db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(c2.id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${agentName()}`, "mcp_settle", c2.status, "ready", `任务 #${memoryId} ticket 结算归还`);
            }
        }
        catch (e) { console.error(`[task_settle] 卡片侧更新失败（记忆侧已归还）：${e.message}`); }
    });
    if (settleAbort)
        return settleAbort;
    return `任务 #${memoryId} 已凭 ticket 结算并归还（status=pending，重新可领；dispatch gen=${dsp.generation} 已${conclusion ? " succeeded 结算（交接注记已留痕）" : failed ? " failed 结算" : "释放"}）` + stateReceipt({ op: "task_settle", id: memoryId, status: "pending", version: row.version + 1, dispatch_id: dsp.id, generation: dsp.generation, outcome: conclusion ? "succeeded" : (failed ? "failed" : "released") });
}

/** task_heartbeat：刷新在办任务租约（无关联卡时仅记事件） */
export function heartbeatTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const st = readTaskState(row.content);
    if (!st || st.status !== "in_progress")
        return `#${args.memory_id} 当前非进行中，无需续租。`;
    const who = args.as && args.as !== "any" ? args.as : agentName();
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, who);
    const fence = fencedLine(ctx, row.id, args.dispatch_key, who);
    const tail = fence || dspNotice; // ★ A3：fenced 行优先，语义重叠只播报一次
    if (st.assignee !== "?" && st.assignee !== who)
        return `#${args.memory_id} 认领者为 ${st.assignee}，${who} 无权续租。`;
    const card = cardOfTask(db, row.id);
    if (!card) {
        appendEvent(db, { memory_id: row.id, op: "task_heartbeat", payload: JSON.stringify({ by: who, cards: [] }), operator: `agent:${agentName()}` });
        return `任务 #${row.id} 续租成功（无关联卡片，纯任务，仅记事件）。` + tail;
    }
    const hMin = Math.max(10, Math.min(120, Math.floor(Number(args.lease_minutes) || 10)));
    const hRunning = cardsOfTask(db, row.id).filter((cc) => cc.status === "running");
    if (hRunning.length) {
        // ★ 一致性①：续租 + 事件一笔事务（两步写不再可能半途分裂）
        runTaskTx(db, () => {
            touchCardLease(db, row.id, null, args.lease_minutes);
            appendEvent(db, { memory_id: row.id, op: "task_heartbeat", payload: JSON.stringify({ by: who, cards: hRunning.map((cc) => cc.id), window_min: hMin }), operator: `agent:${agentName()}` });
        });
        return `任务 #${row.id} 续租成功（全集合 ${hRunning.length} 张 running 卡，租约窗口 → ${hMin} 分钟）。` + tail;
    }
    const hFirst = card;
    return `任务 #${row.id} 续租未生效：卡片 #${hFirst.id} 当前 status=${hFirst.status}${hFirst.claim_lock ? "（他方持有租约）" : ""}。` + tail;
}

/** task_release：释放认领（in_progress→pending 清锁；仅当前认领者或 human 兜底） */
export function releaseTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st || st.status !== "in_progress")
        return `#${args.memory_id} 当前 status=${st?.status}，仅进行中任务可释放。`;
    // ★ 一致性①：头 CAS + 事件 + 卡释放包成一笔事务——此前卡侧失败会出现
    //   「记忆头已释放、卡仍 running 持锁」的半笔账；现崩溃/锁失败窗口整体回滚，头与卡不再各走各的。
    let newContent = null;
    const relAbort = runTaskTx(db, () => {
        newContent = taskBodyWithDep("pending", st.assignee, st.deps, taskBody(row.content));
        const released = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
        if (!released)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_release", payload: JSON.stringify({ by: agentName(), reason: (args.reason ?? "").trim() || null, session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
        try {
            for (const c2 of cardsOfTask(db, row.id)) { // ★ ③-A：全集合释放（多卡任务第 2..n 张一并回 ready 清锁）
                if (c2.status !== "running")
                    continue;
                const rel = db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(c2.id);
                if (Number(rel.changes) === 0) console.error(`[task_release] ⚠ 卡片 #${c2.id} 未更新（changes=0），三方可能不一致`);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${agentName()}`, "mcp_release", "running", "ready", `任务 #${row.id} 释放（${(args.reason ?? "").trim() || "未注明"}）`);
            }
        }
        catch (e) { console.error(`[task_release] 卡片侧更新失败（记忆侧已释放）：${e.message}`); }
    });
    if (relAbort)
        return relAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${row.id} 已释放（status=pending，重新可领）：${newContent.replace(/\s+/g, " ").slice(0, 100)}` + stateReceipt({ op: "task_release", id: row.id, status: "pending", version: row.version + 1, cred_id: cred.credId }) + dspNotice;
}

/** task_block：把任务标记受阻（blocked 不进可做集；原因必须留痕） */
export function blockTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法标记受阻。`;
    const tErr = assertTransition(st.status, "blocked");
    if (tErr)
        return `#${args.memory_id} ${tErr}`;
    // ★ 一致性①：头 CAS + 事件 + 卡投影一笔事务
    const blkAbort = runTaskTx(db, () => {
        const body = `${taskBody(row.content)}\n⛔ 受阻(${agentName()})：${sanitizeTaskText(args.reason).trim()}`;
        const blocked = updateMemory(db, row.id, { content: taskBodyWithDep("blocked", st.assignee, st.deps, body), expectedVersion: row.version });
        if (!blocked)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_block", payload: JSON.stringify({ by: agentName(), reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
        syncTaskToCard(db, row.id, "blocked", { actor: `agent:${agentName()}`, source: "agent", detail: `任务 #${row.id} MCP 标记受阻` });
    });
    if (blkAbort)
        return blkAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${row.id} 已标记受阻（status=blocked）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_block", id: row.id, status: "blocked", version: row.version + 1, cred_id: cred.credId }) + dspNotice;
}

/** task_reopen：重开终态任务（done/cancelled→in_progress 重新指派） */
export function reopenTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    if (row.status === "merged")
        return `#${args.memory_id} 已被 #${row.superseded_by ?? "?"} 取代（merged），不可重开；如需该工作请操作取代它的主任务。`;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法重开。`;
    if (!["done", "cancelled"].includes(st.status)) // E-0：failed 已取消（存量归一 in_progress），merged 已在上方单独拒绝
        return `#${args.memory_id} 当前 status=${st.status}，仅终态（done/cancelled）可重开。`;
    // ★ 一致性①：列复活 + 头 CAS + 事件 + 卡重开一笔事务——CAS 中止即整体回滚，不再「列已复活、头没重开」错位
    const who = args.assignee || st.assignee || "?";
    const whoErr = assertAssignee(who);
    if (whoErr)
        return whoErr;
    const ropenAbort = runTaskTx(db, () => {
        if (row.status === "archived") // 重开即复活——否则重开后头/列错位、任务依旧不可见
            db.prepare(`UPDATE memories SET status='active' WHERE id=?`).run(row.id);
        const body = `${taskBody(row.content)}\n↻ 重开(${agentName()})：${sanitizeTaskText(args.reason).trim()}`;
        const reopened = updateMemory(db, row.id, { content: taskBodyWithDep("in_progress", who, st.deps, body), expectedVersion: row.version });
        if (!reopened)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_reopen", payload: JSON.stringify({ by: agentName(), from: st.status, to: who, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
        try {
            for (const c2 of cardsOfTask(db, row.id)) { // ★ ③-A：全集合重开（第 2..n 张一并回 ready，不留旧锁）
                if (!["done", "archived", "cancelled"].includes(c2.status))
                    continue;
                db.prepare(`UPDATE cards SET status='ready', claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, assignee=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(who === "?" ? null : who, c2.id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${agentName()}`, "mcp_reopen", c2.status, "ready", `任务 #${row.id} 重开（${args.reason.trim().slice(0, 80)}）`);
            }
        }
        catch (e) { console.error(`[task_reopen] 卡片侧更新失败（记忆侧已重开）：${e.message}`); }
    });
    if (ropenAbort)
        return ropenAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${row.id} 已重开（${st.status} → in_progress，指派 ${who}）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_reopen", id: row.id, status: "in_progress", version: row.version + 1, assignee: who }) + dspNotice;
}

/** task_done：完成任务（→done 结论回写；有 [gate] 先验收，失败回 pending） */
export async function doneTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法完成。`;
    if (st.status === "done")
        return `#${args.memory_id} 已完成，无需重复标记。`;
    // v1.1 状态机：仅 in_progress / review → done 合法
    // ★ 弊端 H1：归属守卫——仅认领者本人（或未认领任务）可完成；
    //   第三方验收关闭走 task_verify（verified_by 留痕），接手工作走 task_reopen 重派。
    if (st.assignee !== "?" && st.assignee !== agentName())
        return `#${row.id} 由 ${st.assignee} 认领，你（${agentName()}）不是认领者，不能代为完成：第三方验收请走 task_admin(action=verify)（带依据），需接手请 task_admin(action=reopen) 重派后再完成。`;
    const tErr = assertTransition(st.status, "done");
    if (tErr)
        return `#${args.memory_id} ${tErr}`;
    // ★ P2-6（C-2）fencing：拒绝过期完成写（lease 被接管 / 版本漂移）
    // ★ ③-A：锁检查改全集合（单卡兼容旧逻辑：存在锁且任一张锁不符才拒）
    const doneLocks = cardsOfTask(db, row.id).filter((cc) => cc.claim_lock);
    const doneMismatch = doneLocks.find((cc) => cc.claim_lock !== args.lease_token);
    if (args.lease_token && doneLocks.length && doneMismatch)
        return `#${args.memory_id} 租约已被接管（卡片 #${doneMismatch.id} 现锁 ${String(doneMismatch.claim_lock).slice(0, 8)}…），本次完成拒绝（fencing）；请重新 task_next。`;
    if (args.expected_version != null && args.expected_version !== row.version)
        return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：完成请求拒绝；请刷新后重试。`;
    // ★ ②-A：A1 硬模式下 fencing 版本必填——防僵尸会话陈旧完成写（软模式保持兼容）
    if (process.env.MEMORYOS_A1_ENFORCE === "1" && args.expected_version == null)
        return `#${args.memory_id} A1 硬模式（MEMORYOS_A1_ENFORCE=1）：task_done 必须携带 expected_version（fencing：task_next / task_read 回执中的 version）；请刷新任务后重试。`;
    // ★ 2026-10-02 Dispatch 语义（对标 orca「Lifecycle authority comes from the active Dispatch」）：
    //   权威**只**来自 active dispatch——传了 key 就必须逐条过关；不传则软模式放行（与 A1 同款兼容策略）。
    const dspRow = args.dispatch_key ? readDispatchByKey(db, args.dispatch_key) : null;
    if (args.dispatch_key) {
        if (!dspRow)
            return `#${args.memory_id} dispatch 不存在（${String(args.dispatch_key).slice(0, 12)}…）：请 task_next / task_claim 重新获取后再完成。`;
        if (Number(dspRow.memory_id) !== Number(row.id))
            return `#${args.memory_id} dispatch 归属不符（该 dispatch 属于任务 #${dspRow.memory_id}）：拒绝跨任务写入。`;
        if (dspRow.state !== "active")
            return `#${args.memory_id} 该 dispatch 已 ${dspRow.state}（你已被取代或已结算）：权威只来自 active dispatch，请重新 task_next 后领取。`;
        if (dspRow.agent !== agentName())
            return `#${args.memory_id} 该 dispatch 由 ${dspRow.agent} 持有，你（${agentName()}）不是持有者：拒绝写入。`;
    }
    const body = taskBody(row.content);
    // ★ P3 确定性门控：任务头声明 [gate:预设] 时，先跑验收——不信任 Agent 自报结论。
    //   门控通过 → 标记 done；门控失败/未命中预设 → fail-closed，状态置 pending（可重新 task_claim 重试），
    //   并把门控判定落审计（exec_audit + task_gate 事件）；卡片不回退（保持原状态），修复后 done 再同步。
    const gateName = taskGateName(row.content);
    let gateRes = null;
    if (gateName) {
        gateRes = await runTaskGate(ctx, gateName, row.id);
        appendEvent(db, { memory_id: row.id, op: "task_gate", payload: JSON.stringify({ gate: gateName, ...gateRes, fallback: "pending" }), operator: `agent:${agentName()}` });
    }
    if (gateRes && !gateRes.ok) {
        // fail-closed：验收未通过 → 不标 done，回退 pending 留痕。
        // ★ 弊端复盘查漏：卡侧同步 ready + 清租约（assignee 保留=修复者）——
        //   原实现卡片停在 running 持锁，与记忆头 pending 打架，5 分钟后还会被 reconcile 强行对齐。
        // ★ 一致性①：回退 CAS + 卡同步 + 清锁一笔事务。
        const gAbort = runTaskTx(db, () => {
            const pendingContent = `${taskBodyWithDep("pending", st.assignee, st.deps, body)}\n→ 结论(${agentName()})：${sanitizeTaskText(args.conclusion).trim()}\n⛔ 门控 gate='${gateName}' 未通过（${String(gateRes.detail).slice(0, 160)}）——状态回退 pending，修复后 task_claim + task_done 重试。`;
            const rolled = updateMemory(db, row.id, { content: pendingContent, expectedVersion: row.version });
            if (!rolled)
                throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
            syncTaskToCard(db, row.id, "ready", { actor: `agent:${agentName()}`, action: "gate_fallback", source: "agent", detail: `任务 #${row.id} 门控未通过回退 pending` });
            for (const cc of cardsOfTask(db, row.id)) { // ★ ③-A：全集合清锁（含多卡第 2..n 张）
                // ★ B3（P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：门控失败计数 +1（与 failure_count 分立列）。
                //   清零只在成功收口/人工介入（syncTaskToCard done、transitionCard done|human、acceptCard）——
                //   agent 重领不清零，否则 claim→清零 使熔断器永不可达（见 gateBreakerOn 注释与报告 §3-B3）。
                if (gateBreakerOn())
                    db.prepare(`UPDATE cards SET gate_fail_count=gate_fail_count+1 WHERE id=?`).run(cc.id);
                db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cc.id);
            }
        });
        if (gAbort)
            return gAbort;
        // ★ B3：回执带熔断计数（开关关时 undefined → stateReceipt 过滤，文案逐字节同改前）
        const gateFailCount = gateBreakerOn()
            ? Math.max(0, ...cardsOfTask(db, row.id).map((cc) => Number(db.prepare(`SELECT gate_fail_count g FROM cards WHERE id=?`).get(cc.id)?.g ?? 0)))
            : undefined;
        return `任务 #${row.id} 门控未通过（gate='${gateName}'：${String(gateRes.detail).slice(0, 120)}）——status=pending（fail-closed，未标 done）。请修复后 task_claim 再 task_done。` + stateReceipt({ op: "task_done_gate_fallback", id: row.id, status: "pending", version: row.version + 1, gate: gateName, gate_fail_count: gateFailCount });
    }
    const gateNote = gateRes && gateRes.ok ? ` 门控 gate='${gateName}' PASS` : "";
    // ★ 弊端 H3：M2 验收双轨对齐——卡带 meta.acceptance 且未跑 [gate:] 门控时不放过 done
    //   （web 侧 /status 已按修 #7 口径拦截；MCP 路径同口径，消除 task_done 绕行通道）。
    if (!gateRes) {
        // ★ ③-A：任一 dispatch 卡带验收标准即拦（原单卡 LIMIT 1：门控写在第 2 张卡上会绕过）
        let accHit = null;
        for (const cc of cardsOfTask(db, row.id)) {
            let m = null;
            try { m = cc.meta ? JSON.parse(String(cc.meta)) : null; }
            catch { m = null; }
            if (m && m.acceptance != null && !(Array.isArray(m.acceptance) && m.acceptance.length === 0)) {
                accHit = cc;
                break;
            }
        }
        if (accHit) {
            // ★ B2（P1 · 开关 MEMORYOS_DONE_AUTOREVIEW=1，默认关=下方原拒绝文案逐字节不动）：
            //   不再拒绝——卡转 review、**头保持 in_progress**（CARD_TO_TASK review→in_progress 自洽，无头/卡分裂）、
            //   回执「已提交，等待验收」；人工 /accept 收口。治 #4「验收规则让 agent 空转」。
            //   与 B1 的分工：B1 的 applyTransition 落地后，agent 收口不得覆盖人工 review 也走同一回执。
            if (doneAutoreviewOn()) {
                const moved = [];
                for (const cc of cardsOfTask(db, row.id)) {
                    let m = null;
                    try { m = cc.meta ? JSON.parse(String(cc.meta)) : null; }
                    catch { m = null; }
                    if (!(m && m.acceptance != null && !(Array.isArray(m.acceptance) && m.acceptance.length === 0)))
                        continue;
                    if (cc.status !== "review") {
                        db.prepare(`UPDATE cards SET status='review', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(cc.id);
                        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cc.id, `agent:${agentName()}`, "autoreview", cc.status, "review", `任务 #${row.id} 自带验收标准：task_done 转待验收（MEMORYOS_DONE_AUTOREVIEW=1，人工 /accept 收口）`);
                    }
                    moved.push(cc.id);
                }
                return `任务 #${row.id} 已提交，等待验收（卡带 meta.acceptance 未跑 [gate:] 门控——按 B2 口径转 review，人工 /accept 后收口；任务头保持 in_progress）：${args.conclusion.trim().slice(0, 100)}` + stateReceipt({ op: "task_done_autoreview", id: row.id, status: "review", awaiting_acceptance: true, cards: moved, version: row.version });
            }
            return `任务 #${row.id} 的卡（卡片 #${accHit.id}）带验收标准（meta.acceptance），但未执行 [gate:<预设>] 门控——task_done 不允许未经确定性验收即关闭（与 web 侧同口径）。请先在任务头声明 gate，或由人工移除卡的验收标准后重试。`;
        }
    }
    // ★ B1（P2 · 开关 MEMORYOS_REVIEW_GUARD=1，默认关）：任务的任一 dispatch 卡处于 review（人工验收/
    //   待验收）时，agent 收口不得覆盖——与 B2 同一回执语义（头保持 in_progress、卡留 review、
    //   「已提交，等待验收」），人工 /accept 后经 syncCardToTask 收口。治 #3 单向覆盖；默认关时
    //   下方原成功路径逐字节不动（缺陷复现见探针 P16c）。
    if (reviewGuardOn()) {
        const reviewCards = cardsOfTask(db, row.id).filter((cc) => cc.status === "review");
        if (reviewCards.length) {
            const cardIds = reviewCards.map((c) => Number(c.id));
            const guardAbort = runTaskTx(db, () => {
                const guardContent = `${taskBodyWithDep("in_progress", st.assignee, st.deps, body)}\n→ 结论(${agentName()})：${sanitizeTaskText(args.conclusion).trim()}${gateNote}\n⏳ 提交待验收（卡 #${cardIds.join("/")} 处于 review——按 B1 口径 agent 收口不覆盖人工验收，人工 /accept 后收口）`;
                const guardWrite = updateMemory(db, row.id, { content: guardContent, expectedVersion: row.version });
                if (!guardWrite)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
                // 本次尝试终结（工作已交付，等人工验收）——与 B2 同口径不留给租约机制；
                if (dspRow)
                    settleDispatch(db, dspRow.id, "succeeded", `task_done by ${agentName()} awaiting human accept (review guard)${gateRes ? ` gate=${gateName} PASS` : ""}`);
            });
            if (guardAbort)
                return guardAbort;
            return `任务 #${row.id} 已提交，等待验收（卡 #${cardIds.join("/")} 处于 review——按 B1 口径 agent 收口不覆盖人工验收，人工 /accept 后收口；任务头保持 in_progress）：${args.conclusion.trim().slice(0, 100)}` + stateReceipt({ op: "task_done_review_guard", id: row.id, status: "in_progress", awaiting_acceptance: true, cards: cardIds, version: row.version + 1 });
        }
    }
    // ★ 一致性①：done CAS + 置信强化 + 事件 + 卡同步 + 清租约包成一笔事务——
    //   中途崩溃不再出现「头已 done、卡还 running 持锁」的半笔账；慢的门控子进程验收已在锁外跑完。
    const doneAbort = runTaskTx(db, () => {
        // ★ P2⑳：证据约束——结论正文附来源记忆 id；未附 = unverified（后续按低强度对待）
        const evidenceRaw = String(args.evidence_memory_ids ?? "").replace(/[^0-9,]/g, "");
        const evidenceIds = evidenceRaw ? [...new Set(evidenceRaw.split(",").map((s) => s.trim()).filter(Boolean))] : [];
        const evidenceNote = evidenceIds.length
            ? ` 证据来源：#${evidenceIds.join(" #")}`
            : " 证据来源：（未附，unverified）";
        const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, body)}\n→ 结论(${agentName()})：${sanitizeTaskText(args.conclusion).trim()}${gateNote}${evidenceNote}`;
        const doneWrite = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version }); // ★ CAS：并发 done 只有一个生效
        if (!doneWrite)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请 task_next 刷新后重试。`);
        // ★ ④-A：无确定性门控/验收标准的关闭=「自述完成」——事件打 self_verified 标记（验收可据此降权），
        //   置信强化只给低档 0.02；经 [gate:] 门控通过的关闭保持 0.05 全强度。
        const selfVerified = !gateRes;
        bumpConfidence(db, row.id, selfVerified ? 0.02 : 0.05);
        appendEvent(db, { memory_id: row.id, op: "task_done", payload: JSON.stringify({ by: agentName(), session_id: args.session_id ?? null, cred_id: cred.credId, self_verified: selfVerified || undefined, dispatch_id: dspRow?.id, generation: dspRow?.generation, evidence_ids: evidenceIds.length ? evidenceIds : undefined, unverified: evidenceIds.length === 0 || undefined }), operator: `agent:${agentName()}` });
        // ★ 2026-10-02 Dispatch 结算：outcome 必填（orca 口径——禁止只在散文里编码失败）
        if (dspRow)
            settleDispatch(db, dspRow.id, "succeeded", `task_done by ${agentName()}${gateRes ? ` gate=${gateName} PASS` : " self_verified"}${evidenceIds.length ? ` evidence=[${evidenceIds.join(",")}]` : " unverified"}`);
        syncTaskToCard(db, row.id, "done", { actor: `agent:${agentName()}`, source: "agent", detail: `任务 #${row.id} MCP 完成` });
        // ★ P0-B：任务结果关联——把本次 session 注入的记忆与任务成败挂钩，供 daemon 降权低效记忆
        if (args.session_id || evidenceIds.length) {
            const outcome = gateRes ? (gateRes.ok ? "success" : "failed") : evidenceIds.length ? "success" : "unverified";
            const injected = args.session_id
                ? db.prepare(
                    `SELECT DISTINCT memory_id FROM memory_usage
                         WHERE session_id = ? AND event = 'injected' AND project = ?`
                ).all(args.session_id, row.project).map((r) => Number(r.memory_id))
                : [];
            const allEvidence = [...new Set([...injected, ...evidenceIds])];
            for (const mid of allEvidence) {
                db.prepare(
                    `INSERT INTO memory_task_outcomes(memory_id, task_card_id, outcome, session_id)
                         VALUES(?, ?, ?, ?)`
                ).run(mid, row.id, outcome, args.session_id ?? null);
            }
        }
        for (const cc of cardsOfTask(db, row.id)) // ★ ③-A：全集合清锁；P2-6：完成即释放租约锁；⑦：顺带撕贴条
            db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cc.id);
    });
    if (doneAbort)
        return doneAbort;
    return `任务 #${row.id} 已完成（status=done）[${row.type}|${row.agent}] 结论：${args.conclusion.trim().slice(0, 100)}` + stateReceipt({ op: "task_done", id: row.id, status: "done", version: row.version + 1, cred_id: cred.credId, session_id: args.session_id ?? null, dispatch_key: dspRow ? args.dispatch_key : undefined, dispatch_id: dspRow?.id, generation: dspRow?.generation, outcome: dspRow ? "succeeded" : undefined });
}

/** task_verify：第三方验收关闭（只置 done+verified_by 留痕；不改归属、不发租约） */
export function verifyTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const verifier = args.as && args.as !== "any" ? args.as : agentName();
    const cred = checkWriteCredential(ctx, verifier, args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法验收。`;
    if (st.status === "done")
        return `#${args.memory_id} 已是 done，无需验收。`;
    if (!["pending", "in_progress"].includes(st.status))
        return `#${args.memory_id} 当前 status=${st.status}，仅 pending/in_progress 可验收关闭（review 走 task_done，终态走 task_admin(action=reopen)）。`;
    if (args.expected_version != null && args.expected_version !== row.version)
        return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：验收写拒绝；请刷新后重试。`;
    // ★ ②-A：A1 硬模式下 fencing 版本必填——第三方验收写最开放，无版本防护时僵尸会话可陈旧收口
    if (process.env.MEMORYOS_A1_ENFORCE === "1" && args.expected_version == null)
        return `#${args.memory_id} A1 硬模式（MEMORYOS_A1_ENFORCE=1）：task_admin(action=verify) 必须携带 expected_version（fencing：task_next / task_read 回执中的 version）；请刷新任务后重试。`;
    // ★ 一致性①：头 CAS + 事件 + 卡同步 + 清租约一笔事务
    const vfAbort = runTaskTx(db, () => {
        // 不改 assignee（归属保留原文）、不发租约、不动 claim_lock 语义——只闭环状态头 + 留痕
        const rewriteNote = args.user_rewritten
            ? `\n→ 用户改写(${verifier})：${sanitizeTaskText(args.user_rewritten).trim()}`
            : "";
        const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, taskBody(row.content))}\n→ 验收(${verifier})：${args.reason.trim()}${rewriteNote}`;
        const verified = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
        if (!verified)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_verify", payload: JSON.stringify({ verified_by: verifier, from: st.status, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId, user_rewritten: args.user_rewritten ? "yes" : undefined }), operator: `agent:${agentName()}` });
        syncTaskToCard(db, row.id, "done", { actor: `agent:${verifier}`, action: "verify", source: "agent", detail: `任务 #${row.id} 第三方验收关闭（${verifier}）${args.user_rewritten ? "，含用户改写" : ""}` });
        for (const cc of cardsOfTask(db, row.id))
            db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cc.id);
    });
    if (vfAbort)
        return vfAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, verifier);
    return `任务 #${row.id} 已验收关闭（status=done，verified_by=${verifier}，未改归属/未发租约）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_verify", id: row.id, status: "done", version: row.version + 1, verified_by: verifier, cred_id: cred.credId, session_id: args.session_id ?? null }) + dspNotice;
}

/** task_supersede：重复任务归档（merged+superseded_by 指向主任务，移出可做集） */
export function supersedeTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const win = readMemory(db, args.superseded_by);
    if (!win || win.type !== "task")
        return `#${args.superseded_by} 不存在或非任务（winner 须为任务）。`;
    if (args.memory_id === args.superseded_by)
        return `memory_id 与 superseded_by 不能相同。`;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法归档。`;
    if (st.status === "done")
        return `#${args.memory_id} 已 done，无需归档。`;
    // ★ 一致性①：merged 归档 + 事件 + 用量记账一笔事务
    const spAbort = runTaskTx(db, () => {
        markMerged(db, args.memory_id, args.superseded_by); // merged + superseded_by；移出检索候选
        appendEvent(db, {
            memory_id: args.memory_id,
            op: "task_supersede",
            payload: JSON.stringify({ superseded_by: args.superseded_by, by: agentName() }),
            operator: `agent:${agentName()}`,
        });
        logUsage(db, {
            memory_id: args.memory_id, event: "supersede", reader_agent: agentName(), writer_agent: agentName(),
            project: row.project, session_id: args.session_id, task_hint: args.task_hint,
        });
    });
    if (spAbort)
        return spAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${args.memory_id} 已标记被 #${args.superseded_by} 取代（merged ⇒ 移出可做集，可经 superseded_by 追溯）` + dspNotice;
}
