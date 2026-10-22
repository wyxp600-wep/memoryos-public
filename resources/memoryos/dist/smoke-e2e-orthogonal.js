/**
 * orthogonalContrib 端到端自检 —— 走完整 hybridSearch 链路（写入→语义路→正交重排→RRF→过滤→回血）
 * 用确定性 mock embedder（不依赖真实 BGE，可复现）：
 *   query "q" 恒返回 [1,0]（dim=2）
 * 记忆（writeMemory 直接塞确定性向量，绕过 server 层 dedupeDecision，专注验证检索侧去重）：
 *   a = [1,0]       原始记忆（cos=1.0）
 *   b = [1,0]       完全同向重复（cos=1.0）
 *   c = [0.95,0.312] 0.95 相似重复（cos≈0.95，单位向量）
 * 断言：
 *   E1 链路跑通：hybridSearch 返回 active 结果
 *   E2 排序：原始 a 排最前、score 最高
 *   E3 正交化贡献：a=1、b=0、c=0（重复/近似重复被压，不挤占独立名额）
 *   E4 命中回血：返回记忆 hit_count≥1 且 last_hit_at 已写
 * 用法：node dist/smoke-e2e-orthogonal.js
 */
import { openDb, writeMemory, getVectorsOnProject } from "./db.js";
import { hybridSearch, orthogonalContrib } from "./search.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const DIM = 2;
// mock embedder：query 统一返回 e1 方向（dim 与写入向量一致）
const mock = {
    dim: DIM,
    mode: "fake",
    async embedTexts(_texts) {
        return _texts.map(() => Float32Array.from([1, 0]));
    },
};
const dbPath = path.join(os.tmpdir(), `mem-e2e-ortho-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
try {
    const db = openDb(dbPath);
    const a = writeMemory(db, {
        content: "并发写库锁竞争，用 withTx 重试",
        type: "pitfall",
        agent: "trae",
        agent_fpath: null,
        project: "global",
        embedding: Float32Array.from([1, 0]),
    });
    const b = writeMemory(db, {
        content: "并发写库锁竞争，用 withTx 重试（同义重复）",
        type: "pitfall",
        agent: "trae",
        agent_fpath: null,
        project: "global",
        embedding: Float32Array.from([1, 0]),
    });
    const c = writeMemory(db, {
        content: "并发写库锁竞争（相似但不同措辞）",
        type: "pitfall",
        agent: "trae",
        agent_fpath: null,
        project: "global",
        embedding: Float32Array.from([0.95, 0.3122]),
    });
    // E1/E2/E3：走完整混合检索链路
    const hits = await hybridSearch(db, mock, { query: "q", project: "global", limit: 10 });
    check("E1.链路跑通返回 active 结果", hits.length >= 1, `hits=${hits.length}`);
    check("E2.原始 a 排最前（score 最高）", hits[0]?.id === Number(a.id), `top id=${hits[0]?.id} (期望 ${a.id})`);
    // E3：正交化贡献（用与 hybridSearch 内部相同的 getVectorsOnProject 读回向量）
    const existing = getVectorsOnProject(db, "global");
    const qv = Float32Array.from([1, 0]);
    const contrib = orthogonalContrib(qv, existing);
    const byId = new Map(contrib.map((x) => [x.id, x.contrib]));
    const contribA = byId.get(Number(a.id)) ?? -1;
    const contribB = byId.get(Number(b.id)) ?? -1;
    const contribC = byId.get(Number(c.id)) ?? -1;
    check("E3.重复/近似重复被压（a≈1、b≈0、c≈0）", contribA > 0.9 && contribB < 1e-6 && contribC < 0.1, `a=${contribA.toFixed(3)} b=${contribB.toFixed(3)} c=${contribC.toFixed(3)}`);
    // E4：命中回血
    const bumped = db
        .prepare(`SELECT COUNT(*) c FROM memories WHERE id IN (?,?,?) AND hit_count>=1 AND last_hit_at IS NOT NULL`)
        .get(Number(a.id), Number(b.id), Number(c.id));
    check("E4.返回记忆命中回血（hit_count≥1 + last_hit_at）", bumped.c === hits.length && bumped.c >= 1, `回血 ${bumped.c} 条`);
    db.close();
}
finally {
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
        try {
            fs.rmSync(p, { force: true });
        }
        catch {
            /* ignore */
        }
    }
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
