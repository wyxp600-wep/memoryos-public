/**
 * intentDepth + 动态加权单测（确定性输入，不依赖 embedder）
 * 用例：
 *  B1 相似度集中 → logicDepth 高（≈1，聚焦）
 *  B2 相似度分散 → logicDepth 低（≈0，发散）
 *  B3 空/全零 → 中性 0.5
 *  B4 权重方向：聚焦 semW>lexW；发散 semW<lexW；中性≈等权；语义路失败→纯词法(semW=0,lexW=1)
 * 用法：node dist/smoke-boost.js
 */
import { intentDepth } from "./search.js";
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
// 映射公式与 search.js 同源，避免口径漂移
function weights(depth) {
    return { semW: depth === null ? 0 : 0.7 + 0.7 * depth, lexW: depth === null ? 1 : 1.3 - 0.7 * depth };
}
// B1 聚焦：相似度高度集中（一个主导，其余极小）
{
    const d = intentDepth([0.99, 0.05, 0.05, 0.02]);
    check("B1.集中分布 → logicDepth 高", d > 0.6, `logicDepth=${d.toFixed(3)}`);
}
// B2 发散：相似度平铺分散（彼此接近）
{
    const d = intentDepth([0.9, 0.85, 0.8, 0.75]);
    check("B2.分散分布 → logicDepth 低", d < 0.3, `logicDepth=${d.toFixed(3)}`);
}
// B3 边界
{
    const e = intentDepth([]);
    const z = intentDepth([0, 0, 0]);
    check("B3a.空数组 → 中性 0.5", e === 0.5, `got=${e}`);
    check("B3b.全零 → 中性 0.5", z === 0.5, `got=${z}`);
}
// B4 权重方向
{
    const focus = weights(intentDepth([0.99, 0.05, 0.05]));
    const diffuse = weights(intentDepth([0.9, 0.85, 0.8]));
    const mid = weights(intentDepth([0.6, 0.55, 0.5, 0.45])); // 中间态，检查不越界
    const fail = weights(null); // 语义路失败
    check("B4a.聚焦 → semW>lexW", focus.semW > focus.lexW, `semW=${focus.semW.toFixed(3)} lexW=${focus.lexW.toFixed(3)}`);
    check("B4b.发散 → semW<lexW", diffuse.semW < diffuse.lexW, `semW=${diffuse.semW.toFixed(3)} lexW=${diffuse.lexW.toFixed(3)}`);
    check("B4c.中间态权重不越线性端点[semW≥0.7,lexW≥0.6]", mid.semW >= 0.7 && mid.lexW >= 0.6 && focus.semW <= 1.4 && diffuse.lexW <= 1.3, `mid.semW=${mid.semW.toFixed(3)} mid.lexW=${mid.lexW.toFixed(3)}`);
    check("B4e.语义路失败 → 纯词法", fail.semW === 0 && fail.lexW === 1, `semW=${fail.semW} lexW=${fail.lexW}`);
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
