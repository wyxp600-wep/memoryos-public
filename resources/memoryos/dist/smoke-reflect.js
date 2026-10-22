import { bodyFixture } from "./memory-body-fixture.js";
/**
 * MemoryOS 批次⑧ — 每日规则反思冒烟（方案 A 生产线）
 * 全程注入假 LLM（不发网络）、sync=false（★ 该入参自 2026-10-14 起不再生效：本产线不再写任何目标文件）、临时库。
 * 覆盖：① parseRules 容错（围栏/短条目/前缀/非数组）
 *   ② 主链路：水位后候选选中（**仅 source='human' ∪ pinned=1**）→ 提炼写规则（type=rule +
 *      agent=memoryos:reflection + **inject=0**）+ 精确去重；采集/非人工来源被过滤、钉选豁免
 *   ③ 水位推进后二次调用无候选、不重复产
 *   ④ LLM 失败：向上抛、水位不推进（次日补跑）、审计 reflect-failed、无半截规则
 * 用法：node dist/smoke-reflect.js（smoke-all 自动收录）
 */
import { openDb, writeMemory, writeConfig, readConfig, queryByType } from "./db.js";
import { maybeRunRuleReflection, parseRules } from "./rule-reflection.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.join(os.tmpdir(), `memoryos-smoke-reflect-${Date.now()}.db`);
let failed = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
};
const reflectRules = (db) => queryByType(db, "rule", { status: "active" }).filter((r) => r.agent === "memoryos:reflection");

try {
    const db = openDb(dbPath);
    // 预置：老水位（force 场景直接可用）+ 1 条现有规则（去重靶）+ 候选记忆
    writeConfig(db, "reflect", { watermark: "2020-01-01T00:00:00.000Z" });
    writeMemory(db, { content: bodyFixture("- **旧规则**：已存在的规则用于去重"), type: "rule", agent: "codex", agent_fpath: null, project: "global" });
    // ★ 2026-10-14（③ 记忆来源标签）：候选只收「人担保」（source='human'）或「人工钉选」（pinned=1）
    writeMemory(db, { content: "回调容差 5 分钟需按东八区折算", type: "experience", agent: "human:test", agent_fpath: null, project: "global" });
    writeMemory(db, { content: "含中文路径的工作区禁用 powershell -File", type: "convention", agent: "human:test", agent_fpath: null, project: "global" });
    // 以下两条**必须被过滤**：外部采集（source=ingest）与非人工 agent 写入（source=agent），且均未钉选
    writeMemory(db, { content: "【应被过滤】外部采集文件里的经验", type: "experience", agent: "codex", agent_fpath: null, project: "global", source: "ingest" });
    writeMemory(db, { content: "【应被过滤】非人工 agent 写入的经验", type: "experience", agent: "codex", agent_fpath: null, project: "global" });
    // 钉选豁免：非人工来源但 pinned=1（人工背书）→ 仍进候选
    writeMemory(db, { content: "【钉选豁免】非人工但已被人钉选的经验", type: "pitfall", agent: "codex", agent_fpath: null, project: "global", pinned: 1 });

    // ① parseRules 单元
    const parsed = parseRules(JSON.stringify([{content:bodyFixture("合格的规则句abcdefgh")},{content:"短"},{content:"旧格式应被拒绝abcdefgh"}]));
    check("P1.parseRules：仅接收完整五字段，不自动补齐", parsed.length === 1, JSON.stringify(parsed));
    check("P2.parseRules：非数组文本 → []（绝不回落成记忆）", parseRules("抱歉我无法完成").length === 0);

    // ② 主链路：假 LLM 返回 [重复旧规则, 新规则] → 只该落 1 条
    const fakeLlm = async (candidates) => {
        const contents = candidates.map((c) => c.content).join("|");
        check("C1.候选=人担保 ∪ 人工钉选（3 条）", candidates.length === 3, `n=${candidates.length}`);
        // ★ 2026-10-14（③）回归护栏：采集/非人工来源未钉选者不得进候选（否则外部内容可经反思升格为规则）
        check("C2.采集(ingest)/非人工(agent) 未钉选者被过滤", !/应被过滤/.test(contents), contents.slice(0, 120));
        check("C3.钉选豁免：pinned=1 的非人工来源仍入选", /【钉选豁免】/.test(contents) && candidates.some((c) => c.source === "agent" && c.pinned === 1), candidates.map((c) => `${c.source}${c.pinned ? "+pin" : ""}`).join(","));
        return [bodyFixture("- **旧规则**：已存在的规则用于去重"), bodyFixture("- **反射新规则**：每日反思产线断言用规则句")];
    };
    const r1 = await maybeRunRuleReflection(db, { force: true, llm: fakeLlm, sync: false });
    check("R1.产规则 1 条（程序侧精确去重生效）", r1.produced === 1, JSON.stringify(r1));
    const nr = reflectRules(db);
    check("R2.落库 type=rule 且 agent=memoryos:reflection", nr.length === 1 && nr[0].type === "rule", `n=${nr.length}`);
    // ★ 2026-10-14 安全加固回归护栏：产物必须**不自动**进注入段（inject=0），
    //   否则「外部内容 → 反思 → 所有 agent 常驻指令」的提权路径复活。此断言即防倒退。
    check("R3.inject=0（产物不自动进注入段，待在规则页人工审核）", nr[0]?.inject === 0, `inject=${nr[0]?.inject}`);
    const st1 = readConfig(db, "reflect", {});
    check("R4.水位推进到本批之后 + 当日认领", st1.watermark > "2020-01-01T00:00:00.000Z" && !!st1.lastAttemptDay, `wm=${String(st1.watermark).slice(0, 19)}`);
    const a1 = db.prepare(`SELECT COUNT(*) n FROM daemon_log WHERE task='reflect' AND op='reflect-rules'`).get().n;
    check("R5.审计留痕 reflect-rules", a1 >= 1, `n=${a1}`);

    // ③ 二次调用（force）：水位已过 → 无候选 → 不重复产
    const r2 = await maybeRunRuleReflection(db, { force: true, llm: fakeLlm, sync: false });
    check("R6.水位推进后无候选跳过", r2.skipped === "no-candidates", JSON.stringify(r2));
    check("R7.规则数仍为 1（不重复产）", reflectRules(db).length === 1, `n=${reflectRules(db).length}`);

    // ④ 失败路径：回拨水位 + 抛错假 LLM → 水位不推进、认领保留、审计失败、无半截规则
    writeConfig(db, "reflect", { watermark: "2020-01-01T00:00:00.000Z" });
    let threw = false;
    try {
        await maybeRunRuleReflection(db, { force: true, llm: async () => { throw new Error("boom(模拟 LLM 不可用)"); }, sync: false });
    }
    catch { threw = true; }
    const st2 = readConfig(db, "reflect", {});
    check("E1.LLM 失败向上抛出", threw);
    check("E2.失败不推进水位（次日补跑）", st2.watermark === "2020-01-01T00:00:00.000Z", `wm=${st2.watermark}`);
    check("E3.当日认领保留（同日不重试风暴）", !!st2.lastAttemptDay, `day=${st2.lastAttemptDay}`);
    const a2 = db.prepare(`SELECT COUNT(*) n FROM daemon_log WHERE task='reflect' AND op='reflect-failed'`).get().n;
    check("E4.失败审计留痕 reflect-failed", a2 >= 1, `n=${a2}`);
    check("E5.失败未产生半截规则", reflectRules(db).length === 1, `n=${reflectRules(db).length}`);
}
finally {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    for (const s of ["-wal", "-shm"]) {
        try { fs.unlinkSync(dbPath + s); } catch { /* ignore */ }
    }
}
console.log(failed ? `\n== smoke-reflect: ${failed} FAIL ==` : `\n== smoke-reflect 全过 ==`);
process.exit(failed ? 1 : 0);
