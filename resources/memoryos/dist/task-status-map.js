/** ★ 一致性③（2026-09-19）：任务 ⇄ 卡片状态「权威对照表」—— 单一事实源。
 *  此前同一映射散落 4 处（server.js TASK_NORMALIZE / dashboard-task-util.js TASK_NORMALIZE /
 *  dashboard-reg-cards.js syncCardToTask 内联 map / reconcile.js EXPECT_CARD_OF），各翻各的、
 *  每次修映射 bug 都要找齐所有副本；本模块收敛后只改这一处。叶子模块（零依赖），各方直接 import。
 *  词汇表口径（E-0 裁决）：任务持久态 = pending/in_progress/blocked/done/cancelled/merged，
 *  archived 为记忆轴终态；卡片 10 态见 dashboard-reg-cards.js CARD_STATES。 */
/** 存量/历史状态 → E-0 标准态 归一（open/claimed 为 v1.1 前历史值；review/failed 为 E-0 取消态，归一回 in_progress） */
export const TASK_NORMALIZE = { open: "pending", claimed: "in_progress", done: "done", review: "in_progress", failed: "in_progress" };
/** 卡片状态 → 任务状态头（看板流转回写 memories 用；triage/todo 无对应任务态 → undefined，调用方跳过） */
export const CARD_TO_TASK = {
    ready: "pending", running: "in_progress", done: "done", failed: "blocked", blocked: "blocked",
    review: "in_progress", cancelled: "cancelled", archived: "archived",
};
/** 任务状态头（开放态） → 期望卡片状态（对账投影口径 C-5：卡向头对齐；终态头不参与对账，
 *  由调用方按 CARD_TERMINAL 跳过 —— 语义与 reconcile.js 原 EXPECT_CARD_OF 逐字节一致） */
export const EXPECT_CARD_OF = { pending: "ready", in_progress: "running", blocked: "blocked" };
