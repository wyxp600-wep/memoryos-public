import { bodyFixture } from "./memory-body-fixture.js";
/** 隔离数据库，直接执行真实工具注册函数；不访问生产数据。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
process.env.EMBED_MODE = "fake";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-quality-"));
process.env.MEMORY_DB = path.join(temp, "fixture.db");
process.env.MEMORY_AGENT = "quality-regression";
const { openDb, writeMemory, readMemory, bumpConfidence, usageCount } = await import("./db.js");
const { registerMemoryTools } = await import("./server-reg-memory.js");
const { hybridSearch, archivedSearch } = await import("./search.js");
const { fmtContextLine, fmtSearchLine, aiViews, aiVisible } = await import("./format.js");
const { distinctMemories } = await import("./memory-quality.js");
const db = openDb(process.env.MEMORY_DB);
const registered = new Map();
registerMemoryTools({ addTool(t) { registered.set(t.name, t); } }, {
    db, stateReceipt: () => "", runTaskTx: (_db, fn) => { fn(); return null; },
    isCredentialValid: () => true, nowIso: () => new Date().toISOString(),
    plusHoursIso: (h) => new Date(Date.now() + h * 3600000).toISOString(),
});
const call = (name, args) => {
    const t = registered.get(name);
    return t.execute(t.parameters.parse(args));
};
let passed = 0;
function check(name, cond) { assert.ok(cond, name); passed++; console.log(`PASS ${name}`); }
const row = (content, extra = {}) => writeMemory(db, {
    content, type: "experience", agent: "quality", agent_fpath: null, project: "MemoryOS", confidence: 0.7, ...extra,
});
const update = (r, sql, ...values) => db.prepare(`UPDATE memories SET ${sql} WHERE id=?`).run(...values, r.id);
const has = (s, r) => new RegExp(`^#${r.id} `, "m").test(s);
const offline = { async embedTexts() { throw new Error("专项测试主动禁用向量，仅验证词法兜底"); } };
try {
    const good = row(bodyFixture("quality_probe 正确的内核路径"), { type: "experience", project: "MemoryOS" });
    const lower = row("quality_probe 小写项目经验", { project: "memoryos" });
    const foreign = row("quality_probe 其他项目私有内容", { project: "other-project" });
    const secret = row("quality_probe 不可泄露", { sensitivity: "secret" });
    const task = row("quality_probe 已完成测试任务", { type: "task" });
    const expired = row("quality_probe 已过期", { valid_until: "2000-01-01T00:00:00Z" });
    const future = row("quality_probe 尚未生效", { valid_from: "2999-01-01T00:00:00Z" });
    const superseded = row("quality_probe 已被替代"); update(superseded, "superseded_by=?", good.id);
    const conflictPeer = row("quality_probe 冲突另一方");
    const conflict = row("quality_probe 存在冲突"); update(conflict, "conflict_with=?", conflictPeer.id);
    const global = row("quality_probe 全局安全经验", { project: "global" });
    const copy1 = row("quality_probe 重复知识 42");
    const copy2 = row("quality_probe   重复知识 42");
    const different = row("quality_probe 重复知识 43");
    const negation = row("quality_probe 不采用重复知识 42");

    const before = readMemory(db, good.id).confidence;
    await call("memory_cite", { memory_id: good.id, session_id: "cite-positive" });
    check("采用引用不提高置信度", readMemory(db, good.id).confidence === before);
    check("采用仍计入使用统计", usageCount(db, "cited") === 1);
    await call("memory_cite", { memory_id: good.id, stance: "counterexample", session_id: "cite-negative" });
    await call("memory_cite", { memory_id: good.id, stance: "reference" });
    check("反例及参考不计为采用", usageCount(db, "cited") === 1 && usageCount(db, "referenced") === 2);
    check("反例不提高置信度", readMemory(db, good.id).confidence === before);
    check("引用用途有审计记录", db.prepare("SELECT COUNT(*) n FROM memory_events WHERE op='citation'").get().n === 3);
    await call("memory_write", { content: good.content, type: good.type, project: good.project });
    check("重复写入不提高置信度", readMemory(db, good.id).confidence === before);
    bumpConfidence(db, good.id, 100);
    check("独立验证加分上限为1", readMemory(db, good.id).confidence === 1);
    bumpConfidence(db, good.id, -100);
    check("置信度下限为0", readMemory(db, good.id).confidence === 0);
    assert.throws(() => bumpConfidence(db, good.id, NaN)); passed++; console.log("PASS 非有限置信度被拒绝");

    const ctx = await call("memory_context", { project: "memoryos", limit: 20 });
    check("读取兼容项目大小写并包含global", has(ctx, good) && has(ctx, lower) && has(ctx, global));
    check("无主题读取不注入任务记录", !has(ctx, task));
    check("无主题不读过期未来替代及冲突知识", [expired, future, superseded, conflict, conflictPeer].every((r) => !has(ctx, r)));
    check("项目隔离与secret保护", !has(ctx, foreign) && !has(ctx, secret));
    check("无主题明确提示相关性限制", ctx.includes("未提供主题"));
    check("相同正文只展示一条且保留不同数字及否定", [copy1, copy2].filter((r) => has(ctx, r)).length === 1 && has(ctx, different) && has(ctx, negation));
    check("重复记录仍保留在库", readMemory(db, copy1.id) && readMemory(db, copy2.id));

    const hits = await hybridSearch(db, offline, { project: "memoryos", query: "quality_probe", limit: 30 });
    check("词法搜索同时召回大小写项目", hits.some((r) => r.id === good.id) && hits.some((r) => r.id === lower.id));
    check("搜索隐藏未生效及被替代记录", !hits.some((r) => [future.id, superseded.id, expired.id].includes(r.id)));
    check("搜索保守去重并保留数字差异", hits.filter((r) => [copy1.id, copy2.id].includes(r.id)).length === 1 && hits.some((r) => r.id === different.id));
    check("冲突结果展示警告", fmtSearchLine(hits.find((r) => r.id === conflict.id)).includes("未决冲突"));
    const archivedOld = row("archive_probe 被取代旧记录"); update(archivedOld, "status='archived', superseded_by=?", good.id);
    const archivedGood = row("archive_probe 可用历史经验"); update(archivedGood, "status='archived'");
    const archiveHits = await archivedSearch(db, offline, { project: "memoryos", query: "archive_probe", limit: 10 });
    check("归档可搜但不复活已替代记录", archiveHits.some((r) => r.id === archivedGood.id) && !archiveHits.some((r) => r.id === archivedOld.id));

    const long = row("quality_long 当前会话未启用。" + "历史过程记录。".repeat(70) + "重启后已经启用。");
    check("摘要明确截断和全文入口", fmtContextLine(long).includes(`memory_read #${long.id}`) && fmtSearchLine(long).includes("摘要已截断"));
    check("状态快照展示时间及核验提醒", fmtContextLine(long).includes("创建=") && fmtContextLine(long).includes("历史状态快照"));
    const full = await call("memory_read", { memory_id: long.id });
    check("全文完整保留状态变化", full.includes(long.content));
    update(long, "confidence=1.05");
    check("历史越界评分显式标注", fmtSearchLine(readMemory(db, long.id)).includes("历史置信评分越界"));

    const cached1 = await call("memory_context", { project: "memoryos", limit: 20, session_id: "content-change" });
    const selected = [...cached1.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    const selectedRow = readMemory(db, selected[0]);
    update(selectedRow, "content=?", "内容修订标记 " + selectedRow.content);
    const cached2 = await call("memory_context", { project: "memoryos", limit: 20, session_id: "content-change" });
    check("相同编号正文变更不会被会话缓存吞掉", !cached2.includes("内容未变") && cached2.includes("内容修订标记"));
    const cached3 = await call("memory_context", { project: "memoryos", limit: 20, session_id: "content-change" });
    check("正文未变时仍去重注入", cached3.includes("内容未变"));
    const hinted = await call("memory_context", { project: "memoryos", task_hint: "quality_probe", limit: 3, simFloor: 0 });
    check("task_hint 作为主题而非通用榜", hinted.includes("quality_probe") && !hinted.includes("未提供主题"));
    check("主题输出不超过limit且不包含任务", [...hinted.matchAll(/^#\d+ /gm)].length <= 3 && !has(hinted, task));
    check("看板与工具格式使用同一规则", aiViews(long).context === fmtContextLine(long));
    check("看板可见性同步有效期与替代规则", [future, expired, readMemory(db, superseded.id), secret].every((r) => !aiVisible(r).searchable));
    check("代码空白差异不被当成重复", distinctMemories([{ content: '`a  b`' }, { content: '`a b`' }]).length === 2);
    const agentA = row("agent_probe 重复经验", { agent: "a" });
    const agentB = row("agent_probe 重复经验", { agent: "b" });
    const agentHits = await hybridSearch(db, offline, { project: "memoryos", query: "agent_probe", limit: 10, agent: "b" });
    check("指定来源后再去重，不吞掉来源筛选结果", agentHits.length === 1 && agentHits[0].id === agentB.id && agentHits[0].id !== agentA.id);
    console.log(`\n记忆质量专项：${passed} PASS / 0 FAIL`);
} finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
