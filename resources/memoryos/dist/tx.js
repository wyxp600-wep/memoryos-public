/**
 * MemoryOS — 任务域事务/回执共享原语（Step 0 抽取 · 2026-10-18）
 *
 * 自 server-tools.js 共享层抽出为**叶子模块**（只依赖 db.js 的 withTx）：
 *   · TxAbort / runTaskTx —— 「记账一笔成」事务包装（一致性①：多步写要么全成要么全不算；
 *     事务内业务中止抛 TxAbort 转人话文案，绝不抛 MCP 裸异常；慢活绝不进事务）。
 *   · stateReceipt —— 写工具回执的机器可读终态行（⟨state⟩ 单行 JSON；undefined/null 不输出）。
 *
 * 抽取原因：task-domain.js（领域层）需要这三个原语，但 domain → server-tools 会与
 * server-tools → server-reg-task → task-domain 形成**循环依赖**；落叶子模块后两边共用。
 * server-tools.js 原样 re-export，既有 import 方与 _ctx 组装零改动。
 */
import { withTx } from "./db.js";

/** 事务内业务中止（并发冲突需把人话文案返回给 agent 而非抛 MCP 错误）→ runTaskTx 捕获转文案 */
export class TxAbort extends Error {
    constructor(msg) { super(msg); this.name = "TxAbort"; }
}

/** 「记账一笔成」：fn 只做 DB 写（重跑安全），锁竞争由 withTx 整段重试 */
export function runTaskTx(db, fn) {
    try {
        withTx(db, fn);
        return null;
    }
    catch (e) {
        if (e instanceof TxAbort)
            return e.message; // 业务中止：整体已回滚，把冲突文案交还调用方
        throw e; // 非业务错误：向上抛（MCP 层兜底）
    }
}

/** 写工具回执追加机器可读终态行（治「成功回执 + 零副作用」；单行 JSON 供调用方逐字校验） */
export function stateReceipt(o) {
    const slim = {};
    for (const [k, v] of Object.entries(o))
        if (v !== undefined && v !== null)
            slim[k] = v;
    return `\n⟨state⟩ ${JSON.stringify(slim)}`;
}
