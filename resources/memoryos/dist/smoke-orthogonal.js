/**
 * orthogonalContrib 单元自检（确定性向量，不依赖 embedder）
 * 用例：
 *  O1 同向量两条 → 第二条贡献≈0（同质重复被压）
 *  O2 正交向量两条 → 各有独立贡献，均不归零
 *  O3 0.95 相似两条 → 相似的那条贡献被压（正交剥离后无独立分量）
 * 用法：node dist/smoke-orthogonal.js
 */
import { orthogonalContrib } from "./search.js";
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
const f = (xs) => Float32Array.from(xs);
// O1 同向量 → 第二条归零
{
    const q = f([1, 0, 0, 0]);
    const r = orthogonalContrib(q, [
        { id: 1, vec: f([1, 0, 0, 0]) },
        { id: 2, vec: f([1, 0, 0, 0]) },
    ]);
    check("O1.同向量第二条贡献≈0", r[1].contrib < 1e-6 && r[0].contrib > 0.9, `contrib=[${r.map((x) => x.contrib.toFixed(3))}]`);
}
// O2 正交 → 各保留
{
    const q = f([1, 1, 0, 0]);
    const r = orthogonalContrib(q, [
        { id: 1, vec: f([1, 0, 0, 0]) },
        { id: 2, vec: f([0, 1, 0, 0]) },
    ]);
    check("O2.正交向量各有贡献", r.every((x) => x.contrib > 0.9), `contrib=[${r.map((x) => x.contrib.toFixed(3))}]`);
}
// O3 0.95 相似 → 相似被压
{
    const q = f([1, 0, 0, 0]);
    const r = orthogonalContrib(q, [
        { id: 1, vec: f([1, 0, 0, 0]) },
        { id: 2, vec: f([0.95, 0.3122, 0, 0]) },
    ]);
    const id2 = r.find((x) => x.id === 2);
    check("O3.0.95相似的第二条贡献被压", id2.contrib < 0.1, `id2.contrib=${id2.contrib.toFixed(4)}`);
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
