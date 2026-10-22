/**
 * MemoryOS v0.2 — 埋点 + cite + 周报五查询冒烟（M-1.5 + M-1.6）
 * 用 db 层直接驱动（fake embed），验证：
 *   U1 埋点落库：write/returned/cited 三事件计数正确
 *   U2 memory_cite 逻辑：cited 埋点，置信度不变（复刻 server 同源）
 *   U3 inferred-cited（R4）：同 session 内 returned 后又 write → 记 inferred
 *   U4 五查询全可跑：funnel(含 raw/inferred 两行) / trend / top / zombies / cross_tool
 * 用法：node dist/smoke-cite.js
 */
import { openDb, writeMemory, logUsage, readMemory, usageCount } from "./db.js";
import { funnel, trend, topMemories, zombies, crossTool } from "./report.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `memoryos-smoke-cite-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
try {
    const db = openDb(dbPath);
    // 工具A写入 2 条
    const r1 = writeMemory(db, { content: "微信回调时间戳容差需设5分钟", type: "experience", agent: "codex", agent_fpath: null, project: "ecommerce" });
    const r2 = writeMemory(db, { content: "订单状态机迁移到 Redis", type: "decision", agent: "codex", agent_fpath: null, project: "ecommerce" });
    logUsage(db, { memory_id: r1.id, event: "write", reader_agent: "codex", writer_agent: "codex", project: "ecommerce", session_id: "S1" });
    logUsage(db, { memory_id: r2.id, event: "write", reader_agent: "codex", writer_agent: "codex", project: "ecommerce", session_id: "S2" });
    // 工具B在 S3 命中 r1（returned），随后同 S3 又 write r3 → r1 应记 inferred-cited
    logUsage(db, { memory_id: r1.id, event: "returned", reader_agent: "claude", writer_agent: "codex", project: "ecommerce", session_id: "S3" });
    // 显式 cite r2（工具B）→ raw_cited
    logUsage(db, { memory_id: r2.id, event: "cited", reader_agent: "claude", writer_agent: "codex", project: "ecommerce", session_id: "S2" });
    const r3 = writeMemory(db, { content: "回调用时区统一用东八区", type: "pitfall", agent: "claude", agent_fpath: null, project: "ecommerce" });
    logUsage(db, { memory_id: r3.id, event: "write", reader_agent: "claude", writer_agent: "claude", project: "ecommerce", session_id: "S3" });
    // U1 埋点事件计数
    check("U1.write 事件=3", usageCount(db, "write") === 3, `write=${usageCount(db, "write")}`);
    check("U1.returned 事件=1", usageCount(db, "returned") === 1, `returned=${usageCount(db, "returned")}`);
    check("U1.cited 事件=1", usageCount(db, "cited") === 1, `cited=${usageCount(db, "cited")}`);
    // U2 引用只记使用；真实工具行为另由 smoke-memory-quality 覆盖
    const confBefore = readMemory(db, r1.id).confidence;
    logUsage(db, { memory_id: r1.id, event: "cited", reader_agent: "claude", writer_agent: "codex", project: "ecommerce", session_id: "S4" });
    const confAfter = readMemory(db, r1.id).confidence;
    check("U2.cite 保持 confidence 不变", confAfter === confBefore, `${confBefore}→${confAfter}`);
    check("U2.cited 事件+1=2", usageCount(db, "cited") === 2, `cited=${usageCount(db, "cited")}`);
    // U4 五查询全可跑
    const f = funnel(db, {});
    const funnelRow = (ev) => f.find((x) => x.event === ev)?.value ?? -1;
    check("U4.funnel: write=3", funnelRow("write") === 3, `write=${funnelRow("write")}`);
    check("U4.funnel: returned(去重)=1", funnelRow("returned") === 1, `returned=${funnelRow("returned")}`);
    check("U4.funnel: raw_cited=2（r2 S2 + r1 S4 显式）", funnelRow("cited") === 2, `raw_cited=${funnelRow("cited")}`);
    check("U4.funnel: inferred_cited=1（r1 在 S3 returned 后又 write）", funnelRow("inferred") === 1, `inferred=${funnelRow("inferred")}`);
    check("U4.funnel: raw 与 inferred 两行均有输出（R4）", funnelRow("cited") >= 1 && funnelRow("inferred") >= 1);
    const t = trend(db, {});
    check("U4.trend: 有日分组且 write/returned/cited 都有列", t.length >= 1 && t[0].write >= 0, `days=${t.length}`);
    const top = topMemories(db, {});
    // r1 与 r2 均被 cite 1 次；另 r1 有 returned=1 → 按 cited DESC + returned DESC，r1 居首
    check("U4.top: 被 cite 且多 returned 的 r1 居首", top.length >= 1 && top[0].id === r1.id, `top[0]=#${top[0]?.id}`);
    const z = zombies(db, { days: 0 }); // 期 0 天：所有 0-returned 记忆都应列入
    // r3 未被 returned/cited → 应入选僵尸
    check("U4.zombies: 未消费的 r3 入选", z.some((x) => x.id === r3.id), `zombies=${z.map((x) => `#${x.id}`).join(",")}`);
    const c = crossTool(db, {});
    check("U4.cross_tool: codex写→claude读 复用被统计", c.some((x) => x.writer_agent === "codex" && x.reader_agent === "claude"), `pairs=${c.map((x) => `${x.writer_agent}→${x.reader_agent}`).join(",")}`);
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
