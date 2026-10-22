/**
 * MemoryOS dashboard — ★ 2026-10-14（方案 B · exec_run 服务端挂起审批）看板侧接口。
 *
 * 三条路由（人操作的三个动作）：
 *   GET  /api/exec/approvals              → 待批列表 + 最近已决（看板「待批命令」面板）
 *   POST /api/exec/approvals/:id/approve  → 同意一次（放行这一次，跑完销号）
 *   POST /api/exec/approvals/:id/deny     → 拒绝
 *
 * 边界：本模块只读写 exec_approvals 表；**命令仍由发起调用的 MCP 会话执行**，看板只当"发令枪"——
 *   避免同一命令被执行两次，也避免看板自己持有一份执行能力（它不该有）。
 *   裁决为原子 CAS：仅 pending 可被改写，重复点击第二次返回 409 而不是覆盖前一次决定。
 */
import { listApprovals, decideApproval } from "./exec-approval.js";

export function registerExecApproval(app, ctx) {
    const { db } = ctx;

    app.get("/api/exec/approvals", async () => ({ ok: true, ...listApprovals(db) }));

    for (const decision of ["approve", "deny"]) {
        app.post(`/api/exec/approvals/:id/${decision}`, async (req, reply) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id < 1)
                return reply.code(400).send({ ok: false, error: `待批项 id 非法：${req.params.id}` });
            const r = decideApproval(db, id, decision);
            if (!r.ok)
                return reply.code(409).send({ ok: false, error: r.error, row: r.row ?? null });
            return { ok: true, row: r.row };
        });
    }
}
