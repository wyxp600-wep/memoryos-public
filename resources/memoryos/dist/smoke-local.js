import { openDb, writeMemory } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder, embedMode } from "./embed.js";
import { installMemoryBodyGuard } from "./memory-body.js";
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
if (embedMode() !== "local") {
    console.error("需要 EMBED_MODE=local（BGE-M3）才跑本冒烟，当前=" + embedMode());
    process.exit(1);
}
const emb = await getEmbedder();
ok("L1 加载本地模型", emb.mode === "local" && emb.dim > 0, `mode=${emb.mode} dim=${emb.dim}`);
const db = openDb(":memory:");
/* ★ 2026-10-18（DeepSeek 收尾 P1-B）：临时库同样装上智能体上传的五字段门禁触发器。
 *   原实现不装门禁 → 旧式散文夹具能写入 → 测试看似通过，实际未覆盖生产门禁；
 *   一旦生产库装了触发器（memory_body_v1_insert/update），同一夹具会被 ABORT。装上后
 *   夹具必须五字段合规才算通过，测试才与生产同口径（不是靠关掉门禁来过关）。 */
installMemoryBodyGuard(db);
const w = async (content, type = "experience") => writeMemory(db, { content, type, agent: "local-smoke", agent_fpath: null, project: "global", embedding: (await emb.embedTexts([content]))[0] });
/* ★ 2026-10-18：夹具改五字段合规正文（原三主题不变：连接池→网络排查 / 时钟漂移容差 / 80 端口 W3SVC）。
 *   保留原主题句作「结论」行以维持跨表述语义，其余四行只做格式合规填充，不新增事实主张。 */
const S = [
    "结论：\n数据库连接超时：检查连接池与网络防火墙配置。\n\n关键词：\nMemoryOS；本地向量；检索回归\n\n适用范围：\n关系型数据库直连或经连接池访问的排查场景。\n\n依据：\n本冒烟夹具，源自原检索主题句，仅用于跨表述语义检索回归，不构成事实主张。\n\n行动：\n再次遇到数据库连接超时，先看连接池占用，再查网络与防火墙放行规则。\n\n状态：\n待验证；最后核验日期：2026-10-18。",
    "结论：\n时间戳容差设为 5 分钟以容忍时钟漂移。\n\n关键词：\nMemoryOS；本地向量；检索回归\n\n适用范围：\n跨主机做时间戳校验的场景。\n\n依据：\n本冒烟夹具，源自原检索主题句，仅用于跨表述语义检索回归，不构成事实主张。\n\n行动：\n再次遇到时间戳校验失败，先核对两端时钟漂移与容差设置。\n\n状态：\n待验证；最后核验日期：2026-10-18。",
    "结论：\n端口 80 常被 IIS 占用，先查 W3SVC 服务状态。\n\n关键词：\nMemoryOS；本地向量；检索回归\n\n适用范围：\nWindows 本机 HTTP/IIS 共存的排查场景。\n\n依据：\n本冒烟夹具，源自原检索主题句，仅用于跨表述语义检索回归，不构成事实主张。\n\n行动：\n再次遇到 80 端口冲突，先查 W3SVC 服务状态，再迁移站点绑定。\n\n状态：\n待验证；最后核验日期：2026-10-18。",
];
for (const s of S)
    await w(s);
for (const [q, targetIdx, label] of [
    ["网络不通导致连接慢，怎么排查", 0, "数据库连接→网络排查"],
    ["时钟不同步引起的校验失败", 1, "时间戳容差→时钟漂移"],
    ["W3SVC 服务占用端口 80", 2, "占用80→W3SVC"],
]) {
    const hits = await hybridSearch(db, emb, { query: q, project: "global", limit: 5 });
    const topContent = hits[0]?.content ?? "";
    const hit = hits.some((h) => h.content === S[targetIdx]);
    ok(`L2 跨表述语义命中「${label}」`, hit, `topIdx=${S.indexOf(topContent)} score=${hits[0]?.score.toFixed(4)}`);
}
// 语义排序应优于随机：命中条出现在前 40%
const [q2, t2] = ["网络不通连接慢", 0];
const hits2 = await hybridSearch(db, emb, { query: q2, project: "global", limit: 5 });
const pos = hits2.findIndex((h) => h.content === S[t2]);
ok("L3 目标条在前40%（语义排序有效）", pos >= 0 && pos <= Math.ceil(hits2.length * 0.4) - 1, `pos=${pos}`);
db.close();
console.log(`\n[smoke-local] PASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL > 0 ? 1 : 0);
