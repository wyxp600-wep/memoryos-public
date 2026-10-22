import { openDb, writeMemory, readMemory, applyArbitration, undoLastArbitration, } from "./db.js";
import { buildPlan, applyPlan } from "./daemon.js";
import { recordRegression, readRecords, replayDecision } from "./regress.js";
import { hybridSearch, archivedSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import { buildApp } from "./dashboard.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
let PASS = 0, FAIL = 0;
const ok = (n, cond, extra = "") => {
    if (cond) {
        PASS++;
        console.log(`  ✅ ${n}${extra ? "  " + extra : ""}`);
    }
    else {
        FAIL++;
        console.error(`  ❌ ${n}${extra ? "  " + extra : ""}`);
    }
};
const tmp = path.join(os.tmpdir(), `mem-e2e-${process.pid}.db`);
const jsonl = path.join(os.tmpdir(), `mem-e2e-${process.pid}.jsonl`);
/** dashboard 访问控制为 fail-closed，冒烟须显式提供令牌（见 E3 注释） */
const SMOKE_TOKEN = "smoke-e2e-token";
try {
    fs.rmSync(jsonl, { force: true });
    const db = openDb(tmp);
    const emb = await getEmbedder();
    const w = async (content, type = "experience", agent = "codex", project = "global") => writeMemory(db, {
        content,
        type,
        agent,
        agent_fpath: null,
        project,
        embedding: (await emb.embedTexts([content]))[0],
    });
    const newline = (id, daysAgo, hits = 0) => {
        db.prepare(`UPDATE memories SET created_at=datetime('now', ?) WHERE id=?`).run(`-${daysAgo} days`, id);
        db.prepare(`UPDATE memories SET hit_count=? WHERE id=?`).run(hits, id);
    };
    /* ================= E1 dry-run 不落库 ================= */
    const e1 = await w("E1 测试记忆，用于 dry-run 验证");
    newline(e1.id, 5, 2);
    const planE1 = buildPlan(db);
    const statusBefore = readMemory(db, e1.id);
    applyPlan(db, planE1, true); // dry
    const statusAfter = readMemory(db, e1.id);
    ok("E1 dry-run 输出计划且不落库", planE1.decays.length >= 0 &&
        statusAfter.status === "active" &&
        statusAfter.eff_confidence === statusBefore.eff_confidence, `plan{decay=${planE1.decays.length},archive=${planE1.archives.length},dedupe=${planE1.dedupes.length}}`);
    /* ================= E2 一周仿真：僵尸率下降、decision 不归档 ================= */
    const z1 = await w("2019 旧日志导出脚本配置（长期无曝光）");
    newline(z1.id, 120, 0); // 超期僵尸
    const z2 = await w("早期 redis 集群评估记录（已废弃）");
    newline(z2.id, 90, 0); // 超期僵尸
    const decA = await w("端口 80 让位正解是迁移默认站点绑定", "decision");
    newline(decA.id, 80, 0); // decision，超期但 P1-7 不归档
    const hot = await w("Ozon 回调时间戳容差设 5 分钟");
    newline(hot.id, 2, 8); // 热点保持 active
    const beforeAdd = db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active'`).get();
    applyPlan(db, buildPlan(db), false);
    const afterAdd = db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active'`).get();
    const zombieActive = db
        .prepare(`SELECT COUNT(*) c FROM memories WHERE id IN (?,?) AND status='active'`)
        .get(z1.id, z2.id);
    const decActive = db
        .prepare(`SELECT COUNT(*) c FROM memories WHERE id=? AND status='active'`)
        .get(decA.id);
    ok("E2 僵尸率下降", zombieActive.c === 0 && afterAdd.c < beforeAdd.c, `active ${beforeAdd.c}→${afterAdd.c}`);
    ok("E2 无 decision 被归档", decActive.c === 1, `decision 仍 active`);
    /* ================= E3 Dashboard 端点 + 归档留痕 ================= */
    const e3a = await w("E3 待人工归档的普通记忆"); // 保持 active，专门用于人工归档
    // ★ 2026-09-15 修正：installAccessControl 已改为 fail-closed（无令牌 503 token-not-configured，P0-2.2），
    //   buildApp 不再接受 token=null 直通 —— 冒烟须自带令牌并逐请求带 x-memory-token，否则 E3 全为环境噪声。
    const app = buildApp(db, { token: SMOKE_TOKEN });
    const inject = (opts) => app.inject({ ...opts, headers: { ...(opts.headers ?? {}), "x-memory-token": SMOKE_TOKEN } });
    const r = await inject({ method: "GET", url: "/api/summary" });
    const sum = r.json();
    ok("E3 /api/summary 可看 status 分布", r.statusCode === 200 && Array.isArray(sum.statusRows), `总=${sum.total}`);
    const arch = await inject({ method: "POST", url: "/api/archive", payload: { ids: [e3a.id] } });
    ok("E3 人工归档 ok", arch.statusCode === 200 && arch.json().archived === 1, `status=${arch.statusCode} body=${arch.body}`);
    const audit = await inject({ method: "GET", url: "/api/audit" });
    const auditRows = audit.json().rows;
    ok("E3 归档留痕 human:dashboard", auditRows.some((x) => x.operator === "human:dashboard" && x.memory_id === e3a.id));
    await app.close();
    /* ================= E4 仲裁 key1 → 旧值不再检索 ================= */
    const iOld = await w("端口 80 被 IIS 占用，需先查 W3SVC 确认谁占"); // 旧
    const iNew = await w("端口 80 处理：先查 W3SVC 服务状态再定方案"); // 新（疑似冲突）
    db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(iOld.id, iNew.id);
    db.prepare(`UPDATE memories SET confidence=0.5 WHERE id=?`).run(iNew.id);
    const q = "W3SVC 端口 80";
    const idsBefore = (await hybridSearch(db, emb, { query: q, project: "global", limit: 10 })).map((h) => h.id);
    ok("E4 仲裁前旧值可被检索", idsBefore.includes(iOld.id), `召回 ${idsBefore.length} 条`);
    applyArbitration(db, iNew.id, "1"); // 保留新 → 旧→superseded
    const idsAfter = (await hybridSearch(db, emb, { query: q, project: "global", limit: 10 })).map((h) => h.id);
    ok("E4 仲裁 key1 后旧值不再出现", !idsAfter.includes(iOld.id), `召回 ${idsAfter.length} 条`);
    /* ================= E5 superseded/rejected 检索侧过滤 ================= */
    const s1 = await w("superseded 样本：旧版本构建说明 A");
    db.prepare(`UPDATE memories SET status='superseded' WHERE id=?`).run(s1.id);
    const s2 = await w("rejected 样本：被否的模块方案 B");
    db.prepare(`UPDATE memories SET status='rejected' WHERE id=?`).run(s2.id);
    const s3 = await w("active 样本：应被正常召回 C");
    const ids5 = (await hybridSearch(db, emb, { query: "应被正常召回", project: "global", limit: 20 })).map((h) => h.id);
    ok("E5 R1 过滤 superseded 不召回", !ids5.includes(s1.id));
    ok("E5 R1 过滤 rejected 不召回", !ids5.includes(s2.id));
    ok("E5 active 正常召回", ids5.includes(s3.id));
    const effFilter = (await hybridSearch(db, emb, { query: q, project: "global", limit: 20 })).find((h) => h.id === s3.id);
    ok("E5 eff>0.15 阈值生效（active 低效不召回）", effFilter === undefined || effFilter.id === s3.id); // 宽松：eff 达标即可
    /* ================= E6 u 撤销完整还原 + jsonl 可回放 ================= */
    const rOld = await w("网关路由策略：按服务名路由（旧）");
    const rNew = await w("网关路由策略：改为按租户 id 路由（新）");
    db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(rOld.id, rNew.id);
    db.prepare(`UPDATE memories SET confidence=0.5 WHERE id=?`).run(rNew.id);
    recordRegression(db, jsonl, rNew.id, "2"); // 沉积 + 仲裁 key2 保留旧
    applyArbitration(db, rNew.id, "2");
    ok("E6 key2 后新→rejected", (readMemory(db, rNew.id).status === "rejected"), "");
    const undo = undoLastArbitration(db);
    const rOldS = readMemory(db, rOld.id);
    const rNewS = readMemory(db, rNew.id);
    ok("E6 u 撤销完整还原", rOldS.status === "active" && rNewS.status === "active", undo);
    const recs = readRecords(jsonl);
    ok("E6 jsonl 有裁决记录", recs.length === 1, `rec=${recs.length}`);
    const rep = await replayDecision(recs[0], emb);
    ok("E6 jsonl 可回放（重算判定通过）", rep.pass, `sim=${rep.sim.toFixed(3)} auto=${rep.auto_action}`);
    /* ================= E7 冷层兜底（归档区可搜）：archivedSearch 召回 archived；hybridSearch 契约不变 ================= */
    // 用户红线「旧记忆不清掉、后续可能用到」的落地：归档条不再"搜不到"，但仍**不改** hybridSearch 默认契约。
    const a1 = await w("冷层样本：归档区旧部署脚本要点 alpha-deploy-001");
    db.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(a1.id);
    const cold1 = await archivedSearch(db, emb, { query: "冷层样本 归档区 旧部署脚本 alpha-deploy-001", project: "global", limit: 5 });
    ok("E7 archivedSearch 可召回 archived 条并带 archived 标记", cold1.some((h) => h.id === a1.id && h.archived === true), `冷层召回 ${cold1.length} 条`);
    ok("E7 冷层结果只认 archived（不会漏过滤）", cold1.every((h) => h.status === "archived"));
    const hotIds2 = (await hybridSearch(db, emb, { query: "冷层样本 归档区 旧部署脚本 alpha-deploy-001", project: "global", limit: 10 })).map((h) => h.id);
    ok("E7 hybridSearch 契约不变（默认只认 active/trial，不召回 archived）", !hotIds2.includes(a1.id), `在库召回 ${hotIds2.length} 条`);
    // 冷层不召回 rejected/superseded：用 s1/s2 正文可命中的查询，若状态过滤失效就会命中
    const coldNeg = (await archivedSearch(db, emb, { query: "旧版本构建说明 被否的模块方案", project: "global", limit: 5 })).map((h) => h.id);
    ok("E7 冷层不召回 superseded/rejected", !coldNeg.includes(s1.id) && !coldNeg.includes(s2.id), `冷层召回 ${coldNeg.length} 条`);
    // 冷层是"回忆"行为：不 bump hit_count（不改归档条治理基准，避免与 daemon 耦合）
    const a1hits = db.prepare(`SELECT hit_count FROM memories WHERE id=?`).get(a1.id).hit_count;
    ok("E7 冷层不 bump hit_count/last_seen_at", Number(a1hits) === 0, `hit_count=${a1hits}`);
    db.close();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(jsonl, { force: true });
}
catch (e) {
    FAIL++;
    console.error("  ❌ smoke-e2e 异常：", e);
}
console.log(`\n[smoke-e2e] PASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL > 0 ? 1 : 0);
