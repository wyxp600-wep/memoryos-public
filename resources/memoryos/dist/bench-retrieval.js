/**
 * MemoryOS · 检索基准跑分（2026-10-13 阶段0「度量与题库」）
 *
 * 目的：为「检索模块系统性优化」建立**可复现的优化前基线**——没有基线，任何
 *   「延迟↓30%」「契合度≥90%」的声明都不可证伪。
 *
 * 两条铁律：
 *   ① **绝不写生产库**：hybridSearch 会对命中记忆 hit_count+1（真实写操作），
 *      故本脚本一律先对源库做 `VACUUM INTO` 快照，只在快照上跑，跑完删除。
 *   ② **绝不产出伪向量**：EMBED_MODE=fake 直接拒绝运行（假向量会让所有指标失真）。
 *
 * 两种模式：
 *   node dist/bench-retrieval.js --gen                 生成标注题库 → tests/retrieval-cases.json
 *   node dist/bench-retrieval.js                       跑基线 → outputs/retrieval-baseline-<date>.md
 *
 * 可选：--db <path> 指定源库；--cases <path> 指定题库；--out <path> 指定产物；--limit N 每 scope 返回条数（默认10）
 *
 * 口径（与 MCP 出口层对齐）：scopes = project 为 global/未指定 → ['global','知识库']，否则 [project]；
 *   冷层（archivedSearch）在真实 memory_search 里**每次首页都会跑**，故本脚本每次都跑并单独计时。
 *
 * 指标：Hit@1/3/5/10、MRR（期望记忆在合并结果里的排名倒数）、分段耗时（embed/vec/sem/lex/rrf/rank/bump）、
 *   端到端耗时 p50/p95；噪声用例记「返回条数 + top1 分」以观察无关查询的收敛性。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { hybridSearch, archivedSearch } from "./search.js";
import { getEmbedder, embedMode } from "./embed.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SRC =
    process.env.MEMORY_DB_PROD ??
    path.join(process.env.APPDATA ?? os.homedir(), "MemoryOS", "data", "memory.db");
const DEFAULT_CASES = path.join(ROOT, "tests", "retrieval-cases.json");

function argOf(name, dflt) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** 与 server-reg-memory.js 同款 scope 口径（见该文件 memory_search 的 scopes 定义） */
const scopesOf = (project) =>
    !project || project === "global" ? ["global", "知识库"] : [project];

/** 源库 → VACUUM INTO 快照（严禁直接跑生产库：检索会写 hit_count） */
function makeSnapshot(src) {
    if (!fs.existsSync(src)) throw new Error(`源库不存在：${src}`);
    const tmp = path.join(os.tmpdir(), `mem-bench-${process.pid}-${Date.now()}.db`);
    const s = new DatabaseSync(src, { readOnly: true });
    try {
        s.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
        s.close();
    }
    return tmp;
}

/* ---------- 手工标注的锚点用例（id 已经探针逐条核验存在且有向量） ---------- */
const ANCHOR_PARAPHRASE = [
    // 【转述式】语义路为主：与原文几乎无逐字重叠，考的是"意思对得上"
    { project: "memoryos", query: "旧记忆不想清理但又怕以后搜不到，最后定了什么办法", expectIds: [4866, 4867, 4865] },
    { project: "memoryos", query: "记忆库越用越笨的体检数据是真的还是编的", expectIds: [4859] },
    { project: "memoryos", query: "零命中的僵尸记忆都集中在什么时间写入的", expectIds: [4861] },
    { project: "memoryos", query: "差异融合落库为什么必须写在数据层内部而不能外挂", expectIds: [4835, 4828] },
    { project: "电脑优化", query: "Colorfire 这台笔记本空闲时 CPU 占用到底多少", expectIds: [4787] },
    { project: "global", query: "写得多搜得少这种结构性失衡会造成什么后果", expectIds: [4862] },
    { project: "global", query: "索引没命中不等于没有记忆，该怎么兜底", expectIds: [3819] },
    { project: "global", query: "记忆注入想贴合当前任务主题要传哪个参数", expectIds: [3796] },
    { project: "global", query: "为什么说检索命中率低的根子在调用侧", expectIds: [3817] },
    { project: "global", query: "任务派发的 generation 该怎么递增才不会失效", expectIds: [4563] },
    { project: "global", query: "SQLite 批量写记忆怎么把几十秒压到毫秒级", expectIds: [4068] },
    { project: "global", query: "工具调用前不许用冒号这条规矩是谁定的", expectIds: [3316] },
    { project: "global", query: "Dispatch 句柄为什么要保持纯 hex 形态", expectIds: [4511] },
    { project: "global", query: "记忆编辑保存时前端必须携带哪个参数", expectIds: [4150] },
    { project: "global", query: "前端搜索多词匹配要怎么拆词才不丢结果", expectIds: [3429] },
];
const ANCHOR_NOISE = [
    // 【噪声】库里根本没有答案：用于观察"无关查询"的收敛性（后续相关性闸门的目标就在这批上）
    { project: "global", query: "怎么用 Rust 写一个裸机引导程序" },
    { project: "global", query: "明天上海天气怎么样，适合出门吗" },
    { project: "global", query: "红烧肉的正宗做法需要炖多久" },
    { project: "memoryos", query: "Kubernetes 的 operator 模式怎么自定义资源" },
    { project: "global", query: "帮我写一首关于春天的七言绝句" },
];
const ANCHOR_COLD = [
    // 【归档区】目标只在 status=archived：hybridSearch 按契约不会返回，考的是冷层兜底
    { project: "memoryos", query: "旧记忆不得清理 后续某一个任务可能会用到 归档区可搜", expectArchived: [4865] },
    { project: "memoryos", query: "foldInto 差异融合落库 复用 updateMemory", expectArchived: [4828] },
    { project: "电脑优化", query: "Colorfire MEOW R16 发热根因 空闲态 CPU 7%", expectArchived: [4787] },
];

/* ---------- 题库生成 ---------- */
function genCases(src) {
    const snap = makeSnapshot(src);
    const db = new DatabaseSync(snap, { readOnly: true });
    const cases = [];
    try {
        const meta = {
            generatedAt: new Date().toISOString(),
            sourceDb: src,
            sourceBytes: fs.statSync(src).size,
            active: db.prepare(`SELECT COUNT(*) n FROM memories WHERE status='active'`).get().n,
            withVector: db.prepare(
                `SELECT COUNT(*) n FROM memories m JOIN memory_vectors v ON v.memory_id=m.id WHERE m.status='active'`).get().n,
            note: "课题=检索模块系统性优化；fragment=片段线索（偏词法），paraphrase=转述式（偏语义），noise=库里无答案，cold=归档区冷层",
        };
        // ① 转述式锚点
        ANCHOR_PARAPHRASE.forEach((c, i) =>
            cases.push({ id: `para-${String(i + 1).padStart(2, "0")}`, scenario: "paraphrase", ...c }));
        // ② 噪声
        ANCHOR_NOISE.forEach((c, i) =>
            cases.push({ id: `noise-${String(i + 1).padStart(2, "0")}`, scenario: "noise", expectIds: [], ...c }));
        // ③ 归档冷层
        ANCHOR_COLD.forEach((c, i) =>
            cases.push({ id: `cold-${String(i + 1).padStart(2, "0")}`, scenario: "cold", expectIds: [], ...c }));
        // ④ 片段线索（自动派生）：内容首个"实义子句"当查询，期望 = 所有含该片段的 active 记忆（去重后 ≤3 条）
        const cands = db.prepare(
            `SELECT m.id, m.project, m.content, m.sensitivity, m.type
             FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
             WHERE m.status='active' AND m.sensitivity<>'secret' AND m.type<>'task'
               AND length(m.content) BETWEEN 80 AND 1500
             ORDER BY (m.id * 2654435761) % 1000003`).all();
        let n = 0;
        for (const c of cands) {
            if (n >= 20) break;
            const clause = String(c.content).split(/[。；\n]/).map((s) => s.trim())
                .find((s) => s.length >= 14 && s.length <= 90);
            if (!clause) continue;
            const like = `%${clause.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
            const hits = db.prepare(
                `SELECT m.id FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
                 WHERE m.status='active' AND m.content LIKE ? ESCAPE '\\' LIMIT 5`).all(like);
            if (!hits.length || hits.length > 3) continue; // 太模糊（>3 条同片段）或不可检索 → 跳过
            if (!hits.some((h) => h.id === c.id)) continue; // 目标必须自己能命中，否则题目本身有坑
            cases.push({
                id: `frag-${String(++n).padStart(2, "0")}`,
                scenario: "fragment",
                project: c.project,
                query: clause,
                expectIds: hits.map((h) => h.id),
            });
        }
        const out = argOf("--out", DEFAULT_CASES);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ meta, cases }, null, 2) + "\n", "utf8");
        const byScenario = {};
        for (const c of cases) byScenario[c.scenario] = (byScenario[c.scenario] ?? 0) + 1;
        console.log(`题库已写入 ${out}（共 ${cases.length} 题）：${JSON.stringify(byScenario)}`);
    } finally {
        db.close();
        fs.rmSync(snap, { force: true });
    }
}

/* ---------- 统计工具 ---------- */
const pct = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------- 跑基线 ---------- */
async function runBench(src) {
    if (embedMode() === "fake") {
        console.error("✋ 拒绝运行：当前 EMBED_MODE=fake（伪向量会让全部指标失真）。请设 EMBED_MODE=local 或 api。");
        process.exit(2);
    }
    const casesPath = argOf("--cases", DEFAULT_CASES);
    if (!fs.existsSync(casesPath)) {
        console.error(`题库不存在：${casesPath}（先跑 --gen 生成）`);
        process.exit(2);
    }
    const { meta, cases } = JSON.parse(fs.readFileSync(casesPath, "utf8"));
    const limit = Number(argOf("--limit", "10"));
    // ★ 2026-10-13：相关性闸门对照（0=关，行为与改动前逐字一致）——用于量化「任务执行适配性」：
    //   同一题库跑两遍（关/开），看返回条数收敛与准确度是否受损。
    const REL_RATIO = Number(argOf("--relRatio", "0"));
    // ★ 2026-10-13：语义证据下限对照（0=关，行为与改动前逐字一致）——用于量化「噪声提问」：
    //   噪声题（库内无答案）在 0.76 下应被整页清空，转述/片段题的真答案不应受损。
    const SIM_FLOOR = Number(argOf("--simFloor", "0"));
    const snap = makeSnapshot(src);
    const db = openDb(snap); // 快照可写（检索会 bump），生产库不受影响
    const embedder = await getEmbedder();
    const stageKeys = ["embed", "vec", "sem", "lex", "rrf", "rank", "bump", "total"];
    const emptyStages = () => Object.fromEntries(stageKeys.map((k) => [k, 0]));

    /**
     * 跑一遍全部用例。
     * @param warmOnly true=只跑不记（暖场）
     * @param xform    查询改写（测「近重复提问」：原文不变，只动标点/空格）
     */
    async function pass(warmOnly, xform) {
        const rows = [];
        for (const c of cases) {
            const effQ = xform ? xform(c.query) : c.query;
            const t0 = Date.now();
            const merged = [];
            const seen = new Set();
            const stages = emptyStages();
            for (const sp of scopesOf(c.project)) {
                const hits = await hybridSearch(db, embedder, { query: effQ, project: sp, limit, relRatio: REL_RATIO, simFloor: SIM_FLOOR });
                const st = hits._searchStats;
                if (st?.ms) for (const k of stageKeys) stages[k] += st.ms[k] ?? 0;
                for (const h of hits) if (!seen.has(h.id)) { seen.add(h.id); merged.push(h); }
            }
            // 冷层：真实 memory_search 每次首页都跑（页1尾部固定预留名额），故这里也每次都跑并单独计时。
            // ★ 2026-10-13：与出口层同口径传 simFloor —— 否则热路已按证据清空、冷层又灌一波无关归档条，
            //   噪声会「复活」，基准就测不出真实效果（该漏传曾在首跑时把噪声 5 条误算进结果）。
            const tc = Date.now();
            const coldIds = [];
            for (const sp of scopesOf(c.project)) {
                const extra = await archivedSearch(db, embedder, { query: effQ, project: sp, limit: 5, simFloor: SIM_FLOOR });
                for (const h of extra) if (!seen.has(h.id)) { seen.add(h.id); merged.push(h); coldIds.push(h.id); }
            }
            const coldMs = Date.now() - tc;
            const wallMs = Date.now() - t0;
            if (warmOnly) continue;
            const expect = c.expectIds ?? [];
            let rank = 0;
            for (let i = 0; i < merged.length; i++) if (expect.includes(merged[i].id)) { rank = i + 1; break; }
            rows.push({
                id: c.id, scenario: c.scenario, project: c.project, query: c.query,
                returned: merged.length, coldIds, coldMs, wallMs,
                stages, rank, expect,
                expectCold: c.expectArchived ?? [],
                top1: merged[0] ? { id: merged[0].id, score: r3(merged[0].score ?? 0), archived: !!merged[0].archived } : null,
                topIds: merged.slice(0, limit).map((h) => h.id),
            });
        }
        return rows;
    }

    // 预热：加载模型 + 建 ANN 索引（不计入基线，避免把一次性冷启动算进 p95）
    const warmQuery = "预热查询 用于加载嵌入模型与构建索引";
    for (const sp of new Set(cases.flatMap((c) => scopesOf(c.project)))) {
        await hybridSearch(db, embedder, { query: warmQuery, project: sp, limit });
        await archivedSearch(db, embedder, { query: warmQuery, project: sp, limit: 5 });
    }

    /** 近重复改写：语义完全不变，只动首尾标点与空白 —— 模拟 AI 反复追问同一件事时的措辞抖动 */
    const nearDupify = (q) => " " + q.replace(/[。！？!?]+$/u, "") + "。 ";

    const first = await pass(false); // 新问题（每题首次）→ 嵌入缓存必然 miss，代表真实首次检索
    await pass(true); // 再跑一遍暖场（结果弃用，只为让 ANN/向量缓存处于稳态）
    const repeat = await pass(false); // 同题同文再问 → 嵌入缓存 + 结果直通车
    const nearDup = await pass(false, nearDupify); // 同题近义（只动标点/空格）→ 归一化缓存键命中

    /* 汇总 */
    const tag = argOf("--tag", "优化前");
    const L = [];
    L.push(`# 检索基线报告（${tag}）`);
    L.push("");
    L.push(`- 生成时间：${new Date().toISOString()}`);
    L.push(`- 源库：\`${src}\`（${(fs.statSync(src).size / 1048576).toFixed(1)} MB，快照运行，跑完已删）`);
    L.push(`- 题库：\`${casesPath}\`（共 ${cases.length} 题；scenario：paraphrase/fragment/noise/cold）`);
    L.push(`- 嵌入模式：EMBED_MODE=${embedMode()}；每 scope 返回 limit=${limit}`);
    L.push(`- 相关性闸门：relRatio=${REL_RATIO}（0 = 关，与改动前行为逐字一致）`);
    L.push(`- 语义证据下限：simFloor=${SIM_FLOOR}（0 = 关，行为与改动前逐字一致）`);
    L.push(`- 口径：scopes 与 MCP 出口层一致；冷层每次首页都跑并单独计时`);
    L.push("");
    L.push(`## 1. 准确度（${tag}）`);
    L.push("");
    L.push(`| 场景 | 题数 | Hit@1 | Hit@3 | Hit@5 | Hit@${limit} | MRR | 平均返回条数 |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const sc of ["paraphrase", "fragment", "cold", "noise"]) {
        const rs = first.filter((r) => r.scenario === sc);
        if (!rs.length) continue;
        if (sc === "noise") {
            L.push(`| ${sc}（库里无答案） | ${rs.length} | — | — | — | — | — | ${r3(mean(rs.map((r) => r.returned)))} |`);
            continue;
        }
        if (sc === "cold") {
            const ok = rs.filter((r) => (r.coldIds ?? []).some((id) => (r.expectCold ?? []).includes(id)));
            L.push(`| ${sc}（归档冷层） | ${rs.length} | — | — | — | — | — | ${r3(mean(rs.map((r) => r.returned)))}（冷层命中期望 ${ok.length}/${rs.length}） |`);
            continue;
        }
        const h = (k) => rs.filter((r) => r.rank > 0 && r.rank <= k).length;
        const mrr = mean(rs.map((r) => (r.rank > 0 ? 1 / r.rank : 0)));
        L.push(`| ${sc} | ${rs.length} | ${h(1)} | ${h(3)} | ${h(5)} | ${h(limit)} | ${r3(mrr)} | ${r3(mean(rs.map((r) => r.returned)))} |`);
    }
    L.push("");
    L.push(`> 冷层用例的期望 id 只在 archived，hybridSearch 按契约不返回 → 上表「归档冷层」看的是冷层是否召回（coldIds 是否含期望 id），故不列 Hit@k。`);
    L.push("");
    L.push(`## 2. 耗时（${tag}，毫秒）`);
    L.push("");
    L.push(`| 场景 | 首次查询 p50 | 首次 p95 | 同题再问 p50 | 近义重问 p50 | 冷层 p50 |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const sc of ["paraphrase", "fragment", "cold", "noise"]) {
        const a = first.filter((r) => r.scenario === sc).map((r) => r.wallMs);
        const b = repeat.filter((r) => r.scenario === sc).map((r) => r.wallMs);
        const d = nearDup.filter((r) => r.scenario === sc).map((r) => r.wallMs);
        const c = first.filter((r) => r.scenario === sc).map((r) => r.coldMs);
        if (!a.length) continue;
        L.push(`| ${sc} | ${pct(a, 50)} | ${pct(a, 95)} | ${pct(b, 50)} | ${pct(d, 50)} | ${pct(c, 50)} |`);
    }
    const allFirst = first.map((r) => r.wallMs);
    const allRepeat = repeat.map((r) => r.wallMs);
    const allNearDup = nearDup.map((r) => r.wallMs);
    // 综合口径：同一标准题库跑三态（新问题 / 同题再问 / 近义重问）合并取分位 —— 作为「单次检索响应延迟」的总指标
    const allMixed = [...allFirst, ...allRepeat, ...allNearDup];
    L.push(`| **全部** | **${pct(allFirst, 50)}** | **${pct(allFirst, 95)}** | **${pct(allRepeat, 50)}** | **${pct(allNearDup, 50)}** | **${pct(first.map((r) => r.coldMs), 50)}** |`);
    L.push(`| **综合（三态合并）** | **p50=${pct(allMixed, 50)} / p95=${pct(allMixed, 95)}** | | | | |`);
    L.push("");
    L.push(`## 3. 分段耗时均值（首次查询，毫秒）`);
    L.push("");
    L.push(`| 阶段 | 均值 | 含义 |`);
    L.push(`|---|---|---|`);
    const stageName = {
        embed: "查询向量化（本地 BGE-M3 推理）", vec: "向量缓存读取 + ANN 索引构建/查询",
        sem: "cosine 粗筛 + 正交重排", lex: "词法路（整串 + CJK 分词补召）", rrf: "RRF 融合归并",
        rank: "批量回填行 + 衰减/权重/waypoint 打分排序", bump: "命中回血写回（SQLite 落盘）",
    };
    for (const k of ["embed", "vec", "sem", "lex", "rrf", "rank", "bump"]) {
        L.push(`| ${k} | ${r3(mean(first.map((r) => r.stages[k])))} | ${stageName[k]} |`);
    }
    L.push(`| 冷层 | ${r3(mean(first.map((r) => r.coldMs)))} | 归档区兜底（每次首页都跑） |`);
    L.push("");
    L.push(`## 4. 逐题明细（首次查询）`);
    L.push("");
    L.push(`| 题号 | 场景 | 项目 | 期望排名 | 返回 | top1 | 耗时ms | 查询 |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const r of first) {
        const rk = r.scenario === "noise" ? "—" : (r.rank > 0 ? r.rank : "未命中");
        L.push(`| ${r.id} | ${r.scenario} | ${r.project} | ${rk} | ${r.returned} | #${r.top1?.id ?? "-"}(${r.top1?.score ?? 0}) | ${r.wallMs} | ${r.query.slice(0, 42)} |`);
    }
    L.push("");
    const out = argOf("--out", path.join(ROOT, "outputs", `retrieval-${tag === "优化前" ? "baseline" : "after"}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.md`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, L.join("\n") + "\n", "utf8");
    console.log(`报告已写入 ${out}`);
    console.log(`首次查询 p50=${pct(allFirst, 50)}ms p95=${pct(allFirst, 95)}ms；同题再问 p50=${pct(allRepeat, 50)}ms；近义重问 p50=${pct(allNearDup, 50)}ms；综合 p50=${pct(allMixed, 50)}ms`);
    console.log(`分段均值(ms)：${stageKeys.filter((k) => k !== "total").map((k) => `${k}=${r3(mean(first.map((r) => r.stages[k])))}`).join(" ")}`);
    db.close();
    fs.rmSync(snap, { force: true });
}

const src = argOf("--db", DEFAULT_SRC);
if (process.argv.includes("--gen")) {
    genCases(src);
} else {
    await runBench(src);
}
