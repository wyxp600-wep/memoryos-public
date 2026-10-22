import { openDb, upsertVector } from "./db.js";
import { getEmbedder } from "./embed.js";
import { replayDecision, replayAll, recordRegression, readRecords, actionFromSim } from "./regress.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
let PASS = 0, FAIL = 0;
const ok = (n, cond, extra = "") => {
    if (cond) {
        PASS++;
        console.log(`  ✅ ${n}${extra ? "  " + extra : ""}`);
    }
    else {
        FAIL++;
        console.error(`  ❌ ${n}${extra ? "  " + extra : ""}`);
    }
};
const tmp = path.join(os.tmpdir(), `memregress-${process.pid}.db`);
const jsonl = path.join(os.tmpdir(), `memregress-${process.pid}.jsonl`);
try {
    fs.rmSync(jsonl, { force: true });
    const db = openDb(tmp);
    const emb = await getEmbedder();
    // ★ 2026-10-15：向量带出处——冒烟/测试场景按当前嵌入器自声明 model/dim（FakeEmbedder 等均已实现 provenance()）
    const prov = emb.provenance?.() ?? { model: "unknown", dim: 0 };
    const w = async (content, type = "experience", agent = "codex") => {
        // ★ P1-2.2：向量已独立成表，写入需分两步（原为 INSERT 直接带 embedding 列）
        const r = db
            .prepare(`INSERT INTO memories(content,type,agent,project,status,confidence) VALUES (?,?,?,?,?,?)`)
            .run(content, type, agent, "global", "active", 0.8);
        const id = Number(r.lastInsertRowid);
        upsertVector(db, id, (await emb.embedTexts([content]))[0], prov);
        return id;
    };
    const setConflict = (pendingId, oldId) => db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(oldId, pendingId);
    // —— R1 仲裁测绘 ——
    const oldId = await w("Ozon /v3/product/info/list 报 400：请求体缺 offer_id");
    const newId = await w("Ozon /v3/product/info/list 报 400：缺 offer_id 导致");
    setConflict(newId, oldId);
    const msg = recordRegression(db, jsonl, newId, "1");
    const recs1 = readRecords(jsonl);
    ok("R1.1 recordRegression 落一行", recs1.length === 1, `(${msg})`);
    const r1 = recs1[0];
    ok("R1.2 字段齐全且判定同源", r1.pending_id === newId &&
        r1.old_id === oldId &&
        r1.pending_content.length > 0 &&
        r1.old_content.length > 0 &&
        Number.isFinite(r1.sim) &&
        r1.auto_action === actionFromSim(r1.sim) &&
        r1.decision === "keep_new", `sim=${r1.sim} auto=${r1.auto_action}`);
    // —— R2 重放通过（判定可回放） ——
    const rep1 = await replayDecision(r1, emb);
    ok("R2 重算判定通过", rep1.pass, `sim=${rep1.sim.toFixed(3)} auto=${rep1.auto_action}`);
    // —— R3 判定非恒真：篡改 sim 后应判 FAIL ——
    const tampered = { ...r1, sim: r1.sim >= 0.5 ? r1.sim - 0.5 : r1.sim + 0.5 };
    const repT = await replayDecision(tampered, emb);
    ok("R3 篡改 sim 触发 FAIL（判定非恒真）", !repT.pass);
    // —— R4 空 jsonl 不炸 ——
    ok("R4 readRecords 空集 0 条", readRecords(path.join(os.tmpdir(), "nope-memregress.jsonl")).length === 0);
    const e4 = await replayAll(path.join(os.tmpdir(), "nope-memregress.jsonl"));
    ok("R4 replayAll 空集 total=0 fail=0", e4.total === 0 && e4.fail === 0);
    // —— R5 端到端：真仲裁 → 落 jsonl → replay 通过 ——
    fs.rmSync(jsonl, { force: true });
    const o5 = await w("端口 80 常被 IIS 占用：查 W3SVC 服务");
    const n5 = await w("端口 80 被 IIS 霸占，先查 W3SVC 状态");
    setConflict(n5, o5);
    // 模拟 arbitrate.js：key=1 保留新 —— 先 record 再 apply（读仲裁前快照）
    recordRegression(db, jsonl, n5, "1");
    db.prepare(`UPDATE memories SET status='superseded', superseded_by=? WHERE id=?`).run(n5, o5); // apply 语义等价
    db.prepare(`UPDATE memories SET conflict_with=NULL WHERE id=?`).run(n5);
    const recs5 = readRecords(jsonl);
    ok("R5.1 端到端落云 row=1", recs5.length === 1);
    const rep5 = await replayDecision(recs5[0], emb);
    ok("R5.2 端到端重放判定通过", rep5.pass, `sim=${rep5.sim.toFixed(3)}`);
    // 旧值不再 active（R1 下界）
    const activeOld = db.prepare(`SELECT COUNT(*) c FROM memories WHERE id=? AND status='active'`).get(o5).c;
    ok("R5.3 保留新后旧值不再 active", activeOld === 0);
    db.close();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(jsonl, { force: true });
}
catch (e) {
    FAIL++;
    console.error("  ❌ smoke-regress 异常：", e);
}
console.log(`\n[smoke-regress] PASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL > 0 ? 1 : 0);
