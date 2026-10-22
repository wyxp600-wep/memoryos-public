import { fileURLToPath } from "node:url";
import { openDb, logDaemon, upsertVector } from "./db.js";
import { getEmbedder, vecToBuf, embedMode, embedderProvenance } from "./embed.js";
/** 统计唯一向量数与碰撞条数（hex 指纹去重） */
function collisionStats(rows) {
    const seen = new Set();
    let collision = 0;
    for (const r of rows) {
        if (!r.embedding)
            continue;
        const h = Buffer.from(r.embedding).toString("hex");
        if (seen.has(h))
            collision++;
        else
            seen.add(h);
    }
    return { unique: seen.size, collision };
}
async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));
    const db = openDb(dbPath);
    const rows = db
        .prepare(`SELECT m.id, m.content, v.embedding
       FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.status='active' ORDER BY m.id`)
        .all();
    console.log(`[reembed] active 记忆 ${rows.length} 条，EMBED_MODE=${embedMode()}，dry-run=${dryRun}`);
    const before = collisionStats(rows);
    console.log(`[reembed] 修复前：唯一向量 ${before.unique} / ${rows.length}，碰撞 ${before.collision} 条（${(before.collision / rows.length * 100).toFixed(1)}%）`);
    const embedder = await getEmbedder();
    // 分批重算，避免一次性加载过多文本
    const BATCH = 64;
    const newVecs = new Array(rows.length);
    for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const vecs = await embedder.embedTexts(slice.map((r) => r.content));
        for (let j = 0; j < vecs.length; j++)
            newVecs[i + j] = vecs[j];
        console.log(`[reembed] 重算进度 ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
    const after = collisionStats(rows.map((r, i) => ({ id: r.id, embedding: vecToBuf(newVecs[i]) })));
    console.log(`[reembed] 修复后：唯一向量 ${after.unique} / ${rows.length}，碰撞 ${after.collision} 条（${(after.collision / rows.length * 100).toFixed(1)}%）`);
    if (dryRun) {
        console.log("[reembed] dry-run：未写库。");
        db.close();
        return;
    }
    // ★ P1-2.2：向量写入独立表（upsert 语义，兼容该行尚无向量的情况）
    // ★ 2026-10-15：向量带出处——改用 upsertVector（而非裸 INSERT），随向量一并落 embed_model/dim，
    //   修正历史存量向量的 'unknown' 出处（db.js migrateVectorProvenance 的既定补救路径）。
    const prov = embedderProvenance(); // { model, dim }：随本次重算的真实嵌入模型打标
    db.exec("BEGIN");
    try {
        for (let i = 0; i < rows.length; i++)
            upsertVector(db, rows[i].id, newVecs[i], { model: prov.model, dim: prov.dim });
        // 审计留痕：operator=daemon，task=reembed
        logDaemon(db, {
            task: "reembed",
            op: "vec_update",
            detail: `重算 ${rows.length} 条 active 向量（${embedMode()}，model=${prov.model} dim=${prov.dim}），碰撞 ${before.collision}→${after.collision}`,
            operator: "daemon",
        });
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    console.log(`[reembed] 已写回 ${rows.length} 条向量（含审计留痕）。`);
    db.close();
}
const mainFile = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (mainFile === "reembed.js") {
    main().catch((e) => {
        console.error(`[reembed] 失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
}
