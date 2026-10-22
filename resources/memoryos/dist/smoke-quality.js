/**
 * qualityScore 多因子质量评分单测（确定性，不依赖 DB）
 * 用例：
 *  Q1 完整 decision（新 + 高 conf + 有正文）→ 高分
 *  Q2 碎句过程话（短 + 无结构 + 零命中）→ 低分
 *  Q3 adoption：hit 高 vs 零曝光 → 前者高
 *  Q4 freshness：新 vs 一年前 → 前者高
 *  Q5 权重方向全因子正确合计 + 趋势单调
 * 用法：node dist/smoke-quality.js
 */
import { qualityScore } from "./daemon.js";
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
const NOW = new Date().toISOString();
const YEAR_AGO = new Date(Date.now() - 365 * 86400000).toISOString();
const DAYS_AGO = (d) => new Date(Date.now() - d * 86400000).toISOString();
// Q1 完整决策：type=decision + conf 高 + 正文充分 + 新鲜 + 有命中 → 高分
{
    const s = qualityScore({
        type: "decision",
        confidence: 0.9,
        hit_count: 5,
        created_at: DAYS_AGO(5),
        content: "选 Node 22 而非 20，因为上游 lib 仅支持 ≥22；代价是 CI 镜像需更新。这是实证过的技术决策。",
    });
    check("Q1.完整决策（高conf+命中+新鲜+正文）→ 高分", s > 0.7, `score=${s.toFixed(3)}`);
}
// Q2 碎句过程话：type=experience + conf 低 + 短正文 + 零命中 + 旧 → 低分
{
    const s = qualityScore({
        type: "experience",
        confidence: 0.4,
        hit_count: 0,
        created_at: YEAR_AGO,
        content: "今天调了半天。",
    });
    check("Q2.碎句过程话 → 低分", s < 0.35, `score=${s.toFixed(3)}`);
}
// Q3 adoption：仅 hit 不同，其余相同 → 命中高者分高
{
    const hit = qualityScore({ type: "experience", confidence: 0.8, hit_count: 8, created_at: DAYS_AGO(10), content: "" });
    const zero = qualityScore({ type: "experience", confidence: 0.8, hit_count: 0, created_at: DAYS_AGO(10), content: "" });
    check("Q3.hit 高 → 分高", hit > zero, `hit=${hit.toFixed(3)} zero=${zero.toFixed(3)}`);
}
// Q4 freshness：仅时间不同 → 新的分高
{
    const fresh = qualityScore({ type: "experience", confidence: 0.8, hit_count: 0, created_at: DAYS_AGO(5), content: "" });
    const stale = qualityScore({ type: "experience", confidence: 0.8, hit_count: 0, created_at: YEAR_AGO, content: "" });
    check("Q4.新 → 分高", fresh > stale, `fresh=${fresh.toFixed(3)} stale=${stale.toFixed(3)}`);
}
// Q5 全因子方向 + 兜底
{
    const full = qualityScore({ type: "decision", confidence: 1, hit_count: 5, created_at: NOW, content: "完整结论与依据。".repeat(15) });
    const junk = qualityScore({ type: "experience", confidence: 0, hit_count: 0, created_at: YEAR_AGO, content: "hi" });
    check("Q5a.满档 > 贫档", full > junk, `full=${full.toFixed(3)} junk=${junk.toFixed(3)}`);
    check("Q5b.空 content 不全崩", Number.isFinite(qualityScore({ type: "experience", confidence: 0.5, hit_count: 0, created_at: NOW })), "finite");
    check("Q5c.分数范围 [0,1]", full <= 1 && junk >= 0, `full=${full.toFixed(3)} junk=${junk.toFixed(3)}`);
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
