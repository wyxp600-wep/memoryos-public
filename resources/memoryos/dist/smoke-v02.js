/**
 * MemoryOS v0.2 冒烟自检（M-1.3 去重/冲突预检 + M-1.4 混合检索）
 * 统一用 fake embed（确定性伪向量）测机制，不引入真实语义。
 *   D1 dedupeDecision 单元：同向量→merge；正交→insert；0.9 相似→conflict
 *   D2 写入管线：同内容二次写 → 命中 merge（不改变置信度、不计新行）
 *   D3 混合检索：语义路召回 + RRF 融合出分 + 命中回血(hit_count+1, last_hit_at)
 *   C2 截断契约（2026-10-03 批次C2）：hybridSearch 返回数组上的 _searchStats（semSliced/limitSliced/degraded）
 * 用法：node dist/smoke-v02.js
 */
import { openDb, writeMemory, dedupeDecision, getVectorsOnProject, readMemory } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `memoryos-smoke-v02-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
function vecOf(...xs) {
    // 直接把给定坐标塞进 RUNTIME_DIM 尺寸的同维向量（其余为 0），用于单元测试确定性
    const dim = 1024;
    const v = new Float32Array(dim);
    const norm = Math.sqrt(xs.reduce((s, x) => s + x * x, 0)) || 1;
    xs.forEach((x, i) => (v[i] = x / norm));
    return v;
}
try {
    const db = openDb(dbPath);
    // —— D1: dedupeDecision 单元（确定性向量，不依赖 embedder）——
    const e0 = getVectorsOnProject(db, "ut"); // 空
    const same = dedupeDecision([{ id: 1, vec: vecOf(1) }], vecOf(1), -1);
    check("D1.同向量 → merge(≥0.92)", same.action === "merge", `action=${same.action} sim=${same.sim.toFixed(3)}`);
    const orth = dedupeDecision([{ id: 1, vec: vecOf(1) }], vecOf(0, 1), -1);
    check("D1.正交向量 → insert", orth.action === "insert", `action=${orth.action} sim=${orth.sim.toFixed(3)}`);
    const mid = dedupeDecision([{ id: 1, vec: vecOf(1) }], vecOf(0.9, 0.435), -1);
    check("D1.0.9 相似 → conflict(0.85~0.92)", mid.action === "conflict", `action=${mid.action} sim=${mid.sim.toFixed(3)}`);
    const exact = dedupeDecision([{ id: 1, vec: vecOf(1) }], vecOf(1), -1);
    check("D1.完全同构 → merge（尺寸同 D1 第1项，防误改）", exact.action === "merge");
    // —— D2: 写入管线（fake embed）—— 同内容二次写应 merge，不新增行
    const embedder = await getEmbedder(); // EMBED_MODE 默认 fake
    const content = "微信回调时间戳容差需设5分钟（签名校验常因时钟偏差误报超时）";
    const [emb] = await embedder.embedTexts([content]);
    writeMemory(db, {
        content,
        type: "experience",
        agent: "codex",
        agent_fpath: "C:/Users/zhang/.codex/config.toml",
        project: "ecommerce",
        embedding: emb,
    });
    const before = db.prepare("SELECT COUNT(*) c FROM memories WHERE project='ecommerce'").get().c;
    // 复刻 server.memory_write 的去重/冲突预检段（同源逻辑）
    const existing = getVectorsOnProject(db, "ecommerce");
    const d = existing.length
        ? dedupeDecision(existing, emb, -1)
        : { action: "insert", targetId: null, sim: -1 };
    const after = db.prepare("SELECT COUNT(*) c FROM memories WHERE project='ecommerce'").get().c;
    check("D2.同内容二次写 → 判定 merge", d.action === "merge" && d.targetId === 1, `action=${d.action} target=${d.targetId}`);
    check("D2.merge 不新增行", after === before, `rows ${before}→${after}`);
    // —— D3: 混合检索 + 命中回血 ——
    await writeMemory(db, {
        content: "订单状态机迁移到 Redis 存储，放弃 DB 主键自增作为超时判据",
        type: "decision",
        agent: "codex",
        agent_fpath: "C:/Users/zhang/.codex/config.toml",
        project: "ecommerce",
        embedding: (await embedder.embedTexts(["订单状态机迁移到 Redis 存储，放弃 DB 主键自增作为超时判据"]))[0],
    });
    const hits = await hybridSearch(db, embedder, { query: "订单状态机迁移到Redis存储", project: "ecommerce", limit: 10 });
    check("D3.混合检索召回到订单状态机记忆（语义路出分）", hits.some((h) => h.id === 2 && h.score > 0), `hits=${hits.map((h) => `${h.id}(s=${h.score.toFixed(3)})`).join(",")}`);
    const r2 = readMemory(db, 2);
    check("D3.命中回血：hit_count+1 且 last_hit_at 已更新", r2.hit_count === 1 && !!r2.last_hit_at, `hit_count=${r2.hit_count}, last_hit_at=${r2.last_hit_at}`);
    // —— C2（批次C2 截断契约扩面）：hybridSearch 返回数组上的 _searchStats 契约 ——
    check("C2a.无截断场景 → limitSliced=false 且 returned=preLimit（零回归基线）", hits._searchStats?.limitSliced === false && hits._searchStats.returned === hits._searchStats.preLimit, JSON.stringify(hits._searchStats));
    // 造「候选远多于 limit」的池：45 条同向量记忆（mock embed 恒返回同一向量 → 全部 sim=1 入选）
    const fixedVec = vecOf(1);
    const mock = { embedTexts: async (ts) => ts.map(() => fixedVec) };
    for (let i = 0; i < 45; i++)
        await writeMemory(db, {
            content: `C2 候选池样例记忆 ${i}（验证语义粗筛截断可观测）`,
            type: "experience",
            agent: "codex",
            agent_fpath: "C:/Users/zhang/.codex/config.toml",
            project: "c2pool",
            embedding: fixedVec,
        });
    const poolHits = await hybridSearch(db, mock, { query: "候选池", project: "c2pool", limit: 1 });
    check("C2b.候选多于 limit → limitSliced=true 且 preLimit>returned", poolHits._searchStats?.limitSliced === true && poolHits._searchStats.preLimit > poolHits._searchStats.returned, JSON.stringify(poolHits._searchStats));
    check("C2c.语义候选池>topK → semSliced=true 且 semPool>semTopK", poolHits._searchStats?.semSliced === true && poolHits._searchStats.semPool > poolHits._searchStats.semTopK, JSON.stringify(poolHits._searchStats));
    // C2d：嵌入抛错 → 降级信息随本次返回值带出（不再只靠模块级单槽，修「双 scope 只报最后一次」）
    const boom = { embedTexts: async () => { throw new Error("C2 模拟嵌入失败"); } };
    const degHits = await hybridSearch(db, boom, { query: "候选池", project: "c2pool", limit: 5 });
    check("C2d.嵌入失败 → _searchStats.degraded 随返回值带出", !!degHits._searchStats?.degraded?.msg, degHits._searchStats?.degraded?.msg ?? "(空)");
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
