import { isStructuredMemoryBody } from "./memory-body.js";
/**
 * MemoryOS v0.3 — 巩固守护进程（M-2.1）
 * 三种运行态：
 *   node dist/daemon.js                常驻（先跑一轮，之后每小时）
 *   node dist/daemon.js --once         单跑一轮即退
 *   node dist/daemon.js --once --dry-run  只输出计划，不落库（事务回滚预演）
 * 三个任务（apply 时单事务，全成或全回滚）：
 *   ① 衰减    eff = conf × 0.5^(闲置天数 / (30 × e^(0.15×hits)))；decision 不衰减
 *   ② 归档    eff < 0.1 或 45 天无曝光 → status='archived'（写 daemon_log 留痕，不删除）
 *   ③ 去重    sim>0.96 合并，存活者=命中多者；跨来源印证 conf+0.1；LIMIT 50/轮
 * 验收：--once --dry-run 输出计划且不落库。
 */
import { openDb, listEffRows, setEff, archiveMemory, archiveTrial, markMerged, logDaemon, setStatus, readConfig, writeConfig, checkpointWal, backupDb, upsertVector, SECTORS, writeMemory, readMemory, foldInto } from "./db.js";
import { cosine, getEmbedder, embedderProvenance } from "./embed.js";
import { reconcileTasksAndCards, evolutionRegressionGate } from "./reconcile.js";  // ★ P2-6（C-5）三方对账 + P2 进化双回归门
import { gateBreakerOn } from "./task-domain.js"; // ★ B3（P2）：门控连续失败熔断开关（领域层解析器，env 由下方主块 config 回填）
import { maybeRunRuleReflection } from "./rule-reflection.js"; // ★ 批次⑧：每日规则反思生产线（钩子在 run() 治理链内）
import { maybeDistillGraph } from "./graph-distill.js"; // ★ P1-C（2026-10-13）：知识图谱蒸馏（memory→memory 关系，24h 窗口）
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export const DEFAULT_HYGIENE_CONFIG = {
    archiveEff: 0.1,
    archiveAgeDays: 45,
    dedupeSim: 0.96,
    dedupeRoundLimit: 10,
    qPromote: 0.65,
    trialAgeDays: 30,
    trialPolicy: "lenient",
    // ★ 2026-10-15（代为提交时回退，如实记录）：原拟新增 `hitCap`（命中数封顶）并让 computeDecay 的 λ 乘
    //   `e^(-0.15×hits)`。但**本仓并不存在任何"命中项"公式**（search.js 里的 0.15 是 `eff<=0.15` 召回闸门，
    //   hit_count 只用于命中回血），该前提不成立 ⇒ 一旦接入即**新造**「命中越多衰减越慢」语义，与检索侧
    //   现算 eff（sector-λ、无命中项）口径分裂，并直接击穿守护断言 D7（归档阈值可配置，实测红）。
    //   故回退：λ 保持原式。若确需接入，须先取得用户授权，并**同时**统一检索侧口径 + 修订守护断言。
};
/** 读治理配置：config 表有则用（部分覆盖），否则全量走默认。 */
export function loadHygieneConfig(db) {
    const stored = readConfig(db, "hygiene", {});
    return { ...DEFAULT_HYGIENE_CONFIG, ...(stored ?? {}) };
}
const Q_WEIGHT = { completeness: 0.4, confidence: 0.2, adoption: 0.25, freshness: 0.15 };
const Q_PROMOTE = 0.65; // 质量分及格线（与「曝光 OR 高分」双条件并列）。0.65 标定自真实库分布断层（见脚本校准）
/** 多因子质量评分（0~1）：completeness 0.4 / confidence 0.2 / adoption 0.25 / freshness 0.15。
 *  进攻型：识别「质量高但未被搜索命中」的好样本，弥补 trial 只看 0 曝光就杀的粗糙。 */
export function qualityScore(m) {
    // completeness：decision/convention 默认完整；正文有结论+依据（字数适中）加分
    const content = m.content ?? "";
    let comp = m.type === "decision" || m.type === "convention" ? 0.8 : 0.5;
    if (content) {
        const len = content.trim().length;
        if (len >= 40 && len <= 800)
            comp = Math.min(1, comp + 0.2);
        else if (len > 0 && len < 40)
            comp = Math.max(0, comp - 0.2);
    }
    // confidence 归一化（0~1 已自然满足）
    const conf = Math.max(0, Math.min(1, m.confidence));
    // adoption：命中采纳度，hit 越多越高（5 次饱和）
    const adoption = Math.min(1, (m.hit_count ?? 0) / 5);
    // freshness：30 天内满值，之后渐衰（130 天归 0）
    const age = daysSince(m.created_at);
    const freshness = Math.max(0, Math.min(1, 1 - Math.max(0, age - 30) / 100));
    const s = Q_WEIGHT.completeness * comp +
        Q_WEIGHT.confidence * conf +
        Q_WEIGHT.adoption * adoption +
        Q_WEIGHT.freshness * freshness;
    return Math.max(0, Math.min(1, s));
}
/** 纯 JS 日期差（天），避免每次调用新建 DB 实例。ISO8601 字符串或 'now' 均可输入。 */
function daysSince(iso) {
    if (iso === "now")
        return 0;
    const then = new Date(iso).getTime();
    const now = Date.now();
    if (Number.isNaN(then))
        return 0;
    return Math.max(0, (now - then) / 86400000);
}
export { daysSince };
/** 对全部 active 记忆计算衰减 eff（★ R4-5/M9：sector-λ 惰性公式，与 search.js 检索口径一致：
 *   eff = salience × e^(-λ·Δt)，Δt 以天计，基准 = last_seen_at ?? last_hit_at ?? created_at；
 *   pinned=1 免衰减；λ = decay_lambda ?? 类默认。daemon 刷写仅供归档判定，检索已改查询时现算。
 *   ★ 2026-10-15（代为提交时回退，如实记录）：原拟按 hit_count 封顶微调 λ（λ × e^(-0.15×hits)），
 *   但本仓并无任何命中项公式（前提不成立，且会与检索侧现算 eff 口径分裂、击穿 D7 守护断言）⇒ 已回退，
 *   λ 保持 `decay_lambda ?? 类默认`；命中数只在检索侧作回血。 */
export function computeDecay(rows) {
    const ops = [];
    for (const r of rows) {
        // ★ 2026-09-15 回归修复（与 computeArchives 同一处丢失的豁免）：decision 不衰减。
        //   sector/salience 重构把旧式 `r.type === "decision" ? r.confidence : …` 统一成 salience×e^(-λΔt)，
        //   漏掉了 decision 分支，导致 D1 断言（eff=conf=0.9）失败、且头部 ① 的既定语义失效。
        if (r.pinned || r.type === "decision") {
            ops.push({ id: r.id, eff: r.salience, previous: r.eff_confidence, type: r.type });
            continue;
        }
        const last = r.last_seen_at ?? r.last_hit_at ?? r.created_at;
        const days = daysSince(last);
        const lambda = r.decay_lambda ?? SECTORS[r.sector]?.lambda ?? 0.01;
        const eff = r.salience * Math.exp(-lambda * days);
        ops.push({ id: r.id, eff: Number(eff.toFixed(4)), previous: r.eff_confidence, type: r.type });
    }
    return ops;
}
/** 由衰减结果 + 曝光龄判归档候选（eff<archiveEff 或 archiveAgeDays 天无曝光）。
 *  接受 computeDecay 的结果 map 直接复用，避免二次计算。 */
export function computeArchives(rows, decayMap, cfg = DEFAULT_HYGIENE_CONFIG) {
    const out = [];
    for (const r of rows) {
        // ★ 2026-09-15 回归修复：decision「永不衰减 + 不自动归档」的豁免在 sector/salience 重构时
        //   被 pinned 判断取代而丢失（旧版为 `if (r.type === "decision") continue;`），
        //   导致超期 decision 被 stale 规则归档 —— 与本文件头部 ①/② 的既定语义冲突。
        if (r.pinned || r.type === "decision")
            continue;
        const last = r.last_seen_at ?? r.last_hit_at ?? r.created_at;
        const days = daysSince(last);
        const eff = decayMap.get(r.id) ?? r.confidence;
        if (eff < cfg.archiveEff) {
            out.push({ id: r.id, eff, reason: "eff", daysSinceExposure: days, type: r.type });
        }
        else if (days > cfg.archiveAgeDays) {
            out.push({ id: r.id, eff, reason: "stale", daysSinceExposure: days, type: r.type });
        }
    }
    return out;
}
/** 去重扫描：active 且有向量，两两 sim>cfg.dedupeSim → winner=命中多者（平手保留 id 小）。LIMIT cfg.dedupeRoundLimit/轮 */
export function computeDedupes(rows, cfg = DEFAULT_HYGIENE_CONFIG) {
    const vec = rows.filter((r) => r.vec);
    const out = [];
    // ★ P2-perf：对归一化向量，cos>TH 的必要条件是平方距离 ‖a-b‖² = 2-2cos < 2-2·TH；
    // 先算 ‖a-b‖²（免 sqrt/除法），过了门才跑精确 cosine（零漏检，结果等价）。
    // 实测 n=1367：1226ms→701ms（1.7×）。
    // ★ P3-perf：大维向量（dim≥256）再走随机投影 L2 下界粗预筛（JL 不等式）：
    //   CMIN·Σ_m(Δp_m)²/M 是 ‖a-b‖² 的下界，下界超门即跳过（零漏检：真实距离≥下界）；
    //   过门对仍跑精确 cosine，winner/loser 判定不变 → 结果集与无预筛等价。
    //   固定种子保证跨轮治理决策可复现；小维测试向量（<256，如 fake dim=8）回落 P2 平方门，行为不变。
    //   实测 n=1367（1024 维）：701ms→311ms（2.3×，含一次性投影预计算 263ms）。
    //   已否决：int8 分块倒排粗筛（int8 碰撞过密→候选集清零漏检，实测 pairsChecked=0）。
    const sqGate = 2 - 2 * (cfg.dedupeSim ?? 0.96);
    const JL_M = 64;
    const JL_CMIN = 0.85;
    let proj = null;
    const dim0 = vec.length ? vec[0].vec.length : 0;
    if (dim0 >= 256) {
        let seed = 0xc0ffee;
        const rnd = () => {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        // 共享随机矩阵：同一矩阵投所有向量（JL 不等式前提）—— 真重复对投影相同，s=0 必过门，不漏检
        const mat = new Float64Array(JL_M * dim0);
        for (let m = 0; m < JL_M; m++)
            for (let k = 0; k < dim0; k++)
                mat[m * dim0 + k] = rnd() * 2 - 1;
        proj = vec.map((r) => {
            const p = new Float64Array(JL_M);
            for (let m = 0; m < JL_M; m++) {
                let s = 0;
                const base = m * dim0;
                for (let k = 0; k < dim0; k++)
                    s += mat[base + k] * r.vec[k];
                p[m] = s;
            }
            return p;
        });
    }
    for (let i = 0; i < vec.length && out.length < cfg.dedupeRoundLimit; i++) {
        for (let j = i + 1; j < vec.length && out.length < cfg.dedupeRoundLimit; j++) {
            const a = vec[i];
            const b = vec[j];
            if (proj) {
                let s = 0;
                const pa = proj[i], pb = proj[j];
                for (let m = 0; m < JL_M; m++) {
                    const d = pa[m] - pb[m];
                    s += d * d;
                }
                if (JL_CMIN * (s / JL_M) >= sqGate)
                    continue; // L2 下界已超门 → cos≤TH 必不合并（零漏检）
            }
            else {
                let sq = 0;
                const av = a.vec, bv = b.vec;
                for (let k = 0; k < av.length; k++) {
                    const dd = av[k] - bv[k];
                    sq += dd * dd;
                }
                if (sq >= sqGate)
                    continue;
            }
            const sim = cosine(a.vec, b.vec);
            if (sim > cfg.dedupeSim) {
                const aWin = a.hit_count > b.hit_count || (a.hit_count === b.hit_count && a.id < b.id);
                const winner = aWin ? a : b;
                const loser = aWin ? b : a;
                out.push({ winner: winner.id, loser: loser.id, sim, crossSource: winner.agent !== loser.agent });
            }
        }
    }
    return out;
}
/** 试用期考核（第 4 任务）：decision 免考核立即转正；非 decision 以 created_at 记龄 ≥cfg.trialAgeDays 天才判，
 *  曝光(hit≥1 或 last_hit_at 非空) → promote active；零曝光但质量分≥cfg.qPromote → 也 promote（质量感知，防误杀好样本）；否则 archive。 */
export function computeTrials(rows, cfg = DEFAULT_HYGIENE_CONFIG) {
    const out = [];
    for (const r of rows) {
        const age = Math.floor(daysSince(r.created_at));
        if (r.type === "decision") {
            out.push({ id: r.id, type: r.type, action: "promote", ageDays: age, hits: r.hit_count });
            continue;
        }
        if (age < cfg.trialAgeDays)
            continue; // 考核期未满，暂不动
        if (cfg.trialPolicy === "lenient") {
            // 宽松策略：trial 阶段不做质量淘汰，一律放行转正。
            // 淘汰交给 active 层 —— eff 衰减到 <archiveEff 或 archiveAgeDays 天零曝光，由 computeArchives 自然收敛。
            out.push({ id: r.id, type: r.type, action: "promote", ageDays: age, hits: r.hit_count });
            continue;
        }
        const exposed = r.hit_count >= 1 || !!r.last_hit_at;
        // 质量感知：虽零曝光，但多因子质量达标也转正（进攻型——识别"好但没被搜到"的记忆）
        const q = qualityScore({ type: r.type, confidence: r.confidence, hit_count: r.hit_count, created_at: r.created_at, content: r.content });
        out.push({ id: r.id, type: r.type, action: exposed || q >= cfg.qPromote ? "promote" : "archive", ageDays: age, hits: r.hit_count });
    }
    return out;
}
/** 生成计划（纯计算，不落库）——dry-run 复用 */
export function buildPlan(db) {
    const cfg = loadHygieneConfig(db);
    const rows = listEffRows(db).map((r) => ({
        id: r.id,
        type: r.type,
        agent: r.agent,
        confidence: r.confidence,
        eff_confidence: r.eff_confidence,
        hit_count: r.hit_count,
        last_hit_at: r.last_hit_at,
        last_seen_at: r.last_seen_at,
        created_at: r.created_at,
        sector: r.sector,
        salience: r.salience,
        decay_lambda: r.decay_lambda,
        pinned: r.pinned,
        vec: r.vec,
    }));
    const decays = computeDecay(rows);
    const decayMap = new Map(decays.map((d) => [d.id, d.eff]));
    // 试用期考核：读取 status='trial' 的记忆（含 content，供质量分判断完整性）
    const trialRows = db
        .prepare(`SELECT id, type, agent, content, confidence, eff_confidence, hit_count, last_hit_at, last_seen_at, created_at, sector, salience, decay_lambda, pinned FROM memories WHERE status='trial'`)
        .all().map((r) => ({
        id: Number(r.id), type: r.type, agent: r.agent, content: r.content, confidence: r.confidence, eff_confidence: r.eff_confidence,
        hit_count: Number(r.hit_count), last_hit_at: r.last_hit_at, last_seen_at: r.last_seen_at, created_at: r.created_at,
        sector: r.sector ?? "episodic", salience: r.salience == null ? 1.0 : Number(r.salience),
        decay_lambda: r.decay_lambda, pinned: Number(r.pinned ?? 0), vec: null,
    }));
    return {
        decays,
        archives: computeArchives(rows, decayMap, cfg),
        dedupes: computeDedupes(rows, cfg).filter(d => {
            const a=readMemory(db,d.winner), b=readMemory(db,d.loser);
            return !a || !b || (!(isStructuredMemoryBody(a.content)||isStructuredMemoryBody(b.content)||a.source==="agent"||b.source==="agent")) || a.content===b.content;
        }),
        trials: computeTrials(trialRows, cfg),
    };
}
/** 落库（单事务，全成或全回滚）。dryRun=true 只打印不写。返回总结字符串。 */
export function applyPlan(db, plan, dryRun) {
    const archIds = new Set(plan.archives.map((a) => a.id));
    const lines = [];
    if (dryRun) {
        lines.push(`[dry-run] 计划：衰减 ${plan.decays.length}，归档 ${plan.archives.length}，去重 ${plan.dedupes.length}，试用考核 ${plan.trials.length}`);
        plan.archives.slice(0, 20).forEach((a) => lines.push(`  dry 归档 #${a.id} [${a.type}] eff=${a.eff} ${a.daysSinceExposure.toFixed(0)}天无曝光 (${a.reason})`));
        plan.dedupes.slice(0, 20).forEach((d) => lines.push(`  dry 去重 #${d.loser} → #${d.winner} (sim=${d.sim.toFixed(3)}${d.crossSource ? ", 跨来源conf+0.1" : ""})`));
        plan.trials.slice(0, 20).forEach((t) => lines.push(`  dry 试用 #${t.id} [${t.type}] ${t.ageDays}d ${t.action === "promote" ? "转正active" : "归档"} (hits=${t.hits})`));
        lines.push("  （dry-run：不落库）");
        return lines.join("\n");
    }
    db.exec("BEGIN");
    try {
        // ① 衰减
        for (const op of plan.decays) {
            setEff(db, op.id, op.eff);
            logDaemon(db, { task: "decay", op: "eff_update", memory_id: op.id, detail: `conf→eff: ${op.eff}` });
        }
        // ② 归档（仅 active，且排去重合并（merged 不归档）在后续步骤自然排除）
        const dedupeLosers = new Set(plan.dedupes.map((d) => d.loser));
        for (const a of plan.archives) {
            if (dedupeLosers.has(a.id))
                continue; // 同轮被去重合并的不归档
            archiveMemory(db, a.id);
            logDaemon(db, {
                task: "archive",
                op: "archive",
                memory_id: a.id,
                detail: `eff=${a.eff}, ${a.daysSinceExposure.toFixed(0)}d无曝光 (${a.reason})`,
            });
        }
        // ③ 去重（loser→merged + superseded_by；跨来源保留审计，不自动加置信度）
        let appliedDedupes = 0;
        for (const d of plan.dedupes) {
            const loser = readMemory(db, d.loser);
            const winner = readMemory(db, d.winner);
            if (loser && winner && (isStructuredMemoryBody(loser.content)||isStructuredMemoryBody(winner.content)||winner.source==="agent"||loser.source==="agent")) {
                if (loser.content !== winner.content) continue; // 兼容旧计划，保留不同智能体正文供人工结构化修订
            }
            if (loser && !(winner && loser.content === winner.content)) foldInto(db, d.winner, loser.content, { fromId: d.loser, agent: loser.agent });
            markMerged(db, d.loser, d.winner);
            appliedDedupes++;
            // 跨来源重复也可能来自同一原始结论，不自动增加置信度。
            logDaemon(db, {
                task: "dedupe",
                op: "merge",
                memory_id: d.loser,
                detail: `→ #${d.winner} sim=${d.sim.toFixed(3)}${d.crossSource ? ", 保留来源，置信度不变" : ""}`,
            });
        }
        // ④ 试用考核：promote → active；archive → archived（快速淘汰）
        for (const t of plan.trials) {
            if (t.action === "promote") {
                setStatus(db, t.id, "active");
                logDaemon(db, { task: "trial", op: "promote", memory_id: t.id, detail: `${t.ageDays}d ${t.hits}hit → active` });
            }
            else {
                archiveTrial(db, t.id);
                logDaemon(db, { task: "trial", op: "archive", memory_id: t.id, detail: `${t.ageDays}d 0曝光 → archived` });
            }
        }
        db.exec("COMMIT");
        // 治理落库后收拢 WAL（PASSIVE：尽力而为、不阻塞其他连接读取；失败不影响治理结果）
        try {
            db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        }
        catch (e) {
            console.error(`[daemon] WAL 收拢失败（PASSIVE，不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
        }
        lines.push(`已应用：eff更新 ${plan.decays.length}，归档 ${plan.archives.length}，去重 ${appliedDedupes}，试用考核 ${plan.trials.length}`);
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    return lines.join("\n");
}
/**
 * ★ P1-2.4 重算 stale 向量。
 * updateMemory 只置 embedding_stale=1（它是同步 API，无法等待异步嵌入计算），
 * 由 daemon 每轮限量重算，恢复「正文 ↔ 向量」的语义一致。
 * 限量（默认 20/轮）避免一次性大批量嵌入长时间占用。
 */
export async function reembedStale(db, limit = 20) {
    const pendingAll = db.prepare(`SELECT COUNT(*) c FROM memories WHERE embedding_stale = 1`).get().c;
    if (pendingAll === 0)
        return { done: 0, failed: 0, pending: 0 };
    const rows = db
        .prepare(`SELECT id, content FROM memories WHERE embedding_stale = 1 ORDER BY id LIMIT ?`)
        .all(limit);
    const embedder = await getEmbedder();
    // ★ P1-2.2：向量写入独立表；memories 侧只清 stale 标记
    const clearStale = db.prepare(`UPDATE memories SET embedding_stale = 0 WHERE id = ?`);
    // ★ 2026-10-15：向量带出处——重算时随向量落 embed_model/dim，修正存量 'unknown' 出处
    const prov = embedderProvenance();
    let done = 0;
    let failed = 0;
    for (const r of rows) {
        try {
            const [vec] = await embedder.embedTexts([r.content]);
            if (!vec) {
                failed++;
                continue;
            }
            upsertVector(db, r.id, vec, { model: prov.model, dim: prov.dim });
            clearStale.run(r.id);
            done++;
        }
        catch (e) {
            failed++;
            console.error(`[reembed] #${r.id} 失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { done, failed, pending: Math.max(0, pendingAll - done) };
}
/**
 * 长期治理一轮（每小时）：
 *  ① 租约贴条（⑦/H3 演进）：过期 running 打 lease_notice_at（不抢回）；超期裁决由 reapExpiredLeases 阶段二处理（⑧ 只标不回收）
 *  ② triage 超时（M1）：>24h → todo + auto_refine
 *  ③ 熔断：failed≥2 → blocked + circuit_break
 *  ④ 依赖提升（M3）：todo 且 depends 全已满足（done/archived）→ ready + auto_ready
 *  ⑤ working 清理（H2/R4-2）：updated_at < now-24h 物理 DELETE
 *  ⑥ 保留策略（R4-1）：card_events>180d / memory_usage>90d 归档到 *_archive；archived 卡片>30d 追加 jsonl
 *  ⑦ waypoint 预计算（R4-4）：距上次 >24h 才对 top-500 高频记忆重算一跳邻居命中计数
 * 全部幂等（状态前置 WHERE），daemon 与 dashboard /api/dispatch 并发安全。
 */
/**
 * ★ 2026-09-14：卡片 ↔ MCP 任务派发桥（双向闭环，全公开池）。
 *  方向① 卡→任务：把 status='ready' 且尚未派发的卡片转成 memories.type='task'
 *          （头 `[task][assignee:?][status:pending]`，assignee=? 即公开，任意 agent 可 task_next/task_claim）。
 *          card_memory 写 relation='dispatch'，作为「已派发 + 回写反查」锚点（幂等防重放）。
 *  方向② 任务→卡：扫描 type='task' 且 status='done' 的记忆，经 discharge card_memory 反查卡片，
 *          卡片未 done 则置 done（依赖卡随之被 housekeep ④ 自动提 ready）。
 * 全部幂等；异常不阻断（返回已派发/已回写统计）。
 */
export function syncTaskBridge(db) {
    const out = { dispatched: 0, syncedDone: 0, syncedRunning: 0 };
    try {
        // 方向① ready 卡 → task 记忆
        // ★ 2026-10-05：带出 meta —— 派生后写回必须**合并**而非覆盖（见 426 行注释）
        const ready = db.prepare(`SELECT id, title, body, priority, meta FROM cards WHERE status='ready'`).all();
        for (const c of ready) {
            const already = db.prepare(`SELECT 1 FROM card_memory WHERE card_id=? AND relation='dispatch'`).get(c.id);
            if (already)
                continue;
            // ★ 2026-09-14：跨链路同主题去重 —— 防「task_assign 直写 + dispatcher 再派生」双套。
            // task_assign 只写 memories（不写 card_memory），dispatcher 感知不到 → 会对 ready 卡片重复派生一遍。
            // 用卡片标题压缩锚做 LIKE 查重：命中现有 active/trial 任务即视为已派发，跳过 + 记 card_event 可审计。
            const titleAnchor = (c.title || "")
                .replace(/\s+/g, "")
                .replace(/[\[\]【】():;，。：、]/g, "")
                .slice(0, 10);
            if (titleAnchor.length >= 6) {
                const dup = db
                    .prepare(`SELECT id FROM memories WHERE type='task' AND status IN ('active','trial') AND content LIKE '%'||?||'%' ORDER BY id LIMIT 1`)
                    .get(titleAnchor);
                if (dup) {
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                        .run(c.id, "dispatcher", "dedupe_skip", "ready", "ready", `已存在同主题任务 #${dup.id}，跳过再派生（防双套）`);
                    continue;
                }
            }
            const deps = db.prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`).all(c.id)
                .map((d) => Number(d.dst_id)).filter(Number.isFinite);
            // 全公开池：assignee=? ；若卡指定 assignee 则顺带给该 agent
            const assignee = c.body && typeof c.body === "string" ? (c.body.match(/\[assignee:([^\]]+)\]/) || [])[1] : null;
            const body = `${c.title}${c.body ? "\n" + c.body : ""}`.slice(0, 2000);
            const head = `[task][assignee:${assignee || "?"}][status:pending]`;
            const depStr = deps.length ? ` [depends:${deps.join(",")}]` : "";
            const row = writeMemory(db, {
                content: `${head}${depStr} ${body}`,
                type: "task",
                agent: "dispatcher",
                agent_fpath: null,
                project: "global",
                sector: "social",
                source_ref: `card:${c.id}`,
            });
            db.prepare(`INSERT INTO card_memory(card_id, memory_id, relation) VALUES (?,?,?)`).run(c.id, row.id, "dispatch");
            // ★ 2026-10-05：meta 必须**合并写回**（原为 JSON.stringify({dispatch_memory_id}) 整体覆盖）。
            //   覆盖的实证后果：智能体卡的 profile_id（载体/通道的唯一绑定依据）与任务卡的 map_pos
            //   （用户拖拽定位）被一并抹掉 —— 智能体卡随后在任务地图被误判「⚠️ 载体缺失」、
            //   派发被前端按 carrier_missing 拦死；任务卡拖完位置被这轮派生悄悄清空。
            let curMeta = {};
            try {
                const parsed = JSON.parse(c.meta || "{}");
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                    curMeta = parsed;
            }
            catch { /* meta 非法：从空对象起，保底不让派生链断（原实现同样丢弃） */ }
            curMeta.dispatch_memory_id = row.id;
            db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify(curMeta), c.id);
            out.dispatched++;
        }
        // 方向② task 状态记忆 → 关联卡片同步（done→done, in_progress→running）
        const doneTasks = db.prepare(`SELECT cm.card_id, cm.memory_id FROM card_memory cm
       JOIN memories m ON m.id=cm.memory_id
       WHERE cm.relation='dispatch' AND m.type='task' AND m.status IN ('active','trial')`).all();
        for (const d of doneTasks) {
            const m = db.prepare(`SELECT content, status FROM memories WHERE id=?`).get(d.memory_id);
            if (!m)
                continue;
            // 记忆生命周期用 internal status 判定：读 content 头
            const stm = m.content.match(/\[status:([^\]]+)\]/);
            if (!stm)
                continue;
            const taskStatus = stm[1];
            const card = db.prepare(`SELECT status FROM cards WHERE id=?`).get(d.card_id);
            if (!card)
                continue;
            // done → done（不覆盖 archived 终态）
            if (taskStatus === "done") {
                if (card.status === "done" || card.status === "archived")
                    continue;
                db.prepare(`UPDATE cards SET status='done', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(d.card_id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                    .run(d.card_id, "dispatcher", "auto_done", card.status, "done", `MCP 任务 #${d.memory_id} 完成，卡片同步`);
                out.syncedDone++;
            }
            // in_progress → running（不覆盖 done/archived 终态，已是 running 则跳过）
            else if (taskStatus === "in_progress") {
                if (card.status === "running" || card.status === "done" || card.status === "archived")
                    continue;
                db.prepare(`UPDATE cards SET status='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(d.card_id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                    .run(d.card_id, "dispatcher", "auto_running", card.status, "running", `MCP 任务 #${d.memory_id} 进行中，卡片同步`);
                out.syncedRunning++;
            }
        }
    }
    catch (e) {
        console.error(`[syncTaskBridge] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
}
export function housekeepBoard(db, opts = {}) {
    const out = { leased_back: 0, auto_refined: 0, circuit_break: 0, promoted: 0, working_cleared: 0, events_archived: 0, usage_archived: 0, cards_jsonl: 0, waypoints: 0 };
    const now = opts.nowIso ?? new Date().toISOString();
    const ev = (cardId, action, from, to, detail) => db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cardId, "dispatcher", action, from, to, detail);
    db.exec("BEGIN IMMEDIATE");
    try {
        // ① 租约贴条（⑦/H3 演进）：过期 running 打 lease_notice_at 标记，**不抢回**（卡保持 running 与任务头
        //    一致，防震荡防误杀）；超期裁决由 reapExpiredLeases 阶段二统一处理（⑧ 只标不回收，不抢回）。
        //    replace(' ','T')：lease_expires_at 存量为 SQLite 空格格式，与 JS ISO 裸比较「同日恒真」，先归一再比。
        const expired = db.prepare(`SELECT id, assignee FROM cards WHERE status='running' AND lease_expires_at IS NOT NULL AND replace(lease_expires_at,' ','T') < ? AND lease_notice_at IS NULL`).all(now);
        for (const e of expired) {
            const upd = db.prepare(`UPDATE cards SET lease_notice_at=?, updated_at=? WHERE id=? AND status='running' AND lease_notice_at IS NULL`).run(now, now, e.id);
            if (Number(upd.changes) === 0)
                continue;
            ev(e.id, "lease_expired", "running", "running", `租约过期（原 ${e.assignee ?? "?"}）——贴条待确认：heartbeat 续期 / 收口；超 24h 无人理转「待裁决」（⑧ 只标不回收）`);
            out.leased_back++;
        }
        // ② triage 超时（C4：判定时间可配——#9「人成瓶颈」的缩短自动回收判定时间；默认 24h 不变）
        const refineH = Math.max(0.5, Number(process.env.CARD_AUTO_REFINE_HOURS ?? 24) || 24);
        const stale = db.prepare(`SELECT id FROM cards WHERE status='triage' AND created_at < datetime('now', ?)`).all(`-${refineH} hours`);
        for (const s of stale) {
            db.prepare(`UPDATE cards SET status='todo', updated_at=? WHERE id=? AND status='triage'`).run(now, s.id);
            ev(s.id, "auto_refine", "triage", "todo", `${refineH}h 未动自动提升`);
            out.auto_refined++;
        }
        // ③ 熔断
        const failed = db.prepare(`SELECT id FROM cards WHERE status='failed' AND failure_count>=2`).all();
        for (const f of failed) {
            db.prepare(`UPDATE cards SET status='blocked', updated_at=? WHERE id=? AND status='failed'`).run(now, f.id);
            ev(f.id, "circuit_break", "failed", "blocked", "连续失败≥2 熔断");
            out.circuit_break++;
        }
        // ③-b ★ B3（2026-10-18 · P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：gate 连续失败熔断。
        //   gate 失败卡回 ready（fail-closed 可重试），上方 failed 判据永远看不到它（问题 #6：缺陷任务
        //   被反复领取而熔断失明）。扩展判据：ready 且 gate_fail_count>=2 → blocked；计数在
        //   task-domain 门控失败路径 +1，成功收口/人工介入清零（agent 重领不清零）。
        if (gateBreakerOn()) {
            const gateFailed = db.prepare(`SELECT id FROM cards WHERE status='ready' AND gate_fail_count>=2`).all();
            for (const f of gateFailed) {
                db.prepare(`UPDATE cards SET status='blocked', updated_at=? WHERE id=? AND status='ready'`).run(now, f.id);
                ev(f.id, "circuit_break", "ready", "blocked", "gate 连续失败≥2 熔断");
                out.circuit_break++;
            }
        }
        // ④ 依赖提升（只认 depends；被依赖全 done/archived —— archived 是 done 的下游终态）
        const todos = db.prepare(`SELECT id FROM cards WHERE status='todo'`).all();
        for (const t of todos) {
            const deps = db.prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`).all(t.id);
            const allDone = deps.every((d) => {
                const s = db.prepare(`SELECT status FROM cards WHERE id=?`).get(d.dst_id);
                // ★ 与 dashboard-reg-cards.js `DEP_SATISFIED` 同口径：archived 是 done 的下游终态（干完并归档），
                //   只认 done 会让「依赖已归档」的 todo 卡永久提升不了 → 与派发入口同一死锁（2026-10-05 根治）。
                return !!s && (s.status === "done" || s.status === "archived");
            });
            if (allDone) {
                db.prepare(`UPDATE cards SET status='ready', updated_at=? WHERE id=? AND status='todo'`).run(now, t.id);
                ev(t.id, "auto_ready", "todo", "ready", "依赖已满足");
                out.promoted++;
            }
        }
        // ⑤ working 清理：会话 24h 无更新 → 物理 DELETE（H2：不进 memories，杜绝僵尸行）
        const w = db.prepare(`DELETE FROM working_memory WHERE updated_at IS NULL OR updated_at < datetime('now','-24 hours')`).run();
        out.working_cleared = Number(w.changes);
        // ⑥ 保留策略归档（只归档不删除）
        const evRows = db.prepare(`SELECT * FROM card_events WHERE created_at < datetime('now','-180 days')`).all();
        if (evRows.length) {
            db.prepare(`INSERT OR IGNORE INTO card_events_archive SELECT * FROM card_events WHERE created_at < datetime('now','-180 days')`).run();
            db.prepare(`DELETE FROM card_events WHERE created_at < datetime('now','-180 days')`).run();
            out.events_archived = evRows.length;
        }
        const usRows = db.prepare(`SELECT * FROM memory_usage WHERE created_at < datetime('now','-90 days')`).all();
        if (usRows.length) {
            db.prepare(`INSERT OR IGNORE INTO memory_usage_archive SELECT * FROM memory_usage WHERE created_at < datetime('now','-90 days')`).run();
            db.prepare(`DELETE FROM memory_usage WHERE created_at < datetime('now','-90 days')`).run();
            out.usage_archived = usRows.length;
        }
        // archived 卡片 >30d → jsonl（幂等水位 config['retention.cards_maxid']）
        const maxId = Number(readConfig(db, "retention.cards_maxid", 0));
        const archivedCards = db
            .prepare(`SELECT id, board, kind, title, status, assignee, priority, meta, created_at, updated_at FROM cards WHERE status='archived' AND id > ? AND COALESCE(updated_at, created_at) < datetime('now','-30 days') ORDER BY id`)
            .all(maxId);
        if (archivedCards.length) {
            const outPath = opts.cardsArchivePath ?? fileURLToPath(new URL("../data/cards_archive.jsonl", import.meta.url));
            const lines = archivedCards.map((c) => JSON.stringify({ ...c, archived_at: now })).join("\n") + "\n";
            fs.appendFileSync(outPath, lines, "utf8");
            writeConfig(db, "retention.cards_maxid", archivedCards[archivedCards.length - 1].id);
            out.cards_jsonl = archivedCards.length;
        }
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    // ⑦ waypoint 预计算（R4-4，>24h 才重算）
    try {
        const lastWp = String(readConfig(db, "waypoint_ts", "") ?? "");
        if (!lastWp || Date.now() - Date.parse(lastWp) > 24 * 3600 * 1000) {
            const top = db.prepare(`SELECT id FROM memories WHERE status='active' ORDER BY hit_count DESC, COALESCE(last_seen_at, created_at) DESC LIMIT 500`).all();
            const topSet = new Set(top.map((t) => t.id));
            const neighborRows = db
                .prepare(`SELECT src_kind, src_id, dst_kind, dst_id FROM links WHERE dst_id IS NOT NULL`)
                .all();
            const counts = new Map();
            for (const l of neighborRows) {
                if (l.src_kind === "memory" && topSet.has(l.dst_id))
                    counts.set(l.src_id, (counts.get(l.src_id) ?? 0) + 1);
                if (l.dst_kind === "memory" && topSet.has(l.src_id))
                    counts.set(l.dst_id, (counts.get(l.dst_id) ?? 0) + 1);
            }
            const wp = {};
            for (const [id, n] of counts)
                wp[id] = Math.min(1, n / 3);
            writeConfig(db, "waypoints", wp);
            writeConfig(db, "waypoint_ts", now);
            out.waypoints = Object.keys(wp).length;
        }
    }
    catch (e) {
        console.error(`[daemon] waypoint 预计算失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ R6-6：补刷 last_seen_at（进程崩溃丢 hit 缓冲的自愈）——hit_count>0 且 last_seen 空 → 用 last_hit_at/created_at 回填
    try {
        const r6 = db.prepare(`UPDATE memories SET last_seen_at = COALESCE(last_hit_at, created_at) WHERE status='active' AND hit_count > 0 AND last_seen_at IS NULL`).run();
        if (r6.changes)
            console.log(`[housekeep] R6-6 补刷 last_seen_at ${r6.changes} 行`);
    }
    catch (e) {
        console.error(`[housekeep] R6-6 补刷失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ R4-3：未解析链接收敛（周扫）——30 天未解析 → config['unresolved_aging'] 待处理清单（前端 Obsidian 页待处理 tab 消费）
    try {
        const lastR43 = String(readConfig(db, "r43_last_run", "") ?? "");
        if (!lastR43 || Date.now() - Date.parse(lastR43) > 7 * 24 * 3600 * 1000) {
            const aged = db
                .prepare(`SELECT id, src_kind, src_id, dst_title, created_at FROM links WHERE dst_id IS NULL AND created_at < datetime('now','-30 days') ORDER BY created_at ASC LIMIT 500`)
                .all();
            writeConfig(db, "unresolved_aging", aged.map((r) => ({ link_id: r.id, src: `${r.src_kind}#${r.src_id}`, dst_title: r.dst_title, created_at: r.created_at })));
            writeConfig(db, "r43_last_run", now);
        }
    }
    catch (e) {
        console.error(`[housekeep] R4-3 未解析收敛失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
}
/* ── P1-3 / T6：ANALYZE 治理项（补「首次运行即执行」+ 24h 幂等）────────────
 *  背景：原实现只在每日 tick 触发，且真实库实测 sqlite_stat1 从未生成
 *  （config 无 maintenance.analyze_ts）→ 查询规划器缺统计信息，索引选择只能靠手工 EXPLAIN。
 *  本项：首次运行立即执行，此后按 minHours 幂等节流；时间戳写 config，供 /api/health 机读。 */
export function ensureAnalyze(db, { force = false, minHours = 24 } = {}) {
    const last = String(readConfig(db, "maintenance.analyze_ts", "") ?? "");
    const hours = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
    if (!force && hours < minHours)
        return { ok: true, skipped: true, last, hours: Number(hours.toFixed(1)) };
    try {
        db.exec("ANALYZE");
        const has = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name='sqlite_stat1'`).get().c > 0;
        const rows = has ? db.prepare(`SELECT COUNT(*) c FROM sqlite_stat1`).get().c : 0;
        const ts = new Date().toISOString();
        writeConfig(db, "maintenance.analyze_ts", ts);
        logDaemon(db, { task: "analyze", op: "stats", detail: `ANALYZE 完成：sqlite_stat1 ${rows} 行` });
        return { ok: true, skipped: false, ts, stat1Rows: rows };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logDaemon(db, { task: "analyze", op: "stats", detail: `ANALYZE 失败：${msg}` });
        return { ok: false, error: msg };
    }
}
/* ── P1-4 / T5：主库空闲页治理（阈值触发 + 默认关闭）──────────────────────
 *  背景变更：T5 原报「空闲页 72% 未回收」，2026-09-15 复测实为 13.2%
 *  —— 空闲页被新增数据吃掉（memories 905→1856），并非 VACUUM 的功劳。
 *  一次性 VACUUM 收益 ≈7MB，不抵「独占写锁 + 全库重写」成本 ⇒ 降级为阈值治理项。
 *  三重触发（全满足才执行）：① 显式开启 ② freelist/page_count > ratio ③ 距上次 ≥ minDays。
 *  执行前先 VACUUM INTO 快照（B2：WAL 下严禁复制 .db）。被其他连接占用时失败即放弃，下轮重试。 */
export function maybeVacuum(db, { dbPath = null, ratio = 0.3, minDays = 7 } = {}) {
    const enabled = String(process.env.MEMORYOS_AUTOVACUUM ?? "") === "1" || readConfig(db, "maintenance.autovacuum", false) === true;
    if (!enabled)
        return { ok: true, skipped: true, reason: "未开启（设 MEMORYOS_AUTOVACUUM=1 或 config['maintenance.autovacuum']=true）" };
    const one = (sql) => Number(Object.values(db.prepare(sql).get())[0]) || 0;
    const pageCount = one("PRAGMA page_count");
    const freelist = one("PRAGMA freelist_count");
    const pct = pageCount ? freelist / pageCount : 0;
    if (pct <= ratio)
        return { ok: true, skipped: true, reason: `空闲页 ${(pct * 100).toFixed(1)}% ≤ 阈值 ${(ratio * 100).toFixed(0)}%`, pageCount, freelist };
    const last = String(readConfig(db, "maintenance.vacuum_ts", "") ?? "");
    const days = last ? (Date.now() - new Date(last).getTime()) / 86400000 : Infinity;
    if (days < minDays)
        return { ok: true, skipped: true, reason: `距上次 VACUUM ${days.toFixed(1)} 天 < ${minDays} 天`, pageCount, freelist };
    let snapshot = null;
    if (dbPath) {
        const dir = dbPath.replace(/[^\\/]+$/, "") + "backup";
        snapshot = `${dir}/memory.db.pre-vacuum-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        try {
            fs.mkdirSync(dir, { recursive: true });
            db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`); // 目标文件必须不存在；单引号转义
        }
        catch (e) {
            console.error(`[daemon] VACUUM 前置快照失败（放弃本次 VACUUM，${snapshot}）: ${e instanceof Error ? e.message : String(e)}`);
            return { ok: false, error: `快照失败，已放弃 VACUUM：${e instanceof Error ? e.message : String(e)}` };
        }
    }
    try {
        db.exec("VACUUM");
    }
    catch (e) {
        console.error(`[daemon] VACUUM 失败（可能被其他连接占用，下轮重试）: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, error: `VACUUM 失败（可能被其他连接占用，下轮重试）：${e instanceof Error ? e.message : String(e)}`, snapshot };
    }
    const afterFreelist = one("PRAGMA freelist_count");
    const afterPages = one("PRAGMA page_count");
    const ts = new Date().toISOString();
    writeConfig(db, "maintenance.vacuum_ts", ts);
    logDaemon(db, { task: "vacuum", op: "reclaim", detail: `空闲页 ${(pct * 100).toFixed(1)}% → ${afterFreelist}/${afterPages}；快照 ${snapshot ?? "无"}` });
    return { ok: true, skipped: false, ts, before: Number((pct * 100).toFixed(1)), afterFreelist, afterPages, snapshot };
}
// ★ P0-B（2026-10-13）：任务结果驱动的降权——曝光 ≥5 且成功率 <20% 的记忆降权（salience *= 0.8）。
// decision/pinned 豁免；每轮最多处理 20 条；幂等（同一轮不重复降权，由 daemon_log 记录）。
export function pruneLowEfficiency(db, limit = 20) {
    const rows = db
        .prepare(`SELECT m.id, m.type, m.pinned, m.salience
       FROM memories m
       JOIN memory_task_outcomes o ON o.memory_id = m.id
       WHERE m.status='active' AND m.type NOT IN ('decision') AND m.pinned=0
         AND o.outcome IN ('success','failed')
       GROUP BY m.id
       HAVING SUM(o.outcome='failed') * 1.0 / COUNT(*) > 0.8
          AND COUNT(*) >= 5
       LIMIT ?`)
        .all(limit);
    if (!rows.length)
        return { pruned: 0 };
    for (const r of rows) {
        const newSalience = Number((r.salience * 0.8).toFixed(4));
        db.prepare(`UPDATE memories SET salience=? WHERE id=?`).run(newSalience, r.id);
        logDaemon(db, { task: "prune_low_eff", op: "salience_down", memory_id: r.id, detail: `salience→${newSalience}（成功率<20%，曝光≥5）` });
    }
    return { pruned: rows.length };
}

// —— CLI ——
/**
 * ★ P2-6（C-3 / #4199）→ ★ 一致性⑦（2026-09-19）→ ★ 批次 B1（2026-10-03）：租约到期守护 —— **只标不回收**。
 *  演进史：原语义（过期 running → ready 清锁）会「卡回 ready 但记忆头仍 in_progress → 对账再对齐回
 *  running → 再回收」无限震荡、任务头永久卡死；⑦ 改为两阶段但阶段②仍会「贴条超期 → 抢回放池」。
 *  B1 对标 orca「absence never authorizes destruction」：**沉默/缺席不是退出证明**，不得据此抢回。
 *    阶段一（贴条）：过期 running 卡打 lease_notice_at + lease_expired 事件，卡保持 running、锁保留
 *      —— 与任务头一致零震荡；认领者 task_heartbeat 续期 / task_done 收口即自动撕条。
 *    阶段二（**只标**）：贴条超 graceHours（默认 24h，MEMORYOS_LEASE_GRACE_HOURS 可覆盖）无人理 →
 *      给卡打 lease_stale_at 裁决标记（保持 running / 锁 / assignee 全保留）+ 关联 active dispatch 置
 *      state='stale'（"待裁决"）。**不改任务头、不清锁、不放回池子。**
 *   回收或继续必须走**正向动作**：原持有者 task_heartbeat（touchDispatchLease 顺带唤醒 stale→active）
 *    或 task_done 收口；他人 task_claim(takeover) 换代接管（createDispatch 会取代 stale 前驱）；
 *    显式 task_release 归还。G2 口径见《MemoryOS改造计划-20261002.md》。
 *  幂等由 lease_stale_at（NULL→打标 changes>0 才记账）与技术兜底；失败不阻断守护主流程。
 *  housekeepBoard ① 与 /api/dispatch ① 同贴条口径（三处互不抢回）。
 *  ⚠ 顺手修格式错位：lease_expires_at 存量含 SQLite 空格格式（datetime('now')），与 JS ISO 的 T/Z
 *  做裸字符串比较时「同日恒小于」→ 同日租约被即刻判过期；统一 replace(' ','T') 后再比，
 *  且 touchCardLease 新写入改用 strftime T 格式（双保险，老数据兼容）。
 */
export function reapExpiredLeases(db, opts = {}) {
  const out = { noticed: 0, staled: 0, reclaimed: 0 };
  const graceH = Math.max(0, Number(process.env.MEMORYOS_LEASE_GRACE_HOURS ?? opts.graceHours ?? 24));
  try {
    const now = new Date().toISOString();
    // —— 阶段一：贴条（卡保持 running，锁保留）——
    const expired = db.prepare(`SELECT id, assignee FROM cards WHERE status='running' AND lease_expires_at IS NOT NULL AND replace(lease_expires_at,' ','T') < ? AND lease_notice_at IS NULL`).all(now);
    for (const c of expired) {
      const upd = db.prepare(`UPDATE cards SET lease_notice_at=?, updated_at=? WHERE id=? AND status='running' AND lease_notice_at IS NULL`).run(now, now, c.id);
      if (Number(upd.changes) === 0)
        continue;
      db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, 'reaper', 'lease_expired', 'running', 'running', `租约过期（原 ${c.assignee ?? String.fromCharCode(63)}）——贴条待确认：task_heartbeat 续期或 task_done 收口；超 ${graceH}h 无人理转「待裁决」（只标不回收，⑧）`);
      out.noticed++;
    }
    // —— 阶段二：贴条超期无人理 → **只标不回收**（批次 B1；格式统一用 JS ISO 比较）——
    //   只做两件事：①卡打 lease_stale_at 裁决标记（running/锁/assignee 全保留）；②关联 active dispatch 置 stale。
    //   不改任务头、不放回池子、不清锁 —— 回收必须来自正向动作（heartbeat / takeover / release）。
    //   lease_stale_at 兼作幂等键：NULL→打标 changes>0 才记账，重复运行零副作用。
    const cutoff = new Date(Date.now() - graceH * 3600000).toISOString();
    const abandoned = db.prepare(`SELECT id, assignee, lease_notice_at FROM cards WHERE status='running' AND lease_notice_at IS NOT NULL AND lease_notice_at < ? AND lease_stale_at IS NULL`).all(cutoff);
    for (const c of abandoned) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const mark = db.prepare(`UPDATE cards SET lease_stale_at=?, updated_at=? WHERE id=? AND status='running' AND lease_stale_at IS NULL`).run(now, now, c.id);
          if (Number(mark.changes) === 0) {
            db.exec("ROLLBACK");
            continue;
          }
          const rel = db.prepare(`SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(c.id);
          const mid = rel ? Number(rel.memory_id) : null;
          let staled = 0;
          if (mid != null) {
            // 只动 active → stale；settled/released/superseded 等终态不覆盖（避免翻案已结算的尝试）
            staled = Number(db.prepare(`UPDATE dispatches SET state='stale' WHERE memory_id=? AND state='active'`).run(mid).changes ?? 0);
            if (staled > 0)
              db.prepare(`INSERT INTO memory_events(memory_id,op,payload,operator) VALUES (?,?,?,?)`).run(mid, "task_lease_stale", JSON.stringify({ card: c.id, by: "reaper", notice_at: c.lease_notice_at, assignee: c.assignee ?? null, grace_h: graceH }), "daemon:reaper");
          }
          db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, 'reaper', 'lease_stale', 'running', 'running', `贴条超 ${graceH}h 无人理（原 ${c.assignee ?? String.fromCharCode(63)}）——**只标不回收**：卡保持 running、锁保留${staled > 0 ? "、工作证置 stale" : ""}；回收需正向动作：heartbeat 复活 / task_claim(takeover) 接管 / task_release 归还（⑧）`);
          db.exec("COMMIT");
          out.staled++;
        }
        catch (e) {
          try { db.exec("ROLLBACK"); } catch (rbErr) { console.error(`[reaper] 回滚失败: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`); }
          throw e;
        }
      }
      catch (e) {
        console.error(`[reaper] 卡 #${c.id} 标记失败（下轮重试）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  catch (e) {
    console.error(`[reaper] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
  }
  out.reaped = out.staled; // 旧调用方/日志兼容别名（B1 后"回收"已不存在，别名指向"标记"数）
  return out;
}

const mainFile = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (mainFile === "daemon.js") {
    const args = process.argv.slice(2);
    const once = args.includes("--once");
    const dryRun = args.includes("--dry-run");
    const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url)); // fileURLToPath 正确 decode 中文路径
    const db = openDb(dbPath);
    // ★ B3（2026-10-18）：config.json 开关回填——与 dashboard.js:350-360 / server.js:93-102 同口径
    //   （显式 boolean 的 config 覆盖 env，防"以为关了其实开着"）。dataDir 推导复刻自 dashboard.js:188
    //   （MEMORYOS_DATA_DIR > MEMORY_DB 反推）；daemon 是第三个需 honoring config 的长驻进程。
    try {
        const _dd = process.env.MEMORYOS_DATA_DIR ?? (process.env.MEMORY_DB ? path.dirname(path.dirname(process.env.MEMORY_DB)) : "");
        if (_dd) {
            const _c = JSON.parse(fs.readFileSync(path.join(_dd, "config.json"), "utf8"));
            if (typeof _c.gateBreaker === "boolean")
                process.env.MEMORYOS_GATE_BREAKER = _c.gateBreaker ? "1" : "0";
        }
    }
    catch { /* 无 config.json 或解析失败：维持 env 原值（缺省关） */ }
    const run = async () => {
        const plan = buildPlan(db);
        const out = applyPlan(db, plan, dryRun);
        console.log(`[${new Date().toISOString()}] ${out}`);
        if (!dryRun) {
            // ★ P1-3 / T6：ANALYZE 置于治理链首位 —— 首次运行即执行，此后 24h 幂等；
            //   让后续 plan/housekeep 的查询在本轮就吃到统计信息。
            try {
                const an = ensureAnalyze(db);
                console.log(`[analyze] ${an.skipped ? `跳过（上次 ${an.last || "从未"}）` : `完成：sqlite_stat1 ${an.stat1Rows} 行 @ ${an.ts}`}`);
            }
            catch (e) {
                console.error(`[analyze] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ R4 长期治理：看板运维 + 保留策略 + working 清理 + waypoint 预计算（异常不阻断主治理）
            try {
                const hk = housekeepBoard(db);
                console.log(`[housekeep] 租约回收 ${hk.leased_back} / triage提升 ${hk.auto_refined} / 熔断 ${hk.circuit_break} / 依赖提升 ${hk.promoted} / working清理 ${hk.working_cleared} / events归档 ${hk.events_archived} / usage归档 ${hk.usage_archived} / 卡片jsonl ${hk.cards_jsonl} / waypoint ${hk.waypoints}`);
            }
            catch (e) {
                console.error(`[housekeep] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ 2026-09-14：卡片↔MCP 任务派发桥（ready 卡→公开任务池；agent done→卡片同步）
            try {
                const tb = syncTaskBridge(db);
                const rp = reapExpiredLeases(db);
                if (rp.noticed || rp.reclaimed) console.log(`[reaper] 租约贴条 ${rp.noticed} 张 / 超期放回 ${rp.reclaimed} 张`);
                if (tb.dispatched || tb.syncedDone || tb.syncedRunning) {
                    console.log(`[taskbridge] 派发卡片→任务 ${tb.dispatched} / 任务完成→卡片 ${tb.syncedDone} / 任务进行中→卡片 ${tb.syncedRunning}`);
                }
            }
            catch (e) {
                console.error(`[taskbridge] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-2.4 重算被编辑过正文的记忆向量（限量，避免阻塞）
            try {
                const re = await reembedStale(db, 20);
                if (re.done || re.failed) {
                    console.log(`[reembed] 重算 ${re.done} 条${re.failed ? `，失败 ${re.failed} 条` : ""}，剩余待算 ${re.pending} 条`);
                }
            }
            catch (e) {
                console.error(`[reembed] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P0-B（2026-10-13）：任务结果驱动降权（曝光 ≥5 且成功率 <20% → salience ×0.8）
            try {
                const pl = pruneLowEfficiency(db, 20);
                if (pl.pruned > 0)
                    console.log(`[prune-low-eff] 降权 ${pl.pruned} 条低效记忆`);
            }
            catch (e) {
                console.error(`[prune-low-eff] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ 批次⑧（2026-09-23）：每日规则反思生产线（≥21:00 水位检查 + 当日认领；
            //   与 dashboard 进程钩子互斥靠 config 认领门禁，异常只记日志不阻断治理）
            try {
                const rf = await maybeRunRuleReflection(db);
                if (rf.produced)
                    console.log(`[reflect] 产规则 ${rf.produced}/${rf.candidates} 条，注入段已刷新`);
            }
            catch (e) {
                console.error(`[reflect] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-C（2026-10-13）：知识图谱蒸馏（24h 窗口；LLM 失败不推进水位，次日补跑）
            try {
                const gd = await maybeDistillGraph(db);
                if (!gd.skipped && gd.inserted > 0)
                    console.log(`[graph-distill] 新关系 ${gd.inserted} 条（候选 ${gd.relations}，批 ${gd.batches}）`);
            }
            catch (e) {
                console.error(`[graph-distill] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-1.1 每日备份（VACUUM INTO）。daemon 每小时一轮，但备份以「当日文件已存在」
            //   判据幂等跳过，故实际每日一份。WAL 模式下直接 copy .db 会得到损坏备份，
            //   必须走 VACUUM INTO（事务一致快照 + 自包含单文件）。
            try {
                const bak = backupDb(db, dbPath, { keep: 7 });
                console.log(`[backup] ${bak.note}`);
            }
            catch (e) {
                console.error(`[backup] 备份失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-1.2 WAL 检查点：合并并截断 WAL，防止其无限增长
            //   （实测 data/memory.db-wal 曾达 27.1MB，与主库 53MB 同量级 → 读放大 + 崩溃恢复变慢）。
            //   若有其他连接在读，SQLite 只做部分合并并返回 busy —— 不算失败，下轮自然重试。
            const ck = checkpointWal(db);
            console.log(`[wal] ${ck.ok ? "checkpoint 完成" : "checkpoint 部分完成（下轮重试）"} :: ${ck.detail}`);
            // ★ P1-4 / T5：空闲页治理放最后（最重，需独占写锁）。默认关闭，三重阈值触发。
            try {
                const vc = maybeVacuum(db, { dbPath });
                console.log(`[vacuum] ${vc.skipped ? `跳过：${vc.reason}` : vc.ok ? `完成：空闲页 ${vc.before}% → ${vc.afterFreelist}/${vc.afterPages}；快照 ${vc.snapshot}` : `未执行：${vc.error}`}`);
            }
            catch (e) {
                console.error(`[vacuum] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (dryRun)
            process.exit(0);
    };
    if (once) {
        // ★ --once 模式必须等 run() 完整跑完（含异步 reembed/backup/wal）再退出；
        //   否则 process.exit(0) 会截断未 await 完的 backup/wal（实测备份不落地）。
        run()
            .then(() => process.exit(0))
            .catch((e) => {
            console.error(`[daemon] 运行失败: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
        });
    }
    else {
        run().catch((e) => console.error(`[daemon] 运行失败: ${e instanceof Error ? e.message : String(e)}`));
        setInterval(run, 60 * 60 * 1000); // 常驻每小时（重型治理：plan/housekeep/reembed/backup/wal）
        // ★ 2026-09-15：任务桥独立高频调度（30s），与重型治理解耦。
        //   任务状态（in_progress/done）需秒级同步到卡片，不能等每小时一轮的重型治理。
        //   run() 中保留 syncTaskBridge 调用作为兜底，此处负责高频实时同步。
        const runTaskBridge = () => {
            try {
                const tb = syncTaskBridge(db);
                if (tb.dispatched || tb.syncedDone || tb.syncedRunning) {
                    console.log(`[taskbridge-fast] 派发 ${tb.dispatched} / done→卡片 ${tb.syncedDone} / in_progress→卡片 ${tb.syncedRunning}`);
                }
            }
            catch (e) {
                console.error(`[taskbridge-fast] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
            }
        };
        runTaskBridge();
        setInterval(runTaskBridge, 30 * 1000); // 每 30 秒
        // ★ P2-6（C-5 / #4201）：三方对账（5min 低频；幂等 SQL，重跑无副作用）
        const runReconcile = () => {
            try {
                const rc = reconcileTasksAndCards(db);
                if (rc.created || rc.aligned || rc.lagAlerts)
                    console.log(`[reconcile] 建卡 ${rc.created} / 对齐 ${rc.aligned} / 滞后告警 ${rc.lagAlerts}`);
            }
            catch (e) {
                console.error(`[reconcile-fast] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
            }
        };
        runReconcile();
        setInterval(runReconcile, 5 * 60 * 1000); // 每 5 分钟
        // ★ 2026-10-06：扫描→自动接入自动化。工具连接页扫到的「新智能体」自动接 MemoryOS
        //   并按规则入口注入记忆规矩，用户无需打开连接页、无需点按钮。
        //   实现要点：scanAgents() 内部大量 spawnSync（最坏数十秒）→ 绝不能在 daemon 进程内直调，
        //   否则阻塞事件循环拖慢 taskbridge(30s)/reconcile(5min) 定时器；改为异步 spawn 短命子进程。
        //   子进程继承 MEMORY_DB/MEMORYOS_SERVER → 写入的库路径与本机生产库一致。
        //   幂等：已连接且库对齐 / 已有注入段 都会被跳过，重跑无副作用。
        //   关闭：MEMORYOS_AUTO_CONNECT=0；调频：MEMORYOS_AUTO_CONNECT_INTERVAL_MS（下限 60s）。
        if (process.env.MEMORYOS_AUTO_CONNECT !== "0") {
            const acScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "auto-connect.js");
            const acInterval = Math.max(60_000, Number(process.env.MEMORYOS_AUTO_CONNECT_INTERVAL_MS ?? 10 * 60_000) || 10 * 60_000);
            const runAutoConnectSweep = () => {
                try {
                    const child = spawn(process.execPath, [acScript], { cwd: path.dirname(acScript), env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
                    child.stdout.on("data", (d) => console.log(`[auto-connect] ${String(d).trimEnd()}`));
                    child.stderr.on("data", (d) => console.error(`[auto-connect][err] ${String(d).trimEnd()}`));
                    child.on("error", (e) => console.error(`[auto-connect] 子进程启动失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`));
                }
                catch (e) {
                    console.error(`[auto-connect] 调度失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
                }
            };
            setTimeout(runAutoConnectSweep, 90 * 1000); // 启动后 90s 首轮，避开开机高峰
            setInterval(runAutoConnectSweep, acInterval);
            console.log(`[auto-connect] 已启用：每 ${Math.round(acInterval / 60000)} 分钟扫描一轮（启动后 90s 首轮）`);
        }
        // ★ P2：自进化有界验证环（进化引擎提案 engine/ → 双回归门）；engine 目录由 MEMORYOS_ENGINE_DIR 指定，缺省不启用
        const engineDir = (process.env.MEMORYOS_ENGINE_DIR || "").trim();
        if (engineDir) {
            const runEvoGate = () => {
                try {
                    const ev = evolutionRegressionGate(db, engineDir);
                    if (ev.scanned)
                        console.log(`[evolution-gate] 提案 ${ev.scanned} / 接受 ${ev.accepted} / 拒绝 ${ev.rejected}`);
                }
                catch (e) {
                    console.error(`[evolution-gate] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
                }
            };
            runEvoGate();
            setInterval(runEvoGate, 5 * 60 * 1000);
        }
    }
}
