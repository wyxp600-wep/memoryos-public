/**
 * MemoryOS — ★ 2026-10-14（方案 B · exec_run 服务端挂起审批）
 *
 * 背景（为什么需要它，而不是把黑名单加长）：exec-tools.js 的 DENY_SPEC 是**黑名单**，只能枚举已知的
 *   「一次调用即任意/远程代码」形态；同类新形态（新子命令、新解释器开关）必然漏网（已在 CLAIM §5 如实声明）。
 *   方案 B 换判据：不枚举「危险」，而是在**执行前**把高风险命令挂起，交人裁量 ——
 *   「审的是这次要跑什么」，故不漏网，且不必猜测。
 *
 * 流程：exec_run 判定高风险（exec-tools.execRiskReason）→ 本模块落一条 pending（含命令/目录/原因/发起方）
 *   → 人在看板「待批命令」面板点「同意一次/拒绝」→ 放行则原调用继续执行、拒绝或超时则**不执行**并回告原因。
 *
 * 语义与边界：
 *   · **超时 = 拒绝**（默认 120s，`MEMORYOS_EXEC_APPROVAL_TIMEOUT_MS` 可调）：绝不"无人处理即默认放行"。
 *   · 低风险命令零打扰（不经本模块，直接执行）。
 *   · 关闸开关：`MEMORYOS_EXEC_APPROVAL=0`；另 `MEMORYOS_EXEC_ALLOW` 显式设置 ⇒ 与 DENY_SPEC 同口径让位
 *     （操作者已明确知悉风险，不静默改写其意图）。
 *   · 只影响 MCP `exec_run`；看板准终端是人手敲的，不经此闸。
 *   · 本模块只碰 exec_approvals 表（纯新增结构），不改任何既有表/字段。
 */
const DEFAULT_TIMEOUT_MS = 120000; // 2 分钟：与「人在旁边看着点一下」的场景匹配
const POLL_MS = 500;               // 等待粒度：人点完最多 0.5s 放行（对齐 UX，不做忙等）

/** 审批等待上限（ms）：env 可调，供冒烟/自定节奏 */
export function approvalWaitMs() {
    const n = Number(process.env.MEMORYOS_EXEC_APPROVAL_TIMEOUT_MS);
    return Number.isFinite(n) && n > 1000 ? Math.min(n, 600000) : DEFAULT_TIMEOUT_MS;
}

/** 审批闸是否生效（关闸/让位两种情形都返回 false） */
export function approvalGateEnabled() {
    if (process.env.MEMORYOS_EXEC_APPROVAL === "0")
        return false;
    const allow = process.env.MEMORYOS_EXEC_ALLOW;
    if (allow && allow.trim())
        return false; // 与 execDenyReason 同口径：显式白名单 = 操作者已知悉风险，守卫让位
    return true;
}

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 落一条待批（返回 id） */
export function insertApproval(db, { agent, cmd, cwd, reason, sessionId = null, timeoutMs = approvalWaitMs() }) {
    const info = db
        .prepare(`INSERT INTO exec_approvals(agent, cmd, cwd, reason, status, session_id, expires_at)
       VALUES (?,?,?,?,'pending',?,?)`)
        .run(String(agent ?? "unknown"), String(cmd ?? ""), cwd ?? null, reason ?? null, sessionId, nowIso(Date.now() + timeoutMs));
    return Number(info.lastInsertRowid);
}

export function readApproval(db, id) {
    return db.prepare(`SELECT * FROM exec_approvals WHERE id = ?`).get(id) ?? null;
}

/** 到期即作废（幂等；返回最新行）。仅 pending 会被改写 —— 已决的行绝不被覆盖。 */
export function expireIfDue(db, row, nowMs = Date.now()) {
    if (row && row.status === "pending" && Date.parse(row.expires_at) <= nowMs) {
        db.prepare(`UPDATE exec_approvals SET status='expired', decided_at=?, decided_by='system:timeout' WHERE id=? AND status='pending'`)
            .run(nowIso(nowMs), row.id);
        return readApproval(db, row.id);
    }
    return row;
}

/** 人工裁决：approve / deny（原子 CAS：仅 pending 可被改写，重复点击第二次返回冲突而不是覆盖） */
export function decideApproval(db, id, decision, by = "human:dashboard") {
    const status = decision === "approve" ? "approved" : "denied";
    const row = readApproval(db, id);
    if (!row)
        return { ok: false, error: `待批项 #${id} 不存在` };
    if (row.status !== "pending")
        return { ok: false, error: `待批项 #${id} 已被处理（当前 ${row.status}）`, row };
    if (Date.parse(row.expires_at) <= Date.now())
        return { ok: false, error: `待批项 #${id} 已过期（${row.expires_at}）`, row: expireIfDue(db, row) };
    const r = db
        .prepare(`UPDATE exec_approvals SET status=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'`)
        .run(status, nowIso(), by, id);
    if (Number(r.changes) === 0)
        return { ok: false, error: `待批项 #${id} 已被其他人处理`, row: readApproval(db, id) };
    return { ok: true, row: readApproval(db, id) };
}

/** 执行结束回填结果摘要（审批链闭环：谁批的 + 跑出什么） */
export function settleApproval(db, id, { exit, timedOut, ms, outBytes, errBytes }) {
    if (!id)
        return;
    const result = `exit=${timedOut ? "TIMEOUT" : exit} ${ms}ms out=${outBytes ?? 0}B err=${errBytes ?? 0}B`;
    db.prepare(`UPDATE exec_approvals SET status='executed', result=? WHERE id=? AND status='approved'`).run(result, id);
}

function view(r) {
    return {
        id: r.id,
        agent: r.agent,
        cmd: r.cmd,
        cwd: r.cwd,
        reason: r.reason,
        status: r.status,
        result: r.result,
        requested_at: r.requested_at,
        expires_at: r.expires_at,
        seconds_left: Math.max(0, Math.round((Date.parse(r.expires_at) - Date.now()) / 1000)),
        decided_at: r.decided_at,
        decided_by: r.decided_by,
    };
}

/** 看板用：待批（按提出时间正序，人先看到最早的）+ 最近已决 */
export function listApprovals(db, limit = 60) {
    const rows = db
        .prepare(`SELECT * FROM exec_approvals ORDER BY id DESC LIMIT ?`)
        .all(Math.max(1, Math.min(300, Number(limit) || 60)))
        .map((r) => expireIfDue(db, r));
    const pending = rows.filter((r) => r.status === "pending").sort((a, b) => a.id - b.id).map(view);
    const recent = rows.filter((r) => r.status !== "pending").slice(0, 20).map(view);
    return { pending, recent };
}

/**
 * 审批闸工厂（server.js 注入 createExecTools）。
 * 返回 { request, settle }；request 在「无人处理」时返回 expired —— 调用方按拒绝处理。
 */
export function createApprovalGate(db, { audit = () => { } } = {}) {
    const request = async ({ cmd, cwd, reason, agent, sessionId = null }) => {
        if (!approvalGateEnabled())
            return { decision: "approved", auto: true, note: "approval-gate-off" };
        const waitMs = approvalWaitMs();
        const id = insertApproval(db, { agent, cmd: Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? ""), cwd, reason, sessionId, timeoutMs: waitMs });
        try {
            audit({ tool: "exec_run", risk: "L1", approval: "pending", argsDigest: null, detail: `高风险命令挂起待人审 #${id}（${reason}）`, durationMs: 0 });
        }
        catch { /* 审计失败不阻断挂起 */ }
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            await sleep(Math.min(POLL_MS, Math.max(50, deadline - Date.now())));
            const row = readApproval(db, id);
            if (!row)
                return { decision: "denied", id, by: "system:missing" };
            if (row.status === "approved") {
                try {
                    audit({ tool: "exec_run", risk: "L1", approval: "human-approved", argsDigest: null, detail: `高风险命令经人工批准 #${id}（${row.decided_by ?? "human"}）`, durationMs: 0 });
                }
                catch { /* 同上 */ }
                return { decision: "approved", id, by: row.decided_by };
            }
            if (row.status === "denied")
                return { decision: "denied", id, by: row.decided_by };
            if (row.status === "expired")
                return { decision: "expired", id };
        }
        // 到时：写 expired（幂等，仅 pending 命中）后按拒绝返回
        expireIfDue(db, readApproval(db, id));
        try {
            audit({ tool: "exec_run", risk: "L1", approval: "approval-expired", argsDigest: null, detail: `高风险命令等待人审超时 #${id}（${Math.round(waitMs / 1000)}s）→ 未执行`, durationMs: waitMs });
        }
        catch { /* 同上 */ }
        return { decision: "expired", id };
    };
    const settle = (id, info) => {
        try {
            settleApproval(db, id, info);
        }
        catch { /* 回填失败不影响命令结果 */ }
    };
    return { request, settle };
}
