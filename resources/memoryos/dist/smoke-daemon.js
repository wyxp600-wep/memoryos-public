/**
 * MemoryOS v0.3 — daemon 冒烟（M-2.1 + M-2.2）
 * 用 fake embed（确定性伪向量）测机制：
 *   D1 computeDecay：decision 不衰减；常规记忆随时间衰减
 *   D2 computeArchives：eff<0.1 或 45 天无曝光 → 归档候选
 *   D3 computeDedupes：sim>0.96 合并，winner=命中多者，跨来源 conf+0.1
 *   D4 dry-run：applyPlan(dryRun=true) 不落库（无归档/无 daemon_log/去重不生效）
 *   D5 once：applyPlan(dryRun=false) 落库 → 归档 + daemon_log + merged
 *   D6 M-2.2：eff≤0.15 的 active 记忆不再被 hybridSearch 召回
 * 用法：node dist/smoke-daemon.js
 */
import { openDb, writeMemory, daemonLogCount, writeConfig } from "./db.js";
import { buildPlan, applyPlan, loadHygieneConfig, DEFAULT_HYGIENE_CONFIG } from "./daemon.js";
import { hybridSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `memoryos-smoke-daemon-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
try {
    const db = openDb(dbPath);
    const emb = await getEmbedder();
    // 种子：高置信的旧决策 + 常规记忆（60 天前、0 命中 → 应归档）+ 重复对
    const w = async (content, type, agent, project = "ecommerce") => writeMemory(db, {
        content,
        type,
        agent,
        agent_fpath: null,
        project,
        embedding: (await emb.embedTexts([content]))[0],
    });
    // ① 旧常规记忆（60 天前，无命中）→ eff 会低，应归档
    const old = await w("一个长期无人读的旧经验缓存清理方案", "experience", "codex");
    db.prepare(`UPDATE memories SET created_at = datetime('now','-60 days') WHERE id=?`).run(old.id);
    // ② 高命中常规记忆，被读取过 → 半衰期延长，不应归档
    const hot = await w("订单状态机迁移到 Redis 存储方案", "experience", "codex");
    db.prepare(`UPDATE memories SET hit_count=20, last_hit_at=datetime('now','-2 days') WHERE id=?`).run(hot.id);
    // ③ decision：不应衰减（eff=conf）
    const dec = await w("网关路由采用按服务名路由策略", "decision", "codex");
    db.prepare(`UPDATE memories SET confidence=0.9, created_at=datetime('now','-60 days') WHERE id=?`).run(dec.id);
    // ④⑤ 重复对：同内容，不同 agent，④ 命中多 → winner
    const dupA = await w("微信回调时间戳容差需设5分钟（时钟偏差）", "experience", "codex");
    const dupB = await w("微信回调时间戳容差需设5分钟（时钟偏差）", "experience", "claude");
    db.prepare(`UPDATE memories SET hit_count=10 WHERE id=?`).run(dupA.id);
    db.prepare(`UPDATE memories SET hit_count=1 WHERE id=?`).run(dupB.id);
    const plan = buildPlan(db);
    // D1/D2/D3 计划
    check("D1.decision 不衰减（eff=salience，60 天不贬损）", plan.decays.find((x) => x.id === dec.id)?.eff === db.prepare("SELECT salience FROM memories WHERE id=?").get(dec.id).salience, `eff=${plan.decays.find((x) => x.id === dec.id)?.eff}`);
    check("D1.常规旧记忆 eff 被压低", (plan.decays.find((x) => x.id === old.id)?.eff ?? 1) < 0.5);
    check("D2.旧记忆进归档候选", plan.archives.some((a) => a.id === old.id), `archives=${plan.archives.map((a) => `#${a.id}`).join(",")}`);
    const dup = plan.dedupes.find((d) => d.winner === dupA.id && d.loser === dupB.id);
    check("D3.重复对命中多者为 winner", !!dup, dup ? `sim=${dup.sim.toFixed(3)}` : "未找到");
    // 归档不应包含高命中 hot（eff 高、有曝光）——但 exception 用 eff，hot 也应算。归档候选里不应有 hot：
    check("D2.高命中 hot 不进归档", !plan.archives.some((a) => a.id === hot.id));
    // D4：dry-run 不落库
    const archBefore = db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='archived'`).get();
    const logBefore = daemonLogCount(db);
    const beforeRows = db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='merged'`).get().c;
    applyPlan(db, plan, true);
    check("D4.dry-run 不归档、不留痕、不去重", archBefore.c === db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='archived'`).get().c &&
        logBefore === daemonLogCount(db) &&
        beforeRows === db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='merged'`).get().c, `arch=${archBefore.c}, log=${logBefore}`);
    // D5：真跑——归档 + 留痕 + merged
    applyPlan(db, plan, false);
    check("D5.once 归档旧记忆", db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='archived'`).get().c === 1);
    check("D5.daemon_log 有 archive 留痕", daemonLogCount(db, "archive", "archive") === 1, `log=${daemonLogCount(db, "archive", "archive")}`);
    check("D5.去重 loser 已 merged", db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='merged'`).get().c === 1);
    // D7：记忆卫生配置可覆盖（config 表覆盖后 buildPlan 反映新阈值）
    check("D7.缺省配置与 DEFAULT 一致", JSON.stringify(loadHygieneConfig(db)) === JSON.stringify(DEFAULT_HYGIENE_CONFIG));
    writeConfig(db, "hygiene", { ...DEFAULT_HYGIENE_CONFIG, archiveEff: 0.99 }); // 抬高归档阈值 → hot 也应进候选
    check("D7.writeConfig 后读到新值", loadHygieneConfig(db).archiveEff === 0.99);
    const plan2 = buildPlan(db);
    check("D7.归档阈值可配置：0.99 使 hot 进归档候选", plan2.archives.some((a) => a.id === hot.id), `plan2.archives=${plan2.archives.map((a) => `#${a.id}`).join(",")}`);
    check("D7.未覆盖字段走默认（dedupeSim）", loadHygieneConfig(db).dedupeSim === DEFAULT_HYGIENE_CONFIG.dedupeSim);
    // D6：M-2.2 —— 显著性压到 ≤0.15 后不应再被召回
    // ★ 2026-09-15 修正：检索侧自 M9 起**查询时现算** eff = salience × e^(-λ·Δt)（search.js:142-149），
    //   不再读 eff_confidence 列 —— 旧断言只改 eff_confidence 已无法影响召回，属陈旧断言而非产品回归。
    db.prepare(`UPDATE memories SET salience=0.10, last_seen_at=datetime('now') WHERE id=?`).run(hot.id);
    const hits = await hybridSearch(db, emb, { query: "订单状态机 Redis", project: "ecommerce", limit: 10 });
    check("D6.eff≤0.15 的 active 不再被召回", !hits.some((h) => h.id === hot.id), `returned=${hits.map((h) => `#${h.id}`).join(",")}`);
    // D8：decision 类记忆超期不自动归档（2026-09-15 回归修复的守护断言：
    //     该豁免曾在 sector/salience 重构中被 pinned 判断取代而丢失，见 daemon.js computeArchives 注释）
    db.prepare(`UPDATE memories SET status='active', created_at=datetime('now','-200 days'), hit_count=0 WHERE id=?`).run(dec.id);
    const archivedDec = buildPlan(db).archives.some((a) => a.id === dec.id);
    check("D8.decision 超期 200 天不进归档候选", !archivedDec, `dec.type=${db.prepare("SELECT type FROM memories WHERE id=?").get(dec.id)?.type}`);
    // 对照：同条件的 experience 必须仍被归档（防"豁免写宽了"造成漏归档）
    db.prepare(`UPDATE memories SET status='active', created_at=datetime('now','-200 days'), hit_count=0, last_seen_at=NULL WHERE id=?`).run(old.id);
    check("D8.对照：同条件 experience 仍进归档候选", buildPlan(db).archives.some((a) => a.id === old.id));
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
