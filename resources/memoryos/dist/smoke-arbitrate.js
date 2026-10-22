/**
 * MemoryOS v0.3 — 仲裁冒烟（M-2.4）
 *   A1 队列：conflict 记忆进入 possible-conflict 队列
 *   A2 键1保留新：旧→superseded；(R1)旧值不再被检索召回
 *   A3 键2保留旧：新→rejected，旧 conf+0.05
 *   A4 键3合并：双方→merged + 插合并行（derived_from），u 撤销后删插入行恢复
 *   A5 键4不冲突：双方去标签，conf 恢复 0.8
 *   A6 u 撤销：按键1后撤销，旧值回到 active 并可检索
 * 用法：node dist/smoke-arbitrate.js
 */
import { openDb, writeMemory, readMemory, applyArbitration, undoLastArbitration, pendingConflicts } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `memoryos-smoke-arb-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
async function conflictPair(db, emb, keyword) {
    const old = await writeMemory(db, { content: keyword + " 旧方案用数据库直存", type: "experience", agent: "codex", agent_fpath: null, project: "p1", embedding: (await emb.embedTexts([keyword + " 旧方案用数据库直存"]))[0] });
    const p = await writeMemory(db, { content: keyword + " 新方案改走 Redis（时钟偏差 5 分钟）", type: "experience", agent: "claude", agent_fpath: null, project: "p1", embedding: (await emb.embedTexts([keyword + " 新方案改走 Redis（时钟偏差 5 分钟）"]))[0] });
    db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(old.id, p.id); // 模拟 conflict 标签
    return { old, p };
}
try {
    const db = openDb(dbPath);
    const emb = await getEmbedder();
    // A1 队列：造一对 conflict
    const pair1 = await conflictPair(db, emb, "微信回调");
    let q = pendingConflicts(db);
    check("A1.队列含 conflict 对", q.some((x) => x.pending.id === pair1.p.id && x.old?.id === pair1.old.id));
    // A2 键1保留新：旧→superseded；(R1)旧值不再被搜索召回
    applyArbitration(db, pair1.p.id, "1");
    const old1 = readMemory(db, pair1.old.id);
    check("A2a.旧→superseded", old1.status === "superseded" && old1.superseded_by === pair1.p.id, `status=${old1.status}`);
    check("A2b.新→active 且无 conflict 标签", readMemory(db, pair1.p.id).status === "active" && readMemory(db, pair1.p.id).conflict_with === null);
    const hitOld = await hybridSearch(db, emb, { query: "微信回调 数据库直存", project: "p1", limit: 10 });
    check("A2c.(R1)旧值不再被检索召回", !hitOld.some((h) => h.id === pair1.old.id), `returned=${hitOld.map((h) => h.id).join(",")}`);
    // A6 u 撤销（对最近一条非 undo）→ 旧值回到 active 且冲突标签恢复
    const u = undoLastArbitration(db);
    check("A6a.撤销返回成功", u.includes("已撤销"), u);
    const old1b = readMemory(db, pair1.old.id);
    check("A6b.撤销后旧值回 active", old1b.status === "active" && old1b.superseded_by !== pair1.p.id, `status=${old1b.status}`);
    const again = await hybridSearch(db, emb, { query: "微信回调 数据库直存", project: "p1", limit: 10 });
    check("A6c.撤销后旧值可被检索", again.some((h) => h.id === pair1.old.id));
    // A3 键2保留旧：新→rejected，旧 conf+0.05
    const pair2 = await conflictPair(db, emb, "订单状态机");
    const beforeOld2 = readMemory(db, pair2.old.id).confidence;
    applyArbitration(db, pair2.p.id, "2");
    check("A3a.新→rejected", readMemory(db, pair2.p.id).status === "rejected");
    check("A3b.旧 conf+0.05", Math.abs(readMemory(db, pair2.old.id).confidence - (beforeOld2 + 0.05)) < 1e-9, `conf=${readMemory(db, pair2.old.id).confidence}`);
    // A4 键3合并：双方→merged + 插合并行；再 A4x 撤销删插入行
    const pair3 = await conflictPair(db, emb, "网关限流");
    applyArbitration(db, pair3.p.id, "3");
    const old3 = readMemory(db, pair3.old.id);
    const new3 = readMemory(db, pair3.p.id);
    const mergedRows = db.prepare(`SELECT id FROM memories WHERE derived_from=? AND status='active'`).all(pair3.p.id);
    check("A4a.双方→merged", old3.status === "merged" && new3.status === "merged", `old=${old3.status},new=${new3.status}`);
    check("A4b.插入了合并行(derived_from=new)", mergedRows.length === 1, `rows=${mergedRows.length}`);
    const totalAfterMerge = db.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
    undoLastArbitration(db);
    const totalAfterUndo = db.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
    check("A4c.合并撤销后插入行被删", totalAfterUndo === totalAfterMerge - 1, `merge=${totalAfterMerge},undo=${totalAfterUndo}`);
    check("A4d.合并撤销后双方回 active", readMemory(db, pair3.old.id).status === "active" && readMemory(db, pair3.p.id).status === "active");
    // A5 键4不冲突：双方去标签，conf 恢复 0.8
    const pair4 = await conflictPair(db, emb, "数据导出");
    db.prepare(`UPDATE memories SET confidence=0.5 WHERE id=?`).run(pair4.p.id);
    applyArbitration(db, pair4.p.id, "4");
    check("A5a.新 conf 恢复 0.8", Math.abs(readMemory(db, pair4.p.id).confidence - 0.8) < 1e-9, `conf=${readMemory(db, pair4.p.id).confidence}`);
    check("A5b.双方去 conflict 标签", readMemory(db, pair4.p.id).conflict_with === null && readMemory(db, pair4.old.id).status === "active");
    db.close();
}
finally {
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
        try {
            fs.rmSync(p, { force: true });
        }
        catch { }
    }
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
