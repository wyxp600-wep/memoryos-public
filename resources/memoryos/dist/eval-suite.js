/**
 * MemoryOS P0-C（2026-10-13）：检索评测集框架
 * 用途：量化"检索改得对不对"——每次改 hybridSearch / sector / 衰减策略后跑一遍，
 *       看 recall@k / precision@k 是否退化。
 * 数据：eval_queries 表（query → 期望命中 memory_id 列表，JSON）
 * 用法：
 *   node dist/eval-suite.js          -- 跑全部 eval_queries，输出报告
 *   node dist/eval-suite.js --add    -- 从 memory_usage 历史 search 事件自动采样候选
 */
import { openDb } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runEvalSuite(db, embedder, limit = 10) {
    embedder = await embedder;
    if (typeof embedder?.embedTexts !== "function") throw new Error("评测需要可用embedder，不能静默以无向量结果冒充完整评测");
    const queries = db.prepare(`SELECT * FROM eval_queries ORDER BY id`).all();
    if (!queries.length)
        return { total: 0, note: "eval_queries 为空，请先插入评测用例" };

    const results = [];
    for (const q of queries) {
        let expected;
        try {
            expected = new Set(JSON.parse(q.expected_ids));
        }
        catch {
            throw new Error(`评测用例 #${q.id} expected_ids不是合法JSON数组`);
        }
        if (!Array.isArray(JSON.parse(q.expected_ids))) throw new Error(`评测用例 #${q.id} expected_ids必须为数组`);
        const hits = await hybridSearch(db, embedder, {
            query: q.query,
            project: q.project || "global",
            limit, relRatio: 0.5, simFloor: 0.76,
        });
        const hitIds = (hits ?? []).map((h) => h.id);
        const tp = hitIds.filter((id) => expected.has(id)).length;
        results.push({
            query_id: q.id,
            query: q.query,
            recall: expected.size ? tp / expected.size : (hitIds.length===0?1:0),
            no_answer: expected.size===0,
            reciprocal_rank: expected.size ? (hitIds.findIndex(id=>expected.has(id))<0?0:1/(hitIds.findIndex(id=>expected.has(id))+1)) : null,
            precision: hitIds.length ? tp / hitIds.length : (expected.size?0:1),
            top_hit: hitIds[0] ?? null,
            expected: [...expected],
            got: hitIds,
        });
    }
    const avg = (arr, fn) => (arr.length ? arr.reduce((a, r) => a + fn(r), 0) / arr.length : 0);
    return {
        total: queries.length,
        avg_recall: Math.round(avg(results.filter(r=>!r.no_answer), (r) => r.recall) * 1000) / 1000,
        avg_precision: Math.round(avg(results.filter(r=>!r.no_answer), (r) => r.precision) * 1000) / 1000,
        mrr: avg(results.filter(r=>!r.no_answer),r=>r.reciprocal_rank),
        no_answer_cases: results.filter(r=>r.no_answer).length,
        no_answer_accuracy: results.some(r=>r.no_answer)?avg(results.filter(r=>r.no_answer),r=>r.recall):null,
        per_case: results,
        worst: [...results].sort((a, b) => a.recall - b.recall).slice(0, 5),
        per_query: results.map((r) => ({ id: r.query_id, recall: r.recall, precision: r.precision, top_hit: r.top_hit })),
    };
}

/**
 * 从历史 memory_usage.search 事件自动采样 eval 候选（供人工 review 后写入 eval_queries）。
 * 规则：取近期被返回（returned）的记忆，反查其 session 的 search query，
 * 若该 query 确实返回了这些记忆 → 生成一条候选。
 */
export function sampleEvalCandidates(db, { days = 30, limit = 20 } = {}) {
    const rows = db
        .prepare(`SELECT u.session_id, u.task_hint
       FROM memory_usage u
       WHERE u.event='search'
         AND julianday(u.created_at) >= julianday('now', ?)
       GROUP BY u.session_id, u.task_hint
       HAVING COUNT(*) >= 1
       ORDER BY MAX(u.created_at) DESC
       LIMIT ?`)
        .all(`-${days} days`, limit);
    return rows;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith("eval-suite.js")) {
    const dbPath=process.env.MEMORY_DB ?? (process.env.APPDATA ? path.join(process.env.APPDATA,"MemoryOS/data/memory.db") : path.join(__dirname,"../data/memory.db"));
    const db = openDb(dbPath);
    const embedder = await getEmbedder();
    const mode = process.argv.includes("--add") ? "add" : "run";
    if (mode === "add") {
        const cands = sampleEvalCandidates(db);
        if (!cands.length) {
            console.log("无候选（近 30 天无 search 埋点）");
            process.exit(0);
        }
        console.log(`候选 ${cands.length} 条，请人工 review 后 INSERT INTO eval_queries`);
        cands.forEach((c, i) =>
            console.log(`  ${i + 1}. session=${c.session_id} task_hint=${c.task_hint ?? "(无)"}`)
        );
    }
    else {
        const result = await runEvalSuite(db, embedder);
        if (result.note) {
            console.log(result.note);
        }
        else {
            console.log(`评测集：${result.total} 条用例`);
            console.log(`  平均 recall    = ${result.avg_recall}`);
            console.log(`  平均 precision = ${result.avg_precision}`);
            if (result.worst.length) {
                console.log("最弱 5 条：");
                for (const w of result.worst)
                    console.log(`  query#${w.id} recall=${w.recall} precision=${w.precision} top=${w.top_hit ?? "null"}`);
            }
        }
    }
}
