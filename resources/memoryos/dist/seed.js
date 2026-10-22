/**
 * MemoryOS — 演示种子数据注入（默认库 data/memory.db）
 * 让 Dashboard / daemon / 仲裁队列即刻有内容可看。幂等（已有数据则跳过）。
 * 注入：
 *   高价值 TOP（被 returned/cited + hit 高）、decision、pitfall/convention、
 *   僵尸（0 命中、超期）、一对 possible-conflict（待仲裁）、
 *   近 14 天跨工具埋点（趋势三线 + 漏斗 + 跨工具矩阵）、跑一次 daemon 产生 eff/归档。
 * 用法：node dist/seed.js            （写入默认库，幂等）
 */
import { openDb, writeMemory, logUsage } from "./db.js";
import { buildPlan, applyPlan } from "./daemon.js";
import { getEmbedder } from "./embed.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url)); // fileURLToPath 正确 decode 中文路径
fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // 首次建库需保证目录存在
const db = openDb(dbPath);
console.log(`[seed] dbPath=${dbPath}`);
const exist = db.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
if (exist > 0) {
    console.log(`默认库已有 ${exist} 条记忆，跳过种子注入（如需重灌请删库）。`);
    process.exit(0);
}
const emb = await getEmbedder();
const w = async (content, type, agent, project = "global") => writeMemory(db, { content, type, agent, agent_fpath: null, project, embedding: (await emb.embedTexts([content]))[0] });
/** 埋点后把 created_at 覆盖到 N 天前（trend 三线需要分散日期） */
function usages(memId, writer, reader, event, daysAgo) {
    logUsage(db, { memory_id: memId, event, reader_agent: reader, writer_agent: writer, project: "global", session_id: "seed" });
    db.prepare(`UPDATE memory_usage SET created_at = datetime('now', ?) WHERE id = last_insert_rowid()`).run(`-${daysAgo} days`);
}
// —— 高价值记忆（被跨工具复用 + 高命中） ——
const hot1 = await w("Ozon API /v3/product/info/list 报 400：请求体缺 offer_id（非权限问题）", "experience", "codex");
const hot2 = await w("微信回调时间戳容差需设 5 分钟（时钟偏差）", "experience", "codex");
const hot3 = await w("FTS5 trigram 需 ≥3 字符才命中，短查询要 LIKE 兜底", "pitfall", "codex");
const hot4 = await w("node:sqlite 不能 load_extension，向量用 BLOB 存 + JS 余弦", "pitfall", "gemini");
const hot5 = await w("网关按服务名路由", "decision", "codex");
// —— 决策 & 约定 ——
const dec1 = await w("治理操作单事务执行，全成或全回滚", "decision", "claude");
const dec2 = await w("检索过滤统一 status=active AND eff>0.15", "decision", "codex");
const dec3 = await w("辅助程序收敛为单文件，不散落多个脚本", "convention", "claude");
// —— 僵尸（0 命中、超期） ——
const zombie1 = await w("2019 旧日志导出脚本配置说明", "experience", "codex");
const zombie2 = await w("早期 redis 集群评估记录（已废弃）", "experience", "claude");
const zombie3 = await w("废弃 chrome profile 清理方案 v2", "experience", "gemini");
// —— 一对 possible-conflict（待仲裁） ——
const cOld = await w("数据导出生效策略：导出后再删源文件", "experience", "codex");
const cNew = await w("数据导出生效策略：改为先标记后删除", "experience", "claude");
db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(cOld.id, cNew.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-2 days') WHERE id=?`).run(cNew.id);
// 僵尸置超期（zombie1/2 远超 45 天 → daemon 归档展示 archived；zombie3 34 天保留 active 待展示）
db.prepare(`UPDATE memories SET created_at=datetime('now','-120 days') WHERE id=?`).run(zombie1.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-90 days') WHERE id=?`).run(zombie2.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-34 days') WHERE id=?`).run(zombie3.id);
// 高价值命中态（保留 hot 不归档）
for (const m of [hot1, hot2, hot3, hot4, dec1, dec2, dec3, cOld]) {
    db.prepare(`UPDATE memories SET hit_count=8, last_hit_at=datetime('now','-2 days') WHERE id=?`).run(m.id);
}
db.prepare(`UPDATE memories SET hit_count=6, last_hit_at=datetime('now','-7 days') WHERE id=?`).run(hot5.id);
// —— 近 14 天跨工具埋点：returned/cited，writer≠reader（趋势 + 漏斗 + cross-tool 矩阵） ——
const crossPairs = [
    [hot1.id, "codex", "claude", "returned", 9],
    [hot1.id, "codex", "claude", "cited", 9],
    [hot2.id, "codex", "gemini", "returned", 7],
    [hot2.id, "codex", "gemini", "cited", 7],
    [hot3.id, "codex", "claude", "returned", 5],
    [hot4.id, "gemini", "codex", "returned", 4],
    [hot4.id, "gemini", "codex", "cited", 4],
    [dec1.id, "claude", "gemini", "returned", 3],
    [dec2.id, "codex", "claude", "returned", 2],
    [dec3.id, "claude", "codex", "returned", 2],
    [hot5.id, "codex", "claude", "returned", 6],
    [hot5.id, "codex", "claude", "cited", 6],
];
for (const [id, writer, reader, ev, ago] of crossPairs)
    usages(id, writer, reader, ev, ago);
// 分散的 returned（trend returned 线）
const daysArr = [1, 2, 3, 5, 6, 8, 10, 11, 13];
for (const id of [hot1.id, hot2.id, hot3.id, hot4.id, hot5.id, dec1.id, dec2.id, dec3.id, cOld.id, cNew.id, zombie1.id, zombie2.id])
    usages(id, "codex", "codex", "returned", daysArr[Math.floor(Math.random() * daysArr.length)]);
// —— 跑一次 daemon（once）：产生 eff 衰减 + 僵尸归档留痕 ——
const plan = buildPlan(db);
console.log(applyPlan(db, plan, false));
// —— 汇总 ——
const rows = db.prepare(`SELECT status, COUNT(*) c FROM memories GROUP BY status`).all();
console.log(`种子注入完成，memories=${db.prepare(`SELECT COUNT(*) c FROM memories`).get().c}，分布=${rows.map((r) => `${r.status}:${r.c}`).join("/")}`);
console.log(`待仲裁队列：${db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active' AND conflict_with IS NOT NULL`).get().c} 条`);
console.log(`审计留痕：${db.prepare(`SELECT COUNT(*) c FROM daemon_log`).get().c} 条`);
db.close();
