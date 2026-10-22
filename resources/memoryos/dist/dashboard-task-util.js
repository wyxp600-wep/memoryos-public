/** T8：任务卡头解析共享常量（原 dashboard.js buildApp 局部；上移为叶子模块，保持单一真相源）
 *  ★ E-0 裁决（附录 G）落码：持久 6 态 {pending, in_progress, blocked, done, cancelled, merged}；
 *    archived 为记忆轴终态（列归档同步产物）；review/failed 已取消，仅在正则/归一表保留以消化存量头。 */
export const TASK_HEAD_RE_STATES = "pending|in_progress|blocked|review|done|failed|cancelled|merged|archived";
export const TASK_HEAD_RE = new RegExp(`^\\[task\\]\\[assignee:[^\\]]*\\]\\[status:(${TASK_HEAD_RE_STATES}|open|claimed)\\]`);
// ★ 一致性③（2026-09-19）：TASK_NORMALIZE 上移至权威对照表 task-status-map.js，此处仅转发
// （dashboard-reg-memory.js 等既有 import 方保持不变；正则/桶等卡片侧专用常量仍留本模块）。
export { TASK_NORMALIZE } from "./task-status-map.js";
export const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
export const TASK_BUCKETS = ["pending", "in_progress", "blocked", "done", "cancelled", "merged", "archived"];
