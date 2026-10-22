/**
 * MemoryOS — 采集 CLI（供桌面壳定时调用 / 计划任务 / 手动跑）
 *
 * 用法：
 *   node dist/ingest-cli.js                     # 全量采集
 *   node dist/ingest-cli.js --incremental       # 增量：只处理 (size,mtime) 变化的源
 *   node dist/ingest-cli.js --incremental --dry # 预演：只报告将处理哪些源，不调 LLM 不写库
 *
 * 环境：MEMORY_DB（库路径）· MIMOS_URL / INGEST_MODEL（LLM 提炼，缺省走 mimo-proxy:18900）
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, getIngestStates } from "./db.js";
import { ingestAll, getSources } from "./ingest.js";
import { probeLlm } from "./llm.js";
const mainFile = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (mainFile === "ingest-cli.js") {
    const args = process.argv.slice(2);
    const incremental = args.includes("--incremental");
    const dry = args.includes("--dry");
    const l1Only = args.includes("--l1-only");
    const li = args.indexOf("--limit");
    const limit = li >= 0 ? Math.max(0, Number(args[li + 1]) || 0) : 0; // 0=全部；>0 只处理前 N 个源（调试）
    const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));
    if (dry) {
        const db = openDb(dbPath);
        const states = getIngestStates(db);
        const srcs = getSources();
        let will = 0, skip = 0;
        for (const s of srcs) {
            try {
                const st = fs.statSync(s.path);
                const p = states.get(s.path);
                if (p && p.size === st.size && p.mtime_ms === Math.floor(st.mtimeMs)) {
                    skip++;
                    continue;
                }
                will++;
            }
            catch { /* 不可读则忽略 */ }
        }
        console.log(`[ingest --dry${incremental ? " --incremental" : ""}] 源 ${srcs.length} 个｜本次将处理 ${will}｜跳过未变 ${skip}`);
        process.exit(0);
    }
    const db = openDb(dbPath);
    // LLM 预检：代理离线时不整轮跳过 —— L1 是免 LLM 通道，理应照跑；只降级掉需要 LLM 的 L2。
    const llmOk = await probeLlm();
    if (!llmOk) {
        console.log(`[ingest] ${new Date().toISOString()}｜LLM 代理不可用（${process.env.MIMOS_URL ?? "http://127.0.0.1:18900"}）→ 降级为只跑 L1 免 LLM 通道；L2 水位未推进，下轮自动重试`);
    }
    const t0 = Date.now();
    const stats = await ingestAll(db, limit, { incremental, l1Only: l1Only || !llmOk });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[ingest] ${new Date().toISOString()}｜源 ${stats.sources}｜跳过未变 ${stats.skippedUnchanged}｜` +
        `文件 ${stats.files}（L1 ${stats.l1Files}）｜块 ${stats.chunks}｜入库 ${stats.inserted}（L1免LLM ${stats.l1Inserted}）｜` +
        `语义去重 ${stats.skippedDup}｜门控: 拒 ${stats.qualityReject} / 审查 ${stats.gateReview} / meta ${stats.gateMeta}｜` +
        `LLM失败 ${stats.llmFail}｜${sec}s`);
    if (stats.errors.length)
        console.log(`[ingest] 错误(前5): ${stats.errors.slice(0, 5).join(" ｜ ")}`);
    process.exit(0);
}
