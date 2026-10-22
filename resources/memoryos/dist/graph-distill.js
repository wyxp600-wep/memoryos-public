/**
 * MemoryOS P1-C（2026-10-13）：知识图谱蒸馏（memory→memory 关系抽取）
 *
 * 背景：links 表原服务 Obsidian wikilink（note 节点）与卡片边，memory 节点间的
 *   语义关系几乎为空；检索也不沿图扩展 → "2000 条平铺文本" 无法回答
 *   "这个项目相关的一切" 这类关系型问题。
 *
 * 设计：
 *   - daemon 每 24h（config graph_distill.lastRun 水位）对 top-200 高频记忆分批
 *     （50 条/批）调 LLM 实体/关系抽取，输出 [{src_id, dst_id, kind, anchor}]，
 *     kind ∈ related / depends_on / conflicts。
 *   - 幂等：links 表 UNIQUE(src_kind, src_id, kind, IFNULL(dst_id,-1), ...) 天然去重，
 *     写入前再查一次已存在的 (src,dst,kind) 三元组跳过。
 *   - 与 waypoint 同窗口（24h），放在 daemon 治理链 maybeRunRuleReflection 之后。
 *   - 开关：env MEMORY_GRAPH_DISTILL_ON=0 全关；config graph_distill.enabled=false 关。
 *   - LLM 失败**不推进水位**，记审计 graph-distill-failed，次日重试（与 reflect 同语义）。
 *
 * 用法：内核自动调用；手动 dry-run：
 *   node dist/graph-distill.js --once [--dry-run]
 */
import { openDb, readConfig, writeConfig, logDaemon } from "./db.js";
import { llmConf } from "./llm.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TOP_N = 200;
const BATCH_SIZE = 50;
const KINDS = ["related", "depends_on", "conflicts"];
const GRACE_MS = 24 * 3600 * 1000; // 水位回退宽限：不把正在处理的半截批次纳入本轮

const SYSTEM = `你是关系抽取器（MemoryOS 知识图谱蒸馏）：给定一批记忆条目（#id [type] 正文摘要），
找出它们之间的**明确工程关系**，输出 JSON 数组。
关系类型（kind）：
  related      共享同一模块/项目/技术栈（弱关联）
  depends_on   A 的结论或做法建立在 B 之上（强关联，方向性：src 依赖 dst）
  conflicts    A 与 B 结论矛盾（如"用 X" vs "禁用 X"）
规则：
  - 只输出证据在正文里明确可溯的关系，宁缺毋滥；没有就输出 []
  - 每条 anchor 写 8~20 字的依据短语（引正文关键词）
  - 同一对记忆不重复输出（只取最强的一种 kind）
输出格式（严格 JSON 数组，不要任何其他字）：
  [{"src_id":12,"dst_id":34,"kind":"related","anchor":"都涉及 sqlite WAL"}]
id 必须来自给定的记忆条目列表。`;

/** 解析 LLM 输出的关系数组（容错：取 ```json 围栏 / 首个 [ ... ]） */
export function parseRelations(text) {
    const fence = String(text ?? "").match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (fence ? fence[1] : String(text ?? "")).trim();
    const tryArr = (s) => {
        const j = JSON.parse(s);
        return Array.isArray(j) ? j : null;
    };
    let arr = null;
    try { arr = tryArr(raw); } catch { arr = null; }
    if (!arr) {
        const i0 = raw.indexOf("[");
        const i1 = raw.lastIndexOf("]");
        if (i0 >= 0 && i1 > i0) {
            try { arr = tryArr(raw.slice(i0, i1 + 1)); } catch { arr = null; }
        }
    }
    if (!arr)
        return [];
    const out = [];
    const seen = new Set();
    for (const x of arr) {
        const src = Number(x?.src_id);
        const dst = Number(x?.dst_id);
        const kind = String(x?.kind ?? "");
        if (!Number.isInteger(src) || !Number.isInteger(dst) || src === dst)
            continue;
        if (!KINDS.includes(kind))
            continue;
        const anchor = String(x?.anchor ?? "").slice(0, 60);
        const key = `${src}:${dst}:${kind}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ src_id: src, dst_id: dst, kind, anchor });
    }
    return out;
}

/** 调 LLM 抽一批记忆的关系。失败抛错（由 maybeDistillGraph 决定不推进水位）。 */
async function distillLlm(batch, timeoutMs = 60000) {
    const conf = await llmConf();
    if (conf.keySource === "undecryptable")
        throw new Error("LLM 密钥无法解密：请在设置页重新填写密钥");
    const items = batch.map((m) => `#${m.id} [${m.type}] ${String(m.content).replace(/\s+/g, " ").slice(0, 260)}`).join("\n");
    const user = `记忆条目（共 ${batch.length} 条）：\n${items}\n\n请抽取明确关系。`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(conf.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(conf.key ? { Authorization: `Bearer ${conf.key}` } : {}) },
            signal: ctrl.signal,
            body: JSON.stringify({
                model: conf.model,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: user },
                ],
                max_tokens: 1200,
                temperature: 0.1,
            }),
        });
        if (!res.ok)
            throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        return parseRelations(data?.choices?.[0]?.message?.content ?? "");
    }
    finally {
        clearTimeout(timer);
    }
}

/**
 * 关系落库：插入 links（src_kind/dst_kind='memory'，vault_root NULL=记忆域，
 * 与 Obsidian wikilink 的 vault 域天然隔离）。返回插入条数。
 */
function insertLink(db, rel, idSet) {
    if (!idSet.has(rel.src_id) || !idSet.has(rel.dst_id))
        return false; // id 不在本批 → 丢弃（宁缺毋滥）
    const exists = db
        .prepare(`SELECT 1 FROM links WHERE src_kind='memory' AND src_id=? AND dst_kind='memory' AND dst_id=? AND kind=? LIMIT 1`)
        .get(rel.src_id, rel.dst_id, rel.kind);
    if (exists)
        return false;
    db.prepare(`INSERT OR IGNORE INTO links(src_kind, src_id, dst_kind, dst_id, kind, anchor)
                VALUES('memory', ?, 'memory', ?, ?, ?)`)
        .run(rel.src_id, rel.dst_id, rel.kind, rel.anchor || null);
    return true;
}

/**
 * 每 24h 图谱蒸馏。返回 {skipped:reason} | {batches, relations, inserted, watermark}。
 * opts: {force?, llm?, dryRun?} —— force 跳过 24h 窗口与水位；llm 注入假调用（冒烟）；dryRun 不写库。
 */
export async function maybeDistillGraph(db, opts = {}) {
    if (process.env.MEMORY_GRAPH_DISTILL_ON === "0")
        return { skipped: "disabled" };
    let st = readConfig(db, "graph_distill", {}) || {};
    if (st.enabled === false && !opts.force)
        return { skipped: "disabled" };
    if (!opts.force) {
        const last = st.lastRun ? new Date(st.lastRun).getTime() : 0;
        if (last && Date.now() - last < GRACE_MS)
            return { skipped: "before-window" };
    }
    // 先认领（写库），防 daemon/dashboard 双跑双花 LLM（与 reflect 同语义）
    st = { ...st, lastRun: new Date().toISOString() };
    writeConfig(db, "graph_distill", st);

    const topRows = db
        .prepare(`SELECT id, type, content FROM memories WHERE status='active' ORDER BY hit_count DESC, confidence DESC LIMIT ${TOP_N}`)
        .all();
    if (!topRows.length)
        return { skipped: "no-memories" };
    const idSet = new Set(topRows.map((r) => Number(r.id)));

    // 分批（保持批内互相关；按 hit_count 降序切，前 4 批覆盖 200 条高频区）
    const batches = [];
    for (let i = 0; i < topRows.length; i += BATCH_SIZE)
        batches.push(topRows.slice(i, i + BATCH_SIZE));

    const call = opts.llm ?? distillLlm;
    let relations = 0;
    let inserted = 0;
    for (const batch of batches) {
        const found = await call(batch);
        relations += found.length;
        for (const rel of found) {
            if (opts.dryRun) {
                inserted++;
                continue;
            }
            if (insertLink(db, rel, idSet))
                inserted++;
        }
    }
    if (!opts.dryRun)
        logDaemon(db, { task: "graph_distill", op: "relations", detail: `batches=${batches.length} found=${relations} inserted=${inserted}` });
    return { batches: batches.length, relations, inserted, dryRun: Boolean(opts.dryRun) };
}

// ── CLI：node dist/graph-distill.js --once [--dry-run] ─────────────────
if (process.argv[1] && process.argv[1].endsWith("graph-distill.js")) {
    const dbPath = process.env.MEMORY_DB || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "memory.db");
    const db = openDb(dbPath);
    const force = process.argv.includes("--once");
    const dryRun = process.argv.includes("--dry-run");
    maybeDistillGraph(db, { force, dryRun })
        .then((r) => {
            if (r.skipped)
                console.log(`[graph-distill] skipped: ${r.skipped}`);
            else
                console.log(`[graph-distill] batches=${r.batches} found=${r.relations} inserted=${r.inserted}${r.dryRun ? " (dry-run)" : ""}`);
        })
        .catch((e) => {
            console.error(`[graph-distill] 失败（水位未推进，次日补跑）：${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
        });
}
