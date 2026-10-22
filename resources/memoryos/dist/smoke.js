/**
 * MemoryOS v0.1→v0.2 冒烟自检（M-0.1 + M-0.2 + v0.2 检索回归）
 * 用例：
 *  U1 两工具身份不同，写入记录 agent + agent_fpath 正确（R3 双字段）
 *  U2 工具A 写入 → 工具B（同一 db）检索命中（共享跑通）
 *  U3 project 隔离：A 项目查不到 B 项目记忆（global 除外）
 *  U4 trigram 中文检索命中 + fts 视图与主表同步
 * 检索统一走 v0.2 hybridSearch（fake embed 降级纯词法，不引入真实语义）
 * 用法：node dist/smoke.js
 */
import { openDb, writeMemory, ftsCount } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `memoryos-smoke-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
async function search(db, query, project) {
    // fake embed 模式：语义路无向量可召回，自动降级纯词法 → 与 v0.1 lexSearch 行为一致
    const embedder = await getEmbedder(); // EMBED_MODE 默认 fake
    return hybridSearch(db, embedder, { query, project, limit: 20 });
}
try {
    // 连接1：工具A（codex）
    const dbA = openDb(dbPath);
    writeMemory(dbA, {
        content: "微信回调时间戳容差需设5分钟（签名校验常因时钟偏差误报超时）",
        type: "experience",
        agent: "codex",
        agent_fpath: "C:/Users/zhang/.codex/config.toml",
        project: "ecommerce",
    });
    // 工具A再写一条 decision
    writeMemory(dbA, {
        content: "订单状态机迁移到 Redis 存储，放弃 DB 主键自增作为超时判据",
        type: "decision",
        agent: "codex",
        agent_fpath: "C:/Users/zhang/.codex/config.toml",
        project: "ecommerce",
    });
    // 项目B 的一条
    writeMemory(dbA, {
        content: "沙箱环境额外开启 3 分钟容忍窗口用于联调",
        type: "experience",
        agent: "codex",
        agent_fpath: "C:/Users/zhang/.codex/config.toml",
        project: "sandbox",
    });
    // U3: project 隔离——ecommerce 查"沙箱"应命中 global 之外、但查不到 sandbox 项目的条
    const iso = await search(dbA, "沙箱", "ecommerce");
    check("U3.project 隔离：ecommerce 查不到 sandbox 项目记忆", iso.length === 0, `命中 ${iso.length} 条（期望 0）`);
    // 连接2：工具B（claude）打开同一文件 -> U2 共享
    const dbB = openDb(dbPath);
    const hits = await search(dbB, "时间戳", "ecommerce");
    check("U2.工具B(claude) 检索到 工具A(codex) 写入（共享跑通）", hits.length >= 1 && hits[0].agent === "codex", `agent=${hits[0]?.agent}, hits=${hits.length}`);
    // U4: trigram 中文命中 + fts 同步
    const fts = await search(dbB, "容差", "ecommerce");
    check("U4.trigram 中文命中（'容差'≥3字符行为≥3，LIKE 兜底路径）", fts.length >= 1, `hits=${fts.length}`);
    check("U4.fts 视图与主表一致", ftsCount(dbB) === 3, `ftsCount=${ftsCount(dbB)}`);
    // U1: R3 身份双字段正确落库（从主表取证 agent + agent_fpath）
    const row = dbB
        .prepare("SELECT agent, agent_fpath FROM memories WHERE id = 1")
        .get();
    check("U1.身份双字段正确（codex + fpath）", row.agent === "codex" && row.agent_fpath === "C:/Users/zhang/.codex/config.toml", `agent=${row.agent}, fpath=${row.agent_fpath}`);
    // 短查询兜底：单字也能命中（LIKE）
    const short = await search(dbB, "超时", "ecommerce");
    check("U4b.短查询(2字/单字) LIKE 兜底命中", short.length >= 1, `hits=${short.length}`);
    dbA.close();
    dbB.close();
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
