#!/usr/bin/env node
/**
 * MemoryOS — P2-6（C-5 三方对账与投影重建）**独立验收** 冒烟
 *
 * 定位：不复述他方 smoke-macp 的 G1-G3，而是按"守护到底兜不兜得住"的角度验：
 *   ① 复刻 **task_release 静默失效** 的后果（头已 pending、卡仍 running）——对账必须能修；
 *   ② 反向失配（头 in_progress / 卡 ready）与 blocked 失配；
 *   ③ 幂等（一致的对不命中，二次运行 0 修复）；
 *   ④ 无卡任务 → 投影重建 + 关系表建立；
 *   ⑤ 滞后 >5min → daemon_log(op=lag) 告警；
 *   ⑥ **盲点显式化**：终态卡（done/archived/cancelled）被跳过 ⇒ 头要它 running 也不修（断言"已知行为"，防误解）。
 *
 * 手法：直接构造库内夹具（不需 MCP 往返），调用 reconcileTasksAndCards 后**只读回查**落库事实。
 * 用法：cd resources/memoryos && node dist/smoke-p26-reconcile.js     退出码 0/1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, writeMemory } from "./db.js";
import { reconcileTasksAndCards } from "./reconcile.js";

let pass = 0, fail = 0;
const check = (n, ok, detail = "") => { if (ok) { pass++; console.log(`PASS  ${n}${detail ? "  — " + detail : ""}`); } else { fail++; console.log(`FAIL  ${n}${detail ? "  — " + detail : ""}`); } };
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p26-rec-"));
let db = null;

/* ── 夹具工具 ─────────────────────────────────────────────── */
const task = (assignee, status, extra = "") => writeMemory(db, {
    content: `[task][assignee:${assignee}][status:${status}]${extra ? " " + extra : ""} 对账冒烟夹具任务`, type: "task",
    agent: "p26-rec", agent_fpath: null, project: "global", embedding: null,
});
const addCard = (memId, status, { noLink = false, updatedAgoMin = 0 } = {}) => {
    const info = db.prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority)
       VALUES (?,?,?,?,?,?,?,?)`).run("default", "task", `对账夹具卡 #${memId}`, "fixture", status, "memory", memId, 3);
    const cid = Number(info.lastInsertRowid);
    if (!noLink) db.prepare(`INSERT OR IGNORE INTO card_memory(card_id,memory_id,relation) VALUES (?,?,?)`).run(cid, memId, "dispatch");
    if (updatedAgoMin) db.prepare(`UPDATE cards SET updated_at=datetime('now', ?) WHERE id=?`).run(`-${updatedAgoMin} minutes`, cid);
    return cid;
};
const cardStatus = (cid) => db.prepare(`SELECT status FROM cards WHERE id=?`).get(cid)?.status;
const alignEvents = (cid) => db.prepare(`SELECT COUNT(*) c FROM card_events WHERE card_id=? AND action='reconcile_aligned'`).get(cid).c;
const createdEvents = (cid) => db.prepare(`SELECT COUNT(*) c FROM card_events WHERE card_id=? AND action='reconcile_created'`).get(cid).c;
const lagLogs = () => db.prepare(`SELECT COUNT(*) c FROM daemon_log WHERE op='lag'`).get().c;

try {
    db = openDb(path.join(ws, "rec.db"));

    /* ── M1：复刻 task_release 静默失效后的失配（头 pending / 卡 running）── */
    const t1 = task("p26-rec", "pending");
    const c1 = addCard(t1.id, "running");
    let r = reconcileTasksAndCards(db);
    check("M1.★头 pending 而卡 running（release 静默失效形态）被修复为 ready", cardStatus(c1) === "ready", `card=${cardStatus(c1)}｜${JSON.stringify(r)}`);
    check("M1b.修复留痕 reconcile_aligned", alignEvents(c1) === 1, `events=${alignEvents(c1)}`);

    /* ── M2/M3：反向失配与 blocked 失配 ── */
    const t2 = task("p26-rec", "in_progress");
    const c2 = addCard(t2.id, "ready");
    const t3 = task("p26-rec", "blocked");
    const c3 = addCard(t3.id, "ready");
    r = reconcileTasksAndCards(db);
    check("M2.头 in_progress 而卡 ready → 修复为 running", cardStatus(c2) === "running", `card=${cardStatus(c2)}`);
    check("M3.头 blocked 而卡 ready → 修复为 blocked", cardStatus(c3) === "blocked", `card=${cardStatus(c3)}`);

    /* ── M4：幂等（一致的对照不命中）── */
    r = reconcileTasksAndCards(db);
    check("M4.幂等：二次运行 0 修复 0 重建", r.aligned === 0 && r.created === 0, JSON.stringify(r));
    const evAfter = alignEvents(c1) + alignEvents(c2) + alignEvents(c3);
    check("M4b.重复运行不重复写事件", evAfter === 3, `events=${evAfter}`);

    /* ── M5：无卡任务 → 投影重建 ── */
    const t4 = task("p26-rec", "in_progress", "（无卡）");
    r = reconcileTasksAndCards(db);
    const rebuilt = db.prepare(`SELECT c.id, c.status FROM cards c JOIN card_memory cm ON cm.card_id=c.id WHERE cm.memory_id=? AND cm.relation='dispatch'`).get(t4.id);
    check("M5.无卡任务补建投影卡且状态映射正确（in_progress→running）", !!rebuilt && rebuilt.status === "running" && r.created === 1, `card=${rebuilt?.id}/${rebuilt?.status}`);
    check("M5b.补建留痕 reconcile_created", rebuilt && createdEvents(rebuilt.id) === 1);
    check("M5c.补建的关系行可幂等（再次运行不再重建）", (() => { const r2 = reconcileTasksAndCards(db); return r2.created === 0 && r2.aligned === 0; })());
    check("M5d.补建后卡态即合法（无需等下一轮自我修正）", rebuilt && cardStatus(rebuilt.id) === "running", `card=${cardStatus(rebuilt?.id)}`);

    /* ── M6：终态卡被跳过（已知盲点显式断言）── */
    const t5 = task("p26-rec", "in_progress", "（终态卡盲点）");
    const c5 = addCard(t5.id, "cancelled");
    r = reconcileTasksAndCards(db);
    check("M6.终态卡（cancelled）被跳过不修复 —— 已知盲点，显式记录", cardStatus(c5) === "cancelled", `card=${cardStatus(c5)}（头 in_progress，未被改为 running）`);

    /* ── M7：滞后 >5min 触发 daemon_log 告警 ── */
    const t6 = task("p26-rec", "pending", "（滞后告警）");
    const c6 = addCard(t6.id, "running", { updatedAgoMin: 10 });
    const lagBefore = lagLogs();
    r = reconcileTasksAndCards(db);
    check("M7.卡片镜像滞后 >5min → 修复并写 daemon_log(op=lag)", cardStatus(c6) === "ready" && r.lagAlerts >= 1 && lagLogs() === lagBefore + 1, `alerts=${r.lagAlerts} logs=${lagLogs() - lagBefore}`);

    /* ── M8：终态任务不参与（done 的记忆不驱动卡片）── */
    const t7 = task("p26-rec", "done", "（终态任务）");
    const c7 = addCard(t7.id, "running");
    r = reconcileTasksAndCards(db);
    check("M8.终态任务（done）不参与对账（卡不被改写）", cardStatus(c7) === "running", `card=${cardStatus(c7)}`);

    /* ── M9：卡侧富状态不被对账强拉（修 #3，2026-09-19）── */
    const t9a = task("p26-rec", "in_progress", "（review 保护）");
    const c9a = addCard(t9a.id, "review");
    const t9b = task("p26-rec", "blocked", "（failed 保护）");
    const c9b = addCard(t9b.id, "failed");
    const t9c = task("p26-rec", "pending", "（todo 保护）");
    const c9c = addCard(t9c.id, "todo");
    r = reconcileTasksAndCards(db);
    check("M9a.卡 review 不被对账拉回 running（review 泳道保留）", cardStatus(c9a) === "review", `card=${cardStatus(c9a)}`);
    check("M9b.卡 failed 不被对账拉回 blocked（failed 恢复路保留）", cardStatus(c9b) === "failed", `card=${cardStatus(c9b)}`);
    check("M9c.卡 todo 不被对账拉回 ready（depends 依赖门不被绕过）", cardStatus(c9c) === "todo", `card=${cardStatus(c9c)}`);

    db.close();
    db = null;
} catch (e) {
    fail++;
    console.log(`FAIL  冒烟异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
    try { db?.close(); } catch { /* 已关 */ }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}
console.log(`\n== C-5 三方对账独立验收：${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
