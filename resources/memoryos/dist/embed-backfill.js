#!/usr/bin/env node
/** ★ 一致性⑥（2026-09-19）：向量体检 + 补嵌 —— 「假向量换真向量」的核查与搬运工具。
 *
 *  体检（默认，只读）：全库逐条分类 ——
 *    real    真向量（与「同内容重算的 fake 确定性向量」cosine ≤ 0.99）
 *    fake    假向量（fake 为字符对哈希、同内容必复现，故重算比对 cosine > 0.99 即判定）
 *    missing 无向量孤儿（FTS 可见、语义检索不可见）
 *    stale   正文已编辑但向量未跟（embedding_stale=1）
 *
 *  回填（--apply）：对 fake/missing/stale 三类重新嵌入并清 stale 标记（withTx 批次原子写）。
 *  幂等：回填完成的行自动退出工作清单 —— 中断后重跑即续传。
 *
 *  纪律：EMBED_MODE=fake（默认）时直接拒绝运行 —— 绝不以伪向量覆盖真向量（半真半假比全假更糟）。
 *  推荐经内核共享端点跑（Electron 已常驻 bge-m3，本脚本零模型内存）：
 *    EMBED_MODE=api EMBED_API_URL=http://127.0.0.1:8787/v1/embeddings EMBED_API_KEY=<data/token> \
 *      node dist/embed-backfill.js          # 体检报告
 *      node dist/embed-backfill.js --apply  # 回填 + 自动复检
 *  选项：--batch N（默认 20）｜--allow-fake（仅供临时库冒烟测试，生产禁用）
 */
import { openDb, upsertVector, withTx, logDaemon } from "./db.js";
import { getEmbedder, cosine, bufToVec, embedderProvenance } from "./embed.js";
import { fileURLToPath } from "node:url";

function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
/** 与 embed.js FakeEmbedder 同构的确定性伪向量（判定「库里这条是不是 fake 产的」用） */
function fakeVec(t, dim = 1024) {
    const v = new Float32Array(dim);
    for (let i = 0; i < t.length - 1; i++)
        v[hash(`${t[i]}${t[i + 1]}`) % dim] += 1;
    if (t.length === 1)
        v[hash(t) % dim] = 1;
    let n = 0;
    for (let i = 0; i < v.length; i++)
        n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++)
        v[i] /= n;
    return v;
}

const APPLY = process.argv.includes("--apply");
const ALLOW_FAKE = process.argv.includes("--allow-fake");
const bi = process.argv.indexOf("--batch");
const BATCH = Math.max(1, bi >= 0 ? Number(process.argv[bi + 1]) || 20 : 20);
const mode = (process.env.EMBED_MODE ?? "fake").toLowerCase();
if (mode === "fake" && !ALLOW_FAKE) {
    console.error("✋ 拒绝运行：当前 EMBED_MODE=fake（默认）——绝不以伪向量体检产出/覆盖数据（⑥纪律）。");
    console.error("   推荐经内核共享端点：EMBED_MODE=api EMBED_API_URL=http://127.0.0.1:8787/v1/embeddings EMBED_API_KEY=<data/token> node dist/embed-backfill.js");
    process.exit(1);
}
const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));
const db = openDb(dbPath);
const norm = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

// —— 1) 体检分类 ——
const rows = db.prepare(`SELECT m.id, m.content, m.embedding_stale, v.embedding FROM memories m LEFT JOIN memory_vectors v ON v.memory_id = m.id ORDER BY m.id`).all();
const need = [];
let real = 0, fake = 0, missing = 0, staleReal = 0;
for (const r of rows) {
    const content = norm(r.content);
    if (!r.embedding) {
        missing++;
        need.push({ id: Number(r.id), content, why: "missing" });
        continue;
    }
    if (cosine(bufToVec(r.embedding), fakeVec(content)) > 0.99) {
        fake++;
        need.push({ id: Number(r.id), content, why: "fake" });
        continue;
    }
    real++;
    if (Number(r.embedding_stale) === 1) {
        staleReal++;
        need.push({ id: Number(r.id), content, why: "stale" });
    }
}
console.log(`[体检] 共 ${rows.length} 条：真向量 ${real}｜假向量 ${fake}｜缺失 ${missing}｜真但正文已改 ${staleReal}｜待处理 ${need.length}`);
for (const why of ["fake", "missing", "stale"]) {
    const ids = need.filter((n) => n.why === why).map((n) => `#${n.id}`).join(" ");
    if (ids)
        console.log(`  ${why}: ${ids}`);
}
if (!APPLY) {
    console.log(`（只读体检。确认清单无误后加 --apply 回填；EMBED_MODE=api 经内核端点，或 Electron 侧 local 直跑）`);
    process.exit(0);
}

// —— 2) 回填 ——
if (!need.length) {
    console.log(`✅ 无待回填 —— 语料已是纯真向量。`);
    process.exit(0);
}
const embedder = await getEmbedder();
if (embedder.mode === "fake" && !ALLOW_FAKE) {
    console.error("✋ embedder 仍为 fake（--allow-fake 仅供临时库测试），拒绝回填真实库。");
    process.exit(1);
}
console.log(`[回填] embedder=${embedder.mode} 模型=${embedder.modelName ?? "-"} 待处理 ${need.length} 条（batch=${BATCH}）`);
const prov = embedderProvenance(); // ★ 2026-10-15：向量带出处
const clearStale = db.prepare(`UPDATE memories SET embedding_stale=0 WHERE id=?`);
let done = 0, failed = 0;
for (let i = 0; i < need.length; i += BATCH) {
    const slice = need.slice(i, i + BATCH);
    try {
        const vecs = await embedder.embedTexts(slice.map((s) => s.content));
        withTx(db, () => {
            for (let j = 0; j < slice.length; j++) {
                upsertVector(db, slice[j].id, vecs[j], { model: prov.model, dim: prov.dim });
                clearStale.run(slice[j].id);
            }
        });
        done += slice.length;
        console.log(`  进度 ${Math.min(i + slice.length, need.length)}/${need.length}`);
    }
    catch (e) {
        failed += slice.length;
        console.error(`  批次失败（${e instanceof Error ? e.message : String(e)}）—— 重跑 --apply 即续传`);
    }
    await new Promise((r) => setTimeout(r, 150)); // 温和限速：给并发业务进程让路
}

// —— 3) 复检 ——
let left = 0;
for (const s of need) {
    const v = db.prepare(`SELECT embedding FROM memory_vectors WHERE memory_id=?`).get(s.id);
    if (!v || cosine(bufToVec(v.embedding), fakeVec(s.content)) > 0.99)
        left++;
}
logDaemon(db, { task: "embed-backfill", op: "apply", detail: `共 ${rows.length}：real=${real} fake=${fake} missing=${missing} stale=${staleReal}；回填成功 ${done} 失败 ${failed}；复检残留 ${left}` });
console.log(`[复检] 回填成功 ${done}｜失败 ${failed}｜残留疑似非真向量 ${left} 条${left === 0 && failed === 0 ? " —— ✅ 语料纯真向量" : "（重跑 --apply 即续传）"}`);
