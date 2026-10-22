/**
 * MemoryOS · simFloor 阈值校准（2026-10-13 阶段4·校准）
 *
 * 目的：把「语义证据下限」的默认值从「10 题拍出来的 0.76」升级为「大样本实测出来的值」。
 *   0.76 的来历：5 道噪声题全库最高余弦 0.746、5 道转述题真答案最低 0.773 → 取中点。
 *   样本太小，两侧余量只有约 0.02——本脚本把两侧样本各扩到数十题，量出真实的「可分窗口」。
 *
 * 两条铁律（沿 bench-retrieval.js）：
 *   ① 绝不写生产库：检索会 bump hit_count，故一律先 VACUUM INTO 快照。
 *   ② 绝不产出伪向量：EMBED_MODE=fake 直接拒绝运行。
 *
 * 度量口径（与检索内核逐项对齐，见 dist/search.js 语义路）：
 *   sim = cosine(查询向量, 记忆向量) * (embedding_stale ? 0.9 : 1)   ← 截断前、融合前的**原始余弦**
 *   · 噪声题：取该题在候选语料上的 **maxSim**（库里最高分）→ 门槛必须高过它，否则噪声会漏进来
 *   · 转述题：取该题 **真答案记忆的 sim** → 门槛必须低于它，否则真答案会被误杀
 *   候选语料 = 与 MCP 出口层同口径的 scope 并集（project + global；global 再加 知识库）
 *
 * 用法：
 *   node dist/calibrate-simfloor.js --dump [--n 70]               打印一批记忆样本（供手写题面）
 *   node dist/calibrate-simfloor.js [--cases tests/calibration-cases.json] [--out outputs/calibration-simfloor-<date>.md]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openDb, getVectorsOnProjectCached, getArchivedVectorsOnProject } from "./db.js";
import { getEmbedder, embedMode, cosine } from "./embed.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SRC =
    process.env.MEMORY_DB_PROD ??
    path.join(process.env.APPDATA ?? os.homedir(), "MemoryOS", "data", "memory.db");
const DEFAULT_CASES = path.join(ROOT, "tests", "calibration-cases.json");
const STALE_PENALTY = 0.9;

function argOf(name, dflt) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** 与 server-reg-memory.js / bench-retrieval.js 同款 scope 口径 */
const scopesOf = (project) =>
    !project || project === "global" ? ["global", "知识库"] : [project];

/** 源库 → VACUUM INTO 快照（严禁直接跑生产库：检索会写 hit_count） */
function makeSnapshot(src) {
    if (!fs.existsSync(src)) throw new Error(`源库不存在：${src}`);
    const tmp = path.join(os.tmpdir(), `mem-cal-${process.pid}-${Date.now()}.db`);
    const s = new DatabaseSync(src, { readOnly: true });
    try {
        s.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
        s.close();
    }
    return tmp;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- 模式 1：dump 记忆样本（供手写转述题面） ---------- */
function dump(src, n) {
    const snap = makeSnapshot(src);
    const db = new DatabaseSync(snap, { readOnly: true });
    try {
        const rows = db
            .prepare(
                `SELECT m.id, m.project, m.type, length(m.content) len, substr(m.content, 1, 170) c
                 FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
                 WHERE m.status='active' AND m.sensitivity<>'secret' AND m.type<>'task'
                 ORDER BY (m.id * 2654435761) % 1000003 LIMIT ?`)
            .all(n);
        for (const r of rows) console.log(`${r.id}\t${r.project}\t${r.type}\t${r.len}\t${String(r.c).replace(/\s+/g, " ")}`);
        const by = db
            .prepare(
                `SELECT project, COUNT(*) n FROM memories m JOIN memory_vectors v ON v.memory_id=m.id
                 WHERE m.status='active' GROUP BY project ORDER BY n DESC`)
            .all();
        console.error(`\n[project 分布] ${by.map((b) => `${b.project}=${b.n}`).join(" ")}`);
    } finally {
        db.close();
        fs.rmSync(snap, { force: true });
    }
}

/* ---------- 模式 2：数值校准 ---------- */
async function calibrate(src) {
    if (embedMode() === "fake") {
        console.error("✋ 拒绝运行：EMBED_MODE=fake（伪向量会让分布失真）。请设 EMBED_MODE=local 或 api。");
        process.exit(2);
    }
    const casesPath = argOf("--cases", DEFAULT_CASES);
    if (!fs.existsSync(casesPath)) {
        console.error(`题库不存在：${casesPath}`);
        process.exit(2);
    }
    const { cases } = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    const snap = makeSnapshot(src);
    const db = openDb(snap);
    const embedder = await getEmbedder();

    /** 该 case 的候选语料（scope 并集、去重、仅 active，与 hybridSearch 同口径） */
    function corpusOf(project) {
        const seen = new Set();
        const out = [];
        for (const sp of scopesOf(project)) {
            for (const e of getVectorsOnProjectCached(db, sp, true)) {
                if (seen.has(e.id)) continue;
                seen.add(e.id);
                out.push(e);
            }
        }
        return out;
    }

    const rows = [];
    for (const c of cases) {
        const qv = (await embedder.embedTexts([c.query]))[0];
        let corpus;
        if (c.scenario === "cold") {
            const seen = new Set();
            corpus = [];
            for (const sp of scopesOf(c.project)) {
                for (const e of getArchivedVectorsOnProject(db, sp)) {
                    if (seen.has(e.id)) continue;
                    seen.add(e.id);
                    corpus.push(e);
                }
            }
        } else {
            corpus = corpusOf(c.project);
        }
        const scored = corpus
            .map((e) => ({ id: e.id, sim: cosine(qv, e.vec) * (e.stale ? STALE_PENALTY : 1) }))
            .sort((a, b) => b.sim - a.sim);
        const maxSim = scored[0]?.sim ?? 0;
        const top5 = scored.slice(0, 5);
        // 真答案 sim（转述题取 expectIds；冷层题取 expectArchived）
        const wants = c.scenario === "cold" ? c.expectArchived ?? [] : c.expectIds ?? [];
        const idx = new Map(scored.map((s, i) => [s.id, i + 1]));
        const hitId = wants.find((w) => idx.has(w));
        const gtSim = hitId ? scored[idx.get(hitId) - 1].sim : -1;
        const gtRank = hitId ? idx.get(hitId) : -1;
        rows.push({ id: c.id, scenario: c.scenario, project: c.project, query: c.query, corpusN: corpus.length, maxSim, top5, gtSim, gtRank, wants });
    }

    const noise = rows.filter((r) => r.scenario === "noise");
    const real = rows.filter((r) => r.scenario === "paraphrase" && r.gtSim >= 0);
    const realMiss = rows.filter((r) => r.scenario === "paraphrase" && r.gtSim < 0);
    const cold = rows.filter((r) => r.scenario === "cold");

    const arr = (xs) => xs.map((x) => x.sim ?? x).sort((a, b) => a - b);
    const q = (xs, p) => (xs.length ? arr(xs)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
    const noiseSims = noise.map((r) => r.maxSim);
    const realSims = real.map((r) => r.gtSim);

    const maxNoise = Math.max(...noiseSims, 0);
    const minReal = realSims.length ? Math.min(...realSims) : 1;
    const sep = minReal - maxNoise;
    const mid = (maxNoise + minReal) / 2;

    // 阈值扫描：每个候选门槛下的 漏挡(噪声仍返回≥1) / 误杀(真答案被剔) 题数
    const sweep = [];
    for (let t = 0.66; t <= 0.881; t += 0.01) {
        const tf = r3(t);
        const noiseLeak = noise.filter((r) => r.maxSim >= tf);
        const realKill = real.filter((r) => r.gtSim < tf);
        sweep.push({ t: tf, leak: noiseLeak.length, kill: realKill.length, leakIds: noiseLeak.map((r) => r.id), killIds: realKill.map((r) => r.id) });
    }

    /* 报告 */
    const L = [];
    L.push(`# simFloor 阈值校准报告`);
    L.push(``);
    L.push(`- 生成时间：${new Date().toISOString()}`);
    L.push(`- 源库：\`${src}\`（快照运行，跑完已删）`);
    L.push(`- 题库：\`${casesPath}\`（共 ${cases.length} 题：噪声 ${noise.length} / 转述 ${real.length + realMiss.length} / 冷层 ${cold.length}）`);
    L.push(`- 嵌入：EMBED_MODE=${embedMode()}；口径 sim = cosine × (stale?0.9:1)，截断前原始余弦`);
    L.push(``);
    L.push(`## 1. 两侧分布（决定阈值可行窗口）`);
    L.push(``);
    L.push(`| 侧 | 题数 | min | p25 | 中位 | p75 | max | 含义 |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    L.push(`| 噪声 maxSim | ${noise.length} | ${r3(q(noiseSims, 0))} | ${r3(q(noiseSims, 25))} | ${r3(q(noiseSims, 50))} | ${r3(q(noiseSims, 75))} | ${r3(maxNoise)} | 库里最高分；门槛须 **高于** 它 |`);
    L.push(`| 真答案 gtSim | ${real.length} | ${r3(minReal)} | ${r3(q(realSims, 25))} | ${r3(q(realSims, 50))} | ${r3(q(realSims, 75))} | ${r3(Math.max(...realSims, 0))} | 真答案自身分；门槛须 **低于** 它 |`);
    L.push(``);
    L.push(`**可分窗口 = (${r3(maxNoise)}, ${r3(minReal)})，宽度 ${r3(sep)}，中点 ${r3(mid)}**${sep <= 0 ? " ⚠ 两侧重叠——纯语义绝对阈值不可分离" : ""}`);
    L.push(``);
    L.push(`## 2. 阈值扫描（漏挡 = 噪声题仍返回条目；误杀 = 真答案能被剔除）`);
    L.push(``);
    L.push(`| 门槛 | 漏挡噪声题 | 误杀真答案题 | 漏挡题号 | 误杀题号 |`);
    L.push(`|---|---|---|---|---|`);
    for (const s of sweep) L.push(`| ${s.t} | ${s.leak} | ${s.kill} | ${s.leakIds.join(",") || "—"} | ${s.killIds.join(",") || "—"} |`);
    L.push(``);
    L.push(`## 3. 逐题明细（噪声：maxSim / 转述：gtSim@rank）`);
    L.push(``);
    L.push(`| 题号 | 场景 | 项目 | 语料条数 | maxSim | 真答案sim | 真答排名 | 查询 |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const r of rows)
        L.push(`| ${r.id} | ${r.scenario} | ${r.project} | ${r.corpusN} | ${r3(r.maxSim)} | ${r.gtSim < 0 ? "—" : r3(r.gtSim)} | ${r.gtRank < 0 ? "—" : r.gtRank} | ${r.query} |`);
    L.push(``);
    L.push(`## 4. 最危险样本（噪声最高分 / 真答案最低分）`);
    L.push(``);
    L.push(`**噪声 top5（决定下限的上界）：**`);
    for (const r of [...noise].sort((a, b) => b.maxSim - a.maxSim).slice(0, 5))
        L.push(`- ${r.maxSim.toFixed(3)} ${r.id}：${r.query} → top1=#${r.top5[0]?.id}(${r3(r.top5[0]?.sim ?? 0)})`);
    L.push(``);
    L.push(`**真答案 bottom5（决定下限的下界）：**`);
    for (const r of [...real].sort((a, b) => a.gtSim - b.gtSim).slice(0, 5))
        L.push(`- ${r.gtSim.toFixed(3)} ${r.id}：${r.query} → 真答案 #${r.wants.find((w) => w === r.top5.find((t) => t.id === w)?.id) ?? r.wants[0]}@rank${r.gtRank}，top1=#${r.top5[0]?.id}(${r3(r.top5[0]?.sim ?? 0)})`);
    if (realMiss.length) {
        L.push(``);
        L.push(`**真答案未进候选（需人工复核题面/向量）：** ${realMiss.map((r) => r.id).join(", ")}`);
    }
    L.push(``);
    L.push(`## 5. 结论`);
    L.push(``);
    L.push(`建议阈值 = 可分窗口中点 **${r3(mid)}**（窗口 ${r3(maxNoise)} ~ ${r3(minReal)}）。当前默认 0.76 ${0.76 > maxNoise && 0.76 < minReal ? "落在窗口内 ✅" : "**不在窗口内 ❌**"}。`);
    L.push(``);

    const date = new Date().toISOString().slice(0, 10);
    const out = argOf("--out", path.join(ROOT, "outputs", `calibration-simfloor-${date}.md`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, L.join("\n") + "\n", "utf8");
    db.close();
    fs.rmSync(snap, { force: true });

    console.log(`噪声 ${noise.length} 题：maxSim 区间 ${r3(q(noiseSims, 0))} ~ ${r3(maxNoise)}`);
    console.log(`转述 ${real.length} 题：gtSim 区间 ${r3(minReal)} ~ ${r3(Math.max(...realSims, 0))}`);
    console.log(`可分窗口 (${r3(maxNoise)}, ${r3(minReal)}) 宽 ${r3(sep)} 中点 ${r3(mid)}；当前 0.76 → ${0.76 > maxNoise && 0.76 < minReal ? "在窗口内" : "不在窗口内"}`);
    console.log(`报告：${out}`);
}

/* ---------- 模式 3：解释（打印每题 top-K 命中 + 正文片段，供人工核验标注是否正确） ---------- */
async function explain(src) {
    if (embedMode() === "fake") {
        console.error("✋ 拒绝运行：EMBED_MODE=fake。");
        process.exit(2);
    }
    const K = Number(argOf("--k", "3"));
    const only = argOf("--only", "");
    const { cases } = JSON.parse(fs.readFileSync(argOf("--cases", DEFAULT_CASES), "utf8"));
    const snap = makeSnapshot(src);
    const db = openDb(snap);
    const raw = new DatabaseSync(snap, { readOnly: true });
    const getMem = raw.prepare(
        `SELECT id, project, type, status, length(content) len, substr(content, 1, 110) c FROM memories WHERE id = ?`);
    const embedder = await getEmbedder();
    for (const c of cases) {
        if (only && !c.id.includes(only)) continue;
        const qv = (await embedder.embedTexts([c.query]))[0];
        const seen = new Set();
        const corpus = [];
        for (const sp of scopesOf(c.project)) {
            const list = c.scenario === "cold" ? getArchivedVectorsOnProject(db, sp) : getVectorsOnProjectCached(db, sp, true);
            for (const e of list) {
                if (seen.has(e.id)) continue;
                seen.add(e.id);
                corpus.push(e);
            }
        }
        const top = corpus
            .map((e) => ({ id: e.id, sim: cosine(qv, e.vec) * (e.stale ? STALE_PENALTY : 1) }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, K);
        const want = (c.expectIds ?? c.expectArchived ?? []).join(",");
        console.log(`\n=== ${c.id} [${c.scenario}] ${c.project} | 标注=${want || "无"} | ${c.query}`);
        for (const s of top) {
            const m = getMem.get(s.id) ?? {};
            console.log(`   #${s.id}(${s.sim.toFixed(3)}) ${m.project}/${m.type}/${m.status}/${m.len}字 ${String(m.c ?? "").replace(/\s+/g, " ")}`);
        }
    }
    raw.close();
    db.close();
    fs.rmSync(snap, { force: true });
}

const n = Number(argOf("--n", "70"));
const src = argOf("--db", DEFAULT_SRC);
if (process.argv.includes("--dump")) dump(src, n);
else if (process.argv.includes("--explain")) await explain(src);
else await calibrate(src);
