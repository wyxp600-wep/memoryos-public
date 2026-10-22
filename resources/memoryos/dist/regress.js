/**
 * MemoryOS v0.3 — 回归集最小可回放（M-2.5）
 * 评估闭环最后一块的前置（V5.1 附录C）。
 *
 * 两条链路：
 *   1. 仲裁测绘（emit）：arbitrate.js 每次裁决后调 recordRegression()，
 *      把 pending/old 内容 + 判定 sim + 自动判定 auto_action + 人工结论 decision
 *      append 到 <db 同目录>/regression_cases.jsonl（回归集种子，V5.1 第9章采集点①）。
 *   2. 重放判定（replay）：runner 离线读 jsonl，用 embedder 对记录存储的
 *      pending_content/old_content 重编码 → 重算 cosine → 重推 auto_action，
 *      与记录值比对，一致即"重算判定通过"。不依赖当时数据库状态，可离线回放。
 *
 * 用法：
 *   node dist/regress.js [jsonlPath]        （默认 data/regression_cases.jsonl）
 *   node dist/regress.js --emit-last        （仅打印文件最后一行，供抽查）
 */
import fs from "node:fs";
import path from "node:path";
import { readMemory, readVector } from "./db.js";
import { cosine, getEmbedder } from "./embed.js";
import { fileURLToPath } from "node:url";
export const DEFAULT_JSONL = fileURLToPath(new URL("../data/regression_cases.jsonl", import.meta.url));
export const MERGE_THRESHOLD = 0.92;
export const CONFLICT_THRESHOLD = 0.85;
export const SIM_TOLERANCE = 0.02;
/** 判定分档：与 db.dedupeDecision 阈值同源（0.92 merge / 0.85 conflict） */
export function actionFromSim(sim) {
    if (sim >= MERGE_THRESHOLD)
        return "merge";
    if (sim >= CONFLICT_THRESHOLD)
        return "conflict";
    return "insert";
}
const DECISION_BY_KEY = {
    "1": "keep_new",
    "2": "keep_old",
    "3": "merge",
    "4": "no_conflict",
};
/** 读某记忆的向量（float32），无则 null */
function vecOf(db, id) {
    // ★ P1-2.2：向量已独立成表，统一走 readVector（原为直接 SELECT memories.embedding）
    return readVector(db, id);
}
/**
 * 仲裁测绘：append 一条回归记录到 jsonl。不抛错只返回提示（不阻塞仲裁主流程）。
 * key ∈ "1"|"2"|"3"|"4"（与 applyArbitration 一致）。
 */
export function recordRegression(db, jsonlPath, pendingId, key) {
    const pending = readMemory(db, pendingId);
    if (!pending || pending.conflict_with == null)
        return `#${pendingId} 无待仲裁，跳过回归记录`;
    const old = readMemory(db, pending.conflict_with);
    if (!old)
        return `#${pendingId} 指向旧记忆不存在，跳过回归记录`;
    const pa = vecOf(db, pending.id);
    const oa = vecOf(db, old.id);
    const sim = pa && oa ? cosine(pa, oa) : -1;
    const rec = {
        pending_id: pending.id,
        old_id: old.id,
        pending_content: pending.content,
        old_content: old.content,
        type: pending.type,
        agent: pending.agent,
        project: pending.project,
        sim: Number(sim.toFixed(4)),
        auto_action: actionFromSim(sim),
        key,
        decision: DECISION_BY_KEY[key] ?? key,
        ts: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fs.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n", "utf8");
    return `已沉淀回归集 #${rec.pending_id} (auto=${rec.auto_action} sim=${rec.sim} → ${rec.decision})`;
}
/** 读 jsonl，逐行解析为记录（容忍坏行跳过） */
export function readRecords(jsonlPath) {
    if (!fs.existsSync(jsonlPath))
        return [];
    const out = [];
    for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch {
            /* 坏行跳过 */
        }
    }
    return out;
}
/** 单条重放判定：重编码两文 → 重算 cosine → 重推 auto_action，与记录比对（sim 容差 + 判定一致） */
export async function replayDecision(rec, embedder) {
    const [a, b] = await embedder.embedTexts([rec.pending_content, rec.old_content]);
    const sim = cosine(a, b);
    const auto = actionFromSim(sim);
    const simOk = Math.abs(sim - rec.sim) <= SIM_TOLERANCE;
    const actOk = auto === rec.auto_action;
    const fail = [simOk ? "" : `sim ${sim.toFixed(3)}≠${rec.sim}`, actOk ? "" : `auto ${auto}≠${rec.auto_action}`]
        .filter(Boolean)
        .join(";");
    return {
        pass: simOk && actOk,
        sim,
        auto_action: auto,
        expected_sim: rec.sim,
        expected_action: rec.auto_action,
        detail: fail || "判定通过",
    };
}
/** 整集重放：返回统计。任何一条 FAIL → 退出码非 0 */
export async function replayAll(jsonlPath) {
    const recs = readRecords(jsonlPath);
    const embedder = await getEmbedder();
    const errors = [];
    let pass = 0;
    for (let i = 0; i < recs.length; i++) {
        const r = await replayDecision(recs[i], embedder);
        if (r.pass)
            pass++;
        else
            errors.push(`#${i + 1} pending=${recs[i].pending_id}: ${r.detail}`);
    }
    return { total: recs.length, pass, fail: recs.length - pass, errors };
}
const args = process.argv.slice(2);
const mainFile = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (mainFile === "regress.js" || mainFile === "regress.ts") {
    const jsonl = args.find((a) => !a.startsWith("--")) ?? DEFAULT_JSONL;
    const { total, pass, fail, errors } = await replayAll(jsonl);
    const bar = () => {
        const w = 24;
        const h = Math.max(0, Math.round((pass / Math.max(1, total)) * w));
        return `[${"█".repeat(h)}${"░".repeat(w - h)}] ${pass}/${total}`;
    };
    console.log(`regression_cases: ${jsonl}`);
    console.log(`  ${bar()}  判定通过率`);
    if (fail > 0) {
        console.error(`  FAIL ${fail} 条：`);
        for (const e of errors)
            console.error("    - " + e);
    }
    // 无记录也算成功（允许空集起步）；有失败则退出码 1
    process.exit(fail > 0 ? 1 : 0);
}
