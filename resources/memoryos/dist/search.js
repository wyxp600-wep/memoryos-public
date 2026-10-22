import { keywordCandidates, keywordEpoch, keywordNorm } from "./memory-keywords.js";
import { conflictMap, qualityEpoch } from "./knowledge-quality.js";
import { distinctMemories } from "./memory-quality.js";
import { getVectorsOnProjectCached, getAnnIndexCached, getArchivedVectorsOnProject, lexSearch, readMemoriesByIds, withTx, readConfig, vectorCacheVersion } from "./db.js";
import { cosine, embedderProvenance } from "./embed.js";
import { SECTORS } from "./db.js";
const RRF_K = 60;
/** ★ R4-4 waypoint 模块级缓存（60s TTL）：daemon 每晚预计算存 config['waypoints']，检索只读表 */
let wpCache = null;
function waypointOf(db, id) {
    const now = Date.now();
    if (!wpCache || now - wpCache.at > 60000) {
        const raw = readConfig(db, "waypoints", {});
        const map = new Map();
        for (const [k, v] of Object.entries(raw ?? {})) {
            const n = Number(k);
            if (Number.isFinite(n) && typeof v === "number")
                map.set(n, Math.max(0, Math.min(1, v)));
        }
        wpCache = { at: now, map };
    }
    return wpCache.map.get(id) ?? 0;
}
/** ★ P1-C（2026-10-13）：图谱一跳邻居命中计数（memory→memory links，60s TTL）。
 *  graph-distill.js 蒸馏出的关系落 links 表；检索时 top-K 结果的邻居若也在候选集内，
 *  按邻居数给 0.9~1.1 微幅加分（kind 加权：conflicts 不加分，depends_on ×1.1，related ×1.0 基准）。
 *  只加不减 —— 图扩展不剔除任何原候选（红线：不动库内记忆，只调排序）。 */
let _gpCache = null; // { at, adjacency: Map<id, {related, depends_on}> }
export function graphNeighborsOf(db, id, kinds = ["related", "depends_on"]) {
    const now = Date.now();
    if (!_gpCache || now - _gpCache.at > 60000) {
        const adj = new Map();
        try {
            const rows = db
                .prepare(`SELECT src_id, dst_id, kind FROM links
                          WHERE src_kind='memory' AND dst_kind='memory'
                            AND kind IN (${kinds.map(() => "?").join(",")})`)
                .all(...kinds);
            for (const r of rows) {
                // 双向：src→dst 与 dst→src 互为邻居（conflicts 单向语义由 kind 区分，不在加分范围）
                if (!adj.has(r.src_id))
                    adj.set(r.src_id, { related: 0, depends_on: 0 });
                if (!adj.has(r.dst_id))
                    adj.set(r.dst_id, { related: 0, depends_on: 0 });
                adj.get(r.src_id)[r.kind]++;
                adj.get(r.dst_id)[r.kind]++;
            }
            _gpCache = { at: now, adjacency: adj };
        }
        catch {
            _gpCache = { at: now, adjacency: adj }; // links 表未建（旧库）→ 空图，不阻断
        }
    }
    return _gpCache.adjacency.get(id) ?? null;
}
/** P1-C：一跳图加分系数（1.0 基准；有 depends_on 邻居 → 1.05；related 邻居 → 1.02×log；上限 1.15） */
export function graphBoost(db, id) {
    const nb = graphNeighborsOf(db, id);
    if (!nb || (nb.related + nb.depends_on) === 0)
        return 1.0;
    return Math.min(1.15, 1.0 + 0.05 * nb.depends_on + 0.02 * Math.min(nb.related, 4));
}
/**
 * ★ P1-2.4 stale 惩罚系数。
 * 记忆正文被编辑后若向量尚未重算（embedding_stale=1），其向量与正文语义已脱节，
 * 按原相似度排序会把「标题相关但内容已变」的记忆排到前面 —— 即命中错误内容。
 * 这里不直接排除（正文本身可能仍相关），而是降权，让 daemon 重算完成前的过渡期更安全。
 */
const STALE_PENALTY = 0.9;
/** ★ 2026-10-14（检索优化 · 阶段6「证据成色判据」）：短条目泛化度降权。
 *  实证（73 题 / 生产库快照，见 outputs/calibration-simfloor-20261013.md）：噪声漏进来的 113 条
 *    **100% 无词法证据**（via=semantic）、真答案绝大多数有词法证据 → 「无词法证据」是**零误伤**的
 *    必要条件；真正的区分度在**长度** —— 反复霸占前排的是 18~60 字短小通用条目（#297/#4430/#4471
 *    等「万能吸引子」）。故口径：simFloor 开启 且 无词法证据 且 正文 ≤ SPEC_LEN_MAX → 候选 final
 *    乘 p.specPenalty（默认 1 = 关）**降权后压、不剔除** —— 硬切会误杀「#145（19 字）记住犯过的错」
 *    这类短小真答案；降权让它自然下沉，但仍留在列表内可被看到。
 *  默认 1（关）：不传 p.specPenalty 时打分公式与改动前**逐字一致**（零回归）；0/1/越界一律视为关。 */
const SPEC_PENALTY_DEFAULT = 1;
/** 判据长度上限：≤60 字视为「短小通用条目」（实证 L=60 可覆盖 15 道噪声题、仅误伤 2/30 真答案） */
const SPEC_LEN_MAX = 60;
/** ★ 2026-09-25 P0（检索降级可观测）：hybridSearch 语义路失败原本只在 catch 里静默置空 Map，
 *  调用方（memory_search/memory_context）无从得知「本次已是纯词法」——跨表述召回为 0 却无任何提示，
 *  是"召回差且查不出原因"的主要盲区。这里记最近一次降级供调用方在回执里显式告警；
 *  每次 hybridSearch 开头清零（单线程事件循环，await 间隙不会交错两次检索）。
 *  返回 { msg, at } 或 null（null = 语义路正常）。 */
let _lastDegradation = null;
export function semanticDegradation() {
    return _lastDegradation;
}
/* ================= ★ 2026-10-13（检索优化，阶段1）：分层缓存 =================
 * 背景（实测，dist/bench-retrieval.js）：单次检索 43 项标准题 p50=43ms，其中本地嵌入推理
 *   占 33ms（65%）。同一批题「同题再问」仍有 15ms、「换标点再问」几乎不掉（48ms）——
 *   即每问一次都要把整条链路重算一遍。真实调用侧（memory_context 每轮注入）重复率很高，
 *   缓存收益远大于任何单点算法微调，且**不动语义**（同一问题仍得到同一批记忆）。
 * 三层：
 *   L0 查询向量别名缓存 —— 归一化键 → 向量（省 33ms 嵌入推理）
 *   L1 结果直通车     —— 归一化键 → 已排序结果（省全部重算，但仍照常回血记账）
 *   （L2 = 既有向量/ANN/waypoint 缓存，见 db.js，本次不动）
 * 铁律：缓存只省"重算"，绝不改"记账"与"语义"——命中时 hit_count/last_seen_at 必须照常 +1。
 * 失效：向量缓存版本号变化（任何写入/状态流转）立即作废，杜绝读到已改正文；TTL 30s 兜底。
 * =========================================================================== */
/** 查询归一化键：**仅用于缓存键**，绝不改送入嵌入器的原文（原文→向量，保证向量空间一致）。
 *  目的：AI 反复追问同一件事时措辞常有微抖（首尾标点、多余空格），逐字精确匹配做键会全部 miss。 */
function normQueryKey(q) {
    return String(q).trim().replace(/\s+/g, " ").replace(/[。，、；：！？!?,.;:…·]+$/u, "").toLowerCase();
}
/** ★ 2026-10-13（门禁 C2d 暴露的必需约束）：缓存必须绑定「算它用的那个嵌入器实例」。
 *  同一句查询换个嵌入器（本地模型 ↔ API ↔ 测试假向量）就完全不是同一个语义空间，复用旧向量/旧结果
 *  会静默污染检索；且嵌入器报错时若旧向量被直接复用，降级告警（_searchStats.degraded）会被缓存吃掉、
 *  调用方误以为语义路正常。给每个实例发一个进程内序号，做缓存键前缀 —— 生产侧 local/api 都是单例，
 *  缓存照常跨请求生效；实例一变（含测试的 mock/failing embedder）立刻换键。 */
const embedIdSeq = new WeakMap();
let embedIdNext = 0;
function embedIdOf(embedder) {
    if (!embedder || typeof embedder !== "object")
        return 0;
    let id = embedIdSeq.get(embedder);
    if (id === undefined) {
        id = ++embedIdNext;
        embedIdSeq.set(embedder, id);
    }
    return id;
}
const QV_ALIAS_MAX = 512;
const qvAlias = new Map();
function qvAliasGet(k) {
    return qvAlias.get(k) ?? null;
}
function qvAliasSet(k, v) {
    if (qvAlias.size >= QV_ALIAS_MAX) {
        const oldest = qvAlias.keys().next().value;
        qvAlias.delete(oldest);
    }
    qvAlias.set(k, v);
}
const RESULT_CACHE_TTL_MS = 30_000;
const RESULT_CACHE_MAX = 128;
const resCache = new WeakMap(); // db 实例 → Map<key, {version, at, out, stats}>
function resCacheGet(db, key, version) {
    const m = resCache.get(db);
    const e = m?.get(key);
    if (!e)
        return null;
    if (e.version !== version || Date.now() - e.at > RESULT_CACHE_TTL_MS) {
        m.delete(key);
        return null;
    }
    return e;
}
function resCacheSet(db, key, version, out, stats) {
    let m = resCache.get(db);
    if (!m) {
        m = new Map();
        resCache.set(db, m);
    }
    if (m.size >= RESULT_CACHE_MAX) {
        const oldest = m.keys().next().value;
        m.delete(oldest);
    }
    m.set(key, { version, at: Date.now(), out, stats });
}
/** 命中回血（批量化）：原实现逐条 UPDATE 包事务，同一次检索的 N 条可合并成一条 IN 语句。 */
function bumpHits(db, ids) {
    if (!ids.length)
        return;
    const ph = ids.map(() => "?").join(",");
    const bump = db.prepare(`UPDATE memories SET hit_count = hit_count + 1,
        last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${ph})`);
    withTx(db, () => bump.run(...ids));
}
/* ================= ★ 2026-10-13（检索优化，阶段2）：任务类型/执行阶段 → 记忆标签映射 =================
 * 取向与调用侧一致：**新能力走可选参数**。p.task / p.stage 不传时，下面两张表一次都不会被查到，
 *   打分公式与改动前逐字一致（默认行为零变化，门禁不受影响）。
 * 调用侧（MCP memory_search / memory_context）应由 AI 显式传入当前任务类型与执行阶段。
 * =========================================================================== */
/** 任务类型 → 记忆类型加权（>1 表示优先召回） */
const TASK_TYPE_BOOST = {
    debug: { pitfall: 1.35, experience: 1.18, rule: 1.10, example: 1.05 },
    fix: { pitfall: 1.35, experience: 1.18, rule: 1.10, example: 1.05 },
    implement: { convention: 1.20, experience: 1.15, decision: 1.05, example: 1.18 },
    review: { rule: 1.30, convention: 1.25, decision: 1.15, example: 1.05 },
    design: { decision: 1.30, rule: 1.15, convention: 1.10, example: 1.20 },
    ops: { pitfall: 1.30, rule: 1.20, experience: 1.10, example: 1.05 },
    research: { experience: 1.15, decision: 1.10, rule: 1.05, example: 1.08 },
};
/** 执行阶段 → 记忆类型加权（叠乘在任务类型之上） */
const STAGE_TYPE_BOOST = {
    explore: { decision: 1.12, rule: 1.08 },
    execute: { experience: 1.12, pitfall: 1.10, convention: 1.08 },
    verify: { rule: 1.15, convention: 1.12, pitfall: 1.08 },
};
/** 取某记忆类型在「任务+阶段」下的综合加权；两者都没传 → 恒为 1（零变化） */
function typeWeightOf(task, stage, type) {
    let w = 1;
    if (task) {
        const t = TASK_TYPE_BOOST[task];
        if (t && t[type])
            w *= t[type];
    }
    if (stage) {
        const s = STAGE_TYPE_BOOST[stage];
        if (s && s[type])
            w *= s[type];
    }
    return w;
}
/** 前置过滤（减少无效计算）：任务类型给定时的候选类型白名单；未给定 → null（不过滤）。 */
function taskTypeAllow(task, stage) {
    const t = task ? TASK_TYPE_BOOST[task] : null;
    if (!t)
        return null;
    const s = stage ? STAGE_TYPE_BOOST[stage] : null;
    return [...new Set([...Object.keys(t), ...(s ? Object.keys(s) : [])])];
}
/** 白名单 id 集缓存（以 db 实例为键，随向量缓存版本失效）——避免为过滤多付一次全表 SQL。 */
const typeSetCache = new WeakMap();
function typeIdSet(db, project, types, version) {
    let m = typeSetCache.get(db);
    if (!m) {
        m = new Map();
        typeSetCache.set(db, m);
    }
    const key = `${project}\u0000${types.join(",")}`;
    const hit = m.get(key);
    if (hit && hit.version === version)
        return hit.ids;
    const ph = types.map(() => "?").join(",");
    const rows = db
        .prepare(`SELECT id FROM memories WHERE project COLLATE NOCASE IN (?, 'global') AND status = 'active' AND type IN (${ph})`)
        .all(project, ...types);
    const ids = new Set(rows.map((r) => Number(r.id)));
    m.set(key, { version, ids });
    return ids;
}
/**
 * Gram-Schmidt 正交化：量每个候选对查询向量的「独立贡献度」。
 * 线性相关（同质重复）的候选贡献→0，正交的保留。对顺序敏感，是近似值。
 * 用途：语义路 cosine 粗筛后，把互相重复的记忆压下去，让正交的独立记忆浮上来。
 */
export function orthogonalContrib(qv, cands) {
    const dim = qv.length;
    const basis = [];
    return cands
        .map((c) => {
        let v = new Float32Array(c.vec); // 拷贝，避免污染原向量
        for (const u of basis) {
            let d = 0;
            for (let i = 0; i < dim; i++)
                d += v[i] * u[i];
            for (let i = 0; i < dim; i++)
                v[i] -= d * u[i];
        }
        let m = 0;
        for (let i = 0; i < dim; i++)
            m += v[i] * v[i];
        m = Math.sqrt(m);
        if (m > 1e-6) {
            const u = new Float32Array(dim);
            for (let i = 0; i < dim; i++)
                u[i] = v[i] / m;
            basis.push(u);
            let d = 0;
            for (let i = 0; i < dim; i++)
                d += qv[i] * u[i];
            return { id: c.id, contrib: Math.abs(d) };
        }
        return { id: c.id, contrib: 0 }; // 线性相关，无独立贡献
    })
        .sort((a, b) => b.contrib - a.contrib);
}
/**
 * 意图聚焦度（logicDepth，0~1）：用语义路候选的 cosine 相似度分布算熵。
 * VCP EPA 用 PCA 主成分熵；我们没有 Tag 坐标系，退化为直接对相似度分布算熵。
 * 熵低=相似度集中（query 聚焦某主题）→ logicDepth 高；熵高=分散（query 发散）→ logicDepth 低。
 */
export function intentDepth(sims) {
    if (sims.length === 0)
        return 0.5; // 无语义候选 → 中性，不偏袒任一路
    const m = Math.max(...sims);
    if (m <= 0)
        return 0.5;
    let psum = 0;
    const probs = sims.map((s) => {
        const p = Math.max(0, s / m);
        psum += p;
        return p;
    });
    let entropy = 0;
    for (let i = 0; i < probs.length; i++) {
        const p = psum > 0 ? probs[i] / psum : 0;
        if (p > 1e-9)
            entropy -= p * Math.log2(p);
    }
    const norm = sims.length > 1 ? entropy / Math.log2(sims.length) : 0;
    return Math.max(0, Math.min(1, 1 - norm));
}
/**
 * 词法候选管线（hybridSearch 与 archivedSearch 共用）：整串词法命中 + CJK 分词补召（并集）。
 * ★ 2026-09-30 词法补召（C2 收口）：lexSearch 对 CJK 查询走「整串 LIKE」，词序/间隔稍不同
 *   （query "四模块 全量诊断" vs 内容 "全量诊断：四模块…"）即 0 命中；语义路又常被无关的
 *   高相似记忆挤出 topK（实测该 query 下目标 sim=0.54 排名几百，截断后不进候选）→ 双路全灭。
 *   修法：按分隔符切词，逐词 lexSearch（逐词 LIKE 子串，词序无关）取**交集**（AND 语义），
 *   与整串结果做**并集**：整串命中保留原位（精度优先），交集只增不减 → 零回归获得跨词序召回。
 *   仅对含 CJK 的查询生效；英文查询仍走原 FTS 整句短语路径，行为不变。
 * ★ 2026-10-12：自 hybridSearch 原样抽出（逐字搬移、statuses 透传），供归档冷层复用 —— 避免
 *   「一份逻辑两处维护」；hybridSearch 默认 statuses=active/trial，行为与抽出前逐字一致。
 */
function lexicalCandidates(db, query, project, topK, statuses = ["active", "trial"]) {
    let lex = lexSearch(db, query, project, topK, statuses);
    if (/[一-鿿]/.test(query)) {
        // ★ 2026-10-13（检索优化）：逐词补召的 SQL 次数直接决定词法段耗时（实测单次 SQL ≈1.5ms，
        //   长查询原会拆出十几次）。三处收紧，均为「只减无用功」：
        //   ① 剔除单字词 —— 单字无 2-gram 探针，lexSearch 会落进「全表 LIKE 扫描」分支，
        //      既慢又不携带信息（AND 交集里它几乎不缩范围）；
        //   ② 去重 —— 重复词会重复执行同一条 SQL；
        //   ③ 上限 6 —— 取最长的 6 个（长词区分度更高），超过后边际收益递减。
        const terms = [...new Set(query
            .split(/[\s,，。；;、:：!！?？（）()【】[\]"'·—\-_/\\]+/)
            .map((t) => t.trim())
            .filter((t) => t.length >= 2))]
            .sort((a, b) => b.length - a.length)
            .slice(0, 6);
        if (terms.length >= 2) {
            // 逐词候选取 topK 兜底上限放大（单个常见词的 topK 截断可能把目标挡在交集外）
            const termLimit = Math.max(topK, 200);
            const lists = terms.map((t) => lexSearch(db, t, project, termLimit, statuses));
            // ★ 幻影词过滤（2026-09-30 同日精修）：整词全库 0 命中 = 转述词组（如 query『禁止单杀内核』
            //   vs 内容『禁止外部单杀内核』），不携带任何信息，留在 AND 里只会让交集恒空 → 丢弃。
            //   剩余可命中词 ≥2 才做交集；仅 1 个可命中词不补召（避免把单词的宽泛结果灌进候选池）。
            const informative = lists.filter((r) => r.length > 0);
            if (informative.length >= 2) {
                // 交集：每个可命中词的候选都出现过；按各词排名之和升序（越靠前越相关）
                const rk = new Map();
                for (const r of informative) {
                    r.forEach((h, i) => {
                        let e = rk.get(h.id);
                        if (!e) {
                            e = { sum: 0, cnt: 0, row: h };
                            rk.set(h.id, e);
                        }
                        e.sum += i + 1;
                        e.cnt += 1;
                    });
                }
                const inter = [...rk.values()]
                    .filter((e) => e.cnt === informative.length)
                    .sort((a, b) => a.sum - b.sum)
                    .map((e) => e.row);
                const inWhole = new Set(lex.map((h) => h.id));
                lex = [...lex, ...inter.filter((h) => !inWhole.has(h.id))];
            }
        }
    }
    return lex;
}
/** ★ 阶段6（2026-10-14）证据成色降权判定（热路/冷路共用）。返回乘数（默认 1 = 不降权）。
 *  触发条件（全部满足）：① simFloor 开启 ② 无词法硬证据 ③ 正文 ≤ SPEC_LEN_MAX
 *  ④ 原始余弦 ≥ simFloor（本就会过闸，降权只影响排序）⑤ p.specPenalty ∈ (0,1)。 */
function specPenaltyOf(p, id, rc, rawSim, lexScores, simFloor) {
    const pen = Number(p.specPenalty ?? SPEC_PENALTY_DEFAULT);
    if (!(pen > 0 && pen < 1))
        return 1; // 默认关 / 传 0 / 传 1 / 越界 → 降权关闭（与原行为逐字一致）
    if (!(simFloor > 0))
        return 1; // 判据依附噪声闸门：simFloor 关闭时本判据亦不生效
    if (lexScores.has(id))
        return 1; // 有词法硬证据 → 豁免（与 simFloor 同口径）
    if (!((rawSim.get(id) ?? 0) >= simFloor))
        return 1; // 分数本就不足（将被闸门剔除）→ 无需降权
    if (((rc?.content ?? "").length) > SPEC_LEN_MAX)
        return 1; // 长条目不算「短小通用」，不压
    return pen;
}
/**
 * 混合检索入口。返回按 RRF 分排序的 active 记忆（score=RRF 融合分）。
 * 副作用：命中记忆 hit_count+1、last_hit_at 更新（回血，遗忘曲线输入）。
 */
export async function hybridSearch(db, embedder, p) {
    const keywordTerms = [...new Set((p.keywords || []).map(keywordNorm).filter(Boolean))].slice(0,8);
    // 对照评测达到门槛前仅显式试验启用；无关键词/关闭时保持原检索路径。
    const keywordOn = keywordTerms.length > 0 && (p.keywordAssist ?? (process.env.MEMORYOS_KEYWORD_ASSIST === '1'));
    const limit = p.limit ?? 10;
    const topK = Math.max(40, limit * 4);
    /* ★ 2026-10-13（检索优化）：L1 结果直通车。命中即返回，但**只省重算、不改记账** ——
     *   照常执行命中回血（hit_count/last_seen_at +1），否则高频复访的记忆会因不再回血
     *   而被衰减规则误判成僵尸（与 daemon 归档判据同源，属硬约束）。 */
    const _ver = vectorCacheVersion(db);
    const _nk = `${embedIdOf(embedder)}\u0000${normQueryKey(p.query)}`; // 前缀=嵌入器实例（跨嵌入器不得复用向量/结果）
    const _rcKey = `${qualityEpoch(db)}:${p.project ?? ""}\u0000${limit}\u0000${_nk}\u0000${p.task ?? ""}\u0000${p.stage ?? ""}\u0000${p.relRatio ?? 0}\u0000${p.minScore ?? 0}\u0000${p.simFloor ?? 0}\u0000${p.type ?? ""}:sp${p.specPenalty ?? 1}:agent${p.agent ?? ""}:kw${JSON.stringify(keywordTerms)}:${keywordOn}:${keywordOn ? keywordEpoch(db) : 0}`;
    const _cached = resCacheGet(db, _rcKey, _ver);
    if (_cached) {
        bumpHits(db, _cached.out.map((x) => x.id));
        const out = _cached.out.map((x) => ({ ...x }));
        out._searchStats = {
            ..._cached.stats, cached: true,
            ms: { embed: 0, vec: 0, sem: 0, lex: 0, rrf: 0, rank: 0, bump: 0, total: 0 },
        };
        return out;
    }
    // 语义路
    let semScores = new Map();
    // ★ 2026-10-13 噪声闸门：候选的**原始余弦**（未融合前的 sim）。比例闸门与最终分都对噪声不敏感，
    //   只有原始余弦能和"库内到底有没有够格答案"直接挂钩，故单独留一份供 p.simFloor 判据使用。
    let rawSim = new Map();
    let depth = null; // 意图聚焦度；语义路成功才有值
    _lastDegradation = null; // ★ 本次检索先清零：catch 分支会重新置入
    // ★ 2026-10-03 批次C2（截断契约扩面）：把「悄悄砍」的三处量化，随返回数组带出交给调用方回执，
    //   仅在真发生截断时提示（不发生时零变化 → 零回归）。沿用既有 `top._degradation`（memory_context 路）
    //   的挂属性先例，不改返回值形态（下游仍当普通数组用，`.map/.length` 不受影响）。
    const _stats = {
        semPool: 0, // 语义路 sim>0.4 候选池大小（截断前）
        semTopK: topK, // 语义粗筛上限
        semSliced: false, // 语义候选是否被 topK 截断（截断层①）
        merged: 0, // RRF 融合后进入重排的候选总数
        preLimit: 0, // 过滤后、按 limit 截断前的条数
        returned: 0, // 最终返回条数
        limitSliced: false, // 是否被 limit 截断（截断层②）
        degraded: null, // 语义降级信息（同 _lastDegradation；随本次返回值带出，修「双 scope 只报最后一次」）
    };
    // ★ 2026-10-13 阶段0（度量与题库）：分段耗时埋点。只往既有 `_searchStats` 追加 `ms` 字段，
    //   不改返回形态、不改任何判定逻辑（零回归）。标记按执行顺序单调推进；语义路失败（catch）
    //   时缺失的标记由 `_at` 沿 _MARK_ORDER 链式回退到上一可用标记 → 不会出现负数/NaN。
    const _T = { t0: Date.now() };
    const _MARK_ORDER = ["t0", "embed", "vec", "sem", "lex", "rrf", "rank", "bump"];
    const _at = (k) => {
        for (let i = _MARK_ORDER.indexOf(k); i >= 0; i--) {
            const v = _T[_MARK_ORDER[i]];
            if (v !== undefined)
                return v;
        }
        return _T.t0;
    };
    try {
        // ★ L0 别名缓存：先按归一化键找已算过的向量；命中即跳过本地嵌入推理（实测省 ~27-33ms）。
        //   未命中时仍用**原文**送嵌入器（保证向量与原行为逐字一致，只是把结果按归一化键登记）。
        let qv = qvAliasGet(_nk);
        if (!qv) {
            const [v] = await embedder.embedTexts([p.query]);
            qv = v;
            if (qv)
                qvAliasSet(_nk, qv);
        }
        _T.embed = Date.now(); // ★ 阶段0：查询向量化（本地 BGE-M3 推理，通常为耗时最大头）
        if (qv) {
            // P0-4.1：改走带缓存的读取端。原实现每次检索都全表拉取并逐条反序列化 embedding
            // （1024 维 float32 ≈ 4KB/条 → 516 条≈2MB/次，万条级≈40MB/次），而两次写入之间该数据不变。
            // 缓存以 db 实例为键（WeakMap），写入/状态流转后由 invalidateVectorCache 失效，另有 60s TTL 兜底。
            const existing = getVectorsOnProjectCached(db, p.project, true); // 仅 active：非 active 候选后续必被过滤，提前收窄候选池
            // ★ P0-ANN：用 IVF-Flat ANN 索引把候选集从 n 压缩到 ~(nProbe/k)×n（约 6-10x 加速）。
            // ANN 索引与向量缓存同生命周期，缓存失效时自动重建（首次查询有一次性构建延迟）。
            // n < IVF_MIN_N(6000) 时 ann.query() 返回 null，无缝降级到全量 existing（小库一律精确比对，召回优先）。
            const _annIdx = getAnnIndexCached(db, p.project, true, existing);
            const _annCands = _annIdx.query(qv); // null = 未建（n 太少），降级全量
            let _semBase = _annCands ?? existing; // ANN 候选 or 全量向量
            // ★ 任务语义匹配前置过滤（新可选参数 p.task/p.stage；不传 → _allow 为 null，一个字节都不多花）：
            //   先按「任务类型 → 记忆类型」白名单收窄候选池再算 cosine —— 减少无效相似度计算，
            //   同时把与当前任务场景无关的类型（如纯 task 记录）挡在池外，属"少算且更准"的那类优化。
            const _allow = taskTypeAllow(p.task, p.stage);
            if (_allow) {
                const allowIds = typeIdSet(db, p.project, _allow, _ver);
                _semBase = _semBase.filter((e) => allowIds.has(e.id));
                _stats.preFilterTypes = _allow;
                _stats.preFilterKept = _semBase.length;
            }
            _stats.annUsed = _annCands !== null;   // 供 /api/search 回执可观测
            _stats.annCands = _annCands?.length ?? existing.length;
            // ★ 2026-10-15 跨模型守卫：embed_model/dim 出处（随 getVectorsOnProject 附带）——
            //   同一库内若混有「不同嵌入模型/维度」的向量（EMBED_MODE 曾切换、历史存量未 reembed），
            //   cosine 比较无意义（结果接近随机数）：对「与当前查询向量不同模型」的候选按 STALE_PENALTY 同等降权
            //   （保守：不剔除、不抬高，只压；方向与 P1-2.4 stale 惩罚一致，检索召回面不变，只调排序）。
            //   判据：embed_model='unknown' 或 dim=0（存量待回填）视为「模型不明」，同等降权；
            //   模型已明确且与本次查询嵌入器一致 → 正常权重。
            const _qProv = typeof embedder?.provenance === "function" ? embedder.provenance() : embedderProvenance(); // 惰性、不触发模型加载；model 名口径与写入侧一致
            const _provKnown = (e) =>
                !!e.embedModel && e.embedModel !== "unknown" && !!e.dim &&
                e.embedModel === _qProv.model && e.dim === _qProv.dim;
            _stats.provMismatch = _semBase.filter((e) => !_provKnown(e)).length; // 可观测：库内不同源向量数
            _T.vec = Date.now(); // ★ 阶段0：向量缓存读取 + ANN 索引构建/查询
            // cosine 粗筛（保留向量，供正交化重排；阈值 0.4 与原 vecSearch 一致）
            // ★ P1-2.4：对 stale（正文已改、向量未重算）的记忆按 STALE_PENALTY 降权后再排序。
            // ★ 2026-10-15：跨模型/未知出处候选按同等 STALE_PENALTY 降权（见上 _provKnown 判据）。
            const pool = _semBase
                .map((e) => ({ id: e.id, vec: e.vec, sim: cosine(qv, e.vec) * ((e.stale || !_provKnown(e)) ? STALE_PENALTY : 1) }))
                .filter((x) => x.sim > 0.4)
                .sort((a, b) => b.sim - a.sim);
            const candidates = pool.slice(0, topK);
            for (const c of candidates) rawSim.set(c.id, c.sim); // ★ 噪声闸门：留存候选原始余弦
            _stats.semPool = pool.length; // ★ 批次C2：截断层①——池大于 topK 即发生「悄悄砍」
            _stats.semSliced = pool.length > topK;
            // Gram-Schmidt 独立贡献度重排：同质重复→贡献 0，正交独立→上浮
            const ranked = orthogonalContrib(qv, candidates);
            ranked.forEach((r, i) => semScores.set(r.id, 1 / (RRF_K + i + 1)));
            // 意图聚焦度：相似度越集中(logicDepth高) → 越偏语义精排
            depth = intentDepth(candidates.map((c) => c.sim));
            _T.sem = Date.now(); // ★ 阶段0：cosine 粗筛 + 正交独立贡献度重排
        }
    }
    catch (e) {
        semScores = new Map(); // embedding 失败 → 纯词法降级
        _lastDegradation = { msg: e instanceof Error ? e.message : String(e), at: Date.now() }; // ★ 2026-09-25：不再静默，留给调用方回执告警
        _stats.degraded = _lastDegradation; // ★ 批次C2：随返回值带出（多 scope 循环逐次收集 → 不再只反映最后一次）
    }
    // 词法路（整串命中 + CJK 分词补召；抽为共享管线 lexicalCandidates，默认 statuses=active/trial）
    let lex = lexicalCandidates(db, p.query, p.project, topK);
    const keywordHits = keywordOn ? keywordCandidates(db, keywordTerms, p.project, topK) : [];
    const keywordMap = new Map(keywordHits.map(h => [h.id, h]));
    _stats.keywordCandidates = keywordHits.length;
    _T.lex = Date.now(); // ★ 阶段0：词法路（整串命中 + CJK 分词补召）
    const lexScores = new Map();
    lex.forEach((h, i) => lexScores.set(h.id, 1 / (RRF_K + i + 1)));
    // RRF 融合归并（按意图聚焦度动态加权：聚焦→偏语义，发散→偏词法；语义路失败则纯词法）
    //   semW = 0.7 + 0.7*depth ∈ [0.7,1.4]；lexW = 1.3 - 0.7*depth ∈ [1.3,0.6]
    //   depth=0.5(中性) 时 sem=1.05/lex=0.95 ≈ 等权，默认行为与改动前一致
    const semW = depth === null ? 0 : 0.7 + 0.7 * depth;
    const lexW = depth === null ? 1 : 1.3 - 0.7 * depth;
    const agg = new Map();
    for (const [id, s] of semScores)
        agg.set(id, (agg.get(id) ?? 0) + s * semW);
    for (const [id, s] of lexScores)
        agg.set(id, (agg.get(id) ?? 0) + s * lexW);
    // 有上限的辅助证据，不缩小语义候选；与原词法证据重叠时仅有限加权。
    for (const [i,h] of keywordHits.entries()) {
        const signal = 0.35 / (RRF_K+i+1) * Math.min(1.5, h.hits);
        agg.set(h.id, (agg.get(h.id) ?? 0) + signal);
    }
    _stats.merged = agg.size; // ★ 批次C2：融合后的候选总数（用于区分「池就这么多」与「被 limit 砍了」）
    _T.rrf = Date.now(); // ★ 阶段0：RRF 融合归并
    // ★ R4-5 惰性衰减 + w_sector 加权 + H4 secret 过滤 + H6 前瞻过期排除：
    //   一次性拉取全部候选行，按 final = agg × w_sector × eff_effective 重排后截断
    //   （不先截断——避免把待过滤的 secret/过期行挤进前 limit 造成"漏过滤"）。
    const now = Date.now();
    const decayEff = (rc) => {
        if (rc.pinned)
            return rc.salience; // pinned=1 免衰减
        // ★ 2026-09-25 P1-a：decision 同样不衰减 —— 与 daemon computeDecay/computeArchives 的
        //   decision 豁免（2026-09-15 回归修复，daemon.js:81/:101）对齐。检索层原只豁免 pinned，
        //   导致约 190 天无曝光的 decision 被 eff≤0.15 静默排除，而 daemon 又永不归档它
        //   → 决策类记忆变成「库里活着、检索里消失」的僵尸，正是"召回差且查不出原因"的一类根因。
        if (rc.type === "decision")
            return rc.salience;
        const lambda = rc.decay_lambda ?? SECTORS[rc.sector]?.lambda ?? 0.01; // 单位/天（M9）
        const base = rc.last_seen_at ?? rc.created_at; // H5：以最近被检索为基准，高频使用不衰
        const days = Math.max(0, (now - Date.parse(base)) / 86400000);
        return rc.salience * Math.exp(-lambda * days);
    };
    const wOf = (rc) => SECTORS[rc.sector]?.w ?? 1;
    // ★ 阶段6（2026-10-14）：simFloor 提前取值 —— 证据成色降权要在下方排序公式内使用
    //   （原声明在闸门段、位于该公式之后，const 处于 TDZ 无法引用 → 此处上移，闸门段改为注释）。
    const simFloor = Number(p.simFloor ?? 0);
    const fetchedAll = readMemoriesByIds(db, [...agg.keys()]);
    const conflicts = conflictMap(db, [...agg.keys()]);
    for (const [id,r] of fetchedAll) r.conflict_peers=conflicts.get(Number(id))??[];
    const rankedAll = [...agg.keys()]
        .map((id) => {
        const rc = fetchedAll.get(id);
        if (!rc || rc.status !== "active")
            return null;
        if (String(rc.sensitivity ?? "normal") === "secret")
            return null; // H4 双保险（词法路已 SQL 过滤，语义路在此兜底）
        // ★ C 2026-09-14：卡片派发任务（source_ref='card:N'）不进普通检索 —— 避免把「待办的卡任务」当经验记忆召回
        //   （任务应经 task_next/task_claim 领取，不是当记忆搜出来）。agent 手动 task_assign 保留在检索（真·经验片）。
        if (rc.type === "task" && (rc.source_ref ?? "").startsWith("card:"))
            return null;
        if (rc.superseded_by || (rc.valid_from && Date.parse(rc.valid_from) > now)) return null;
        if (rc.valid_until && Date.parse(rc.valid_until) <= now)
            return null; // H6：前瞻已过期直接排除
        const eff = decayEff(rc);
        if (eff <= 0.15)
            return null; // 沿用原 eff 阈值（现为现算的显著度衰减）
        // ★ R4-4：waypoint 图关联加分（0.85~1.15），邻居在高频集越多越靠前
        const wp = waypointOf(db, id);
        // ★ 任务类型/阶段加权（新可选参数；不传时 typeWeightOf 恒返回 1 → 公式与改动前逐字一致）
        const tw = typeWeightOf(p.task, p.stage, rc.type);
        // ★ P1-C（2026-10-13）：一跳图扩展加分（links 表 memory→memory 关系，0.85~1.15 区段内微调）
        const gb = p.graphOff ? 1 : graphBoost(db, id);
        // ★ 阶段6（2026-10-14）证据成色判据：无词法证据 + 短正文的高余弦条目降权（不剔除，只下沉）
        const sp = specPenaltyOf(p, id, rc, rawSim, lexScores, simFloor);
        return { id, rc, penalized: sp < 1, final: agg.get(id) * wOf(rc) * eff * (0.85 + 0.3 * wp) * tw * gb * sp };
    })
        .filter((x) => x !== null)
        .sort((a, b) => b.final - a.final);
    // ★ 2026-10-13 相关性校验闸门（新可选参数，默认关）：剔除低匹配/无关尾部。
    //   relRatio：相对首条得分的比例下限（0.6 即"至少要有首条六成相关"）；minScore：绝对下限。
    //   两者都为 0（默认）时 gated === rankedAll，逐字等价改动前 —— 门禁与既有行为零变化。
    //   注：只作用于**输出层**，库内记忆一条不删、状态不变（用户红线：旧记忆不清）。
    const relRatio = Number(p.relRatio ?? 0);
    const minScore = Number(p.minScore ?? 0);
    // ★ 2026-10-13 噪声闸门（新可选参数 p.simFloor，默认 0 = 关，逐字等价改动前）：
    //   背景——比例闸门（relRatio）在「库内根本没有答案」的噪声提问下失效：BGE-M3 对同语言文本的
    //   余弦普遍挤在 0.62~0.75 的窄带里（向量各向异性），库内所有条彼此比例都接近 1，比例判据分不出
    //   「有没有答案」。改用**绝对语义下限**：候选的原始余弦 ≥ simFloor 才留。
    //   豁免：命中词法证据（整串或分词交集 → 内容里真有查询词）者无条件保留，保「原文子串」类查询零回归。
    //   实证（5 噪声题 + 5 转述题，生产库快照）：噪声题全库最高余弦 0.620~0.746 且零词法证据；
    //   转述题 0.788~0.814 → 取 0.76 可把噪声整页清空（250→0），且在返回内的真答案一条不丢。
    //   仅作用于**输出层**：库内记忆一条不删、状态不变（用户红线）。
    //   （simFloor 已在上方排序公式段提前取值 —— 证据成色降权需在公式内引用，见 ★ 阶段6 注释）
    const gated = relRatio > 0 || minScore > 0 || simFloor > 0
        ? (() => {
            // 先排除不满足绝对证据门槛的候选，再以合格候选计算相对阈值。
            // 否则被simFloor剔除的高显著度条目仍会抬高top，导致正确答案全部被误滤。
            const eligible = rankedAll.filter((x) => x.final >= minScore &&
                (simFloor <= 0 || (rawSim.get(x.id) ?? 0) >= simFloor || lexScores.has(x.id) || (keywordMap.get(x.id)?.hits ?? 0) >= 2));
            const top = eligible[0]?.final ?? 0;
            return eligible.filter((x) => relRatio <= 0 || x.final >= top * relRatio);
        })()
        : rankedAll;
    // ★ P1-B（2026-10-13）：type 过滤（新可选参数；不传时逐字等价改动前）
    const typeFiltered = gated.filter((x) => (!p.type || x.rc.type === p.type) && (!p.agent || x.rc.agent === p.agent));
    // ★ 批次C2：截断层②——过滤后按 limit 截断（原为链式 `.slice(0, limit)`，拆出以便量化）
    const uniqueRanked = distinctMemories(typeFiltered, (x) => x.rc.content);
    const ranked = uniqueRanked.slice(0, limit);
    _stats.preLimit = uniqueRanked.length;
    _stats.duplicatesDropped = typeFiltered.length - uniqueRanked.length;
    _stats.gateDropped = rankedAll.length - typeFiltered.length;
    if (p.type)
        _stats.typeFiltered = p.type;
    if (simFloor > 0) {
        // ★ 噪声闸门可观测：本次因「余弦不足且无词法证据」被剔除的条数
        _stats.simFloor = simFloor;
        _stats.lowEvidence = rankedAll.filter((x) => !((rawSim.get(x.id) ?? 0) >= simFloor || lexScores.has(x.id) || (keywordMap.get(x.id)?.hits ?? 0) >= 2)).length;
    }
    // ★ 阶段6 可观测：仅在本判据生效（specPenalty ∈ (0,1)）时追加，默认关 → 响应体零变化
    if (simFloor > 0) {
        const _spen = Number(p.specPenalty ?? SPEC_PENALTY_DEFAULT);
        if (_spen > 0 && _spen < 1) {
            _stats.specPenalty = _spen;
            _stats.specPenalized = rankedAll.filter((x) => x.penalized).length;
        }
    }
    _stats.returned = ranked.length;
    _stats.limitSliced = uniqueRanked.length > limit;
    _T.rank = Date.now(); // ★ 阶段0：批量回填行 + 惰性衰减/权重/waypoint 打分与排序
    const out = [];
    const hitIds = [];
    for (const { id, rc } of ranked) {
        out.push({
            id: rc.id,
            content: rc.content,
            matched_keywords: keywordMap.get(id)?.matched?.split(",") ?? [],
            type: rc.type,
            agent: rc.agent,
            project: rc.project,
            status: rc.status,
            confidence: rc.confidence,
            created_at: rc.created_at,
            valid_from: rc.valid_from, valid_until: rc.valid_until, source_ref: rc.source_ref,
            conflict_with: rc.conflict_with, conflict_peers: rc.conflict_peers ?? conflictMap(db,[rc.id]).get(Number(rc.id)) ?? [], superseded_by: rc.superseded_by,
            score: rc.salience * wOf(rc), // 暴露显著度×权重供上层参考（RRF 原始分见 final 逻辑）
            // ★ P1-A（2026-10-13）：带出有效显著度（衰减后），供 memory_context 按 eff 过滤低相关记忆
            eff: rc.salience * Math.exp(-(rc.decay_lambda ?? 0) * Math.max(0, (Date.now() - Date.parse(rc.last_seen_at ?? rc.created_at)) / 86400000)),
            // ★ 批次C4（P1-12 证据分离，按 MemoryOS 语义裁剪）：召回通道归因。rankedAll 只含 RRF 并集 id
            //   → 每命中必在语义/词法至少一路；双路都在 = hybrid。语义路降级（semScores 空）时自然全 lexical。
            via: keywordMap.has(id) ? "keyword-assisted" : semScores.has(id) ? (lexScores.has(id) ? "hybrid" : "semantic") : "lexical",
        });
        hitIds.push(id);
    }
    // H5：命中回血升级 —— 同步 last_seen_at（惰性衰减的刷新基准）。withTx 守卫并发。
    bumpHits(db, hitIds); // ★ 2026-10-13：同一次检索的 N 条合并为一条 IN 语句（语义与逐条 UPDATE 逐字等价）
    _T.bump = Date.now(); // ★ 阶段0：命中回血写回（SQLite 落盘，批量 UPDATE 包事务）
    // ★ 2026-10-13 阶段0：分段耗时汇总（只增 `ms` 字段，既有字段逐字不变）。
    //   缺失标记沿 _MARK_ORDER 链式回退 → 语义路失败时 embed/vec/sem 段为实测值，其余正常。
    _stats.ms = {
        embed: _at("embed") - _at("t0"),
        vec: _at("vec") - _at("embed"),
        sem: _at("sem") - _at("vec"),
        lex: _at("lex") - _at("sem"),
        rrf: _at("rrf") - _at("lex"),
        rank: _at("rank") - _at("rrf"),
        bump: _at("bump") - _at("rank"),
        total: _at("bump") - _at("t0"),
    };
    out._searchStats = _stats; // ★ 批次C2：截断/降级量化随返回值带出（调用方回执据此告警）
    // ★ 2026-10-13：L1 结果直通车登记（含本次 _stats）。失效由向量缓存版本号 + 30s TTL 双保险，
    //   任何写入/状态流转都会改版本号 → 绝不会把"已改正文"的旧结果端出去。
    resCacheSet(db, _rcKey, _ver, out, _stats);
    return out;
}
/**
 * ★ 2026-10-12 冷层兜底检索（归档区可搜）—— 用户红线「旧记忆不清掉，后续任务可能要用」的落地。
 *
 * 背景：自动归档（daemon 45 天窗口 / eff 阈值）会把长期无曝光的记忆置为 status='archived'，
 *   而 hybridSearch 契约只返回 active/trial ⇒ 用户想起要用时再也搜不到，体感等于"记忆丢了"。
 *   取向：**不动存量、不放宽归档阈值、不改 hybridSearch 契约**（保门禁），只在检索侧补一层 ——
 *   由 MCP 出口层在「在库（active）结果不足」时补查本层，结果排后 + 标注来源。
 *
 * 口径：
 *   · 只查 status='archived'（rejected/superseded 依然完全排除）；
 *   · 语义 + 词法 RRF 融合（与 hybridSearch 同形态），但**不参与 eff 衰减/waypoint** —— 归档条本就是
 *     因衰减到 eff≤0.15 才被归档，再用同一条规则排会被二次淘汰；冷层按「与查询的相关度」排；
 *   · secret 不出（词法路 SQL 已过滤，语义路此处兜底）；卡片派发任务（type=task 且 source_ref=card:）
 *     与 hybridSearch 同口径不进检索；
 *   · 不 bump hit_count / last_seen_at —— 冷层是"回忆"行为，不反向改动归档条的治理基准（避免与 daemon 耦合）。
 * 返回项额外带 `archived:true`，供调用方标注「来自归档区」。
 */
export async function archivedSearch(db, embedder, p) {
    const limit = p.limit ?? 5;
    const topK = Math.max(20, limit * 4);
    const semScores = new Map();
    const rawSim = new Map(); // ★ 2026-10-13 噪声闸门：冷层同样留存候选原始余弦（与热路同判据）
    try {
        // ★ 2026-10-13：冷层与热路共用 L0 别名缓存（同一句查询在真实调用里两层都会问一遍，
        //   措辞微抖时两边的嵌入却各算一次 → 白付一次 ~28ms 推理）。与热路同口径：原文本送嵌入器，
        //   结果按归一化键登记，向量空间不变。
        const _ank = `${embedIdOf(embedder)}\u0000${normQueryKey(p.query)}`;
        let qv = qvAliasGet(_ank);
        if (!qv) {
            const [v] = await embedder.embedTexts([p.query]);
            qv = v;
            if (qv)
                qvAliasSet(_ank, qv);
        }
        if (qv) {
            // ★ 2026-10-15 跨模型守卫：与热路同判据（_provKnown），冷层候选若模型不明/不同源，同等 STALE_PENALTY 降权
            const _qProv = typeof embedder?.provenance === "function" ? embedder.provenance() : embedderProvenance();
            const _provKnown = (e) =>
                !!e.embedModel && e.embedModel !== "unknown" && !!e.dim &&
                e.embedModel === _qProv.model && e.dim === _qProv.dim;
            const pool = getArchivedVectorsOnProject(db, p.project)
                .map((e) => ({ id: e.id, sim: cosine(qv, e.vec) * (_provKnown(e) ? 1 : STALE_PENALTY) }))
                .filter((x) => x.sim > 0.4)
                .sort((a, b) => b.sim - a.sim)
                .slice(0, topK);
            pool.forEach((r, i) => {
                semScores.set(r.id, 1 / (RRF_K + i + 1));
                rawSim.set(r.id, r.sim);
            });
        }
    }
    catch (e) {
        // 嵌入失败 → 纯词法兜底（与 hybridSearch 的降级取向一致：不抛，只降级并留痕）
        console.warn(`[archivedSearch] 语义路降级为纯词法（嵌入失败）：${e instanceof Error ? e.message : String(e)}`);
    }
    const lex = lexicalCandidates(db, p.query, p.project, topK, ["archived"]);
    const lexScores = new Map();
    lex.forEach((h, i) => lexScores.set(h.id, 1 / (RRF_K + i + 1)));
    const agg = new Map();
    for (const [id, s] of semScores)
        agg.set(id, (agg.get(id) ?? 0) + s);
    for (const [id, s] of lexScores)
        agg.set(id, (agg.get(id) ?? 0) + s);
    const rows = readMemoriesByIds(db, [...agg.keys()]);
    // ★ 2026-10-13 噪声闸门（可选 p.simFloor，默认 0 = 关）：冷层与热路同判据 —— 余弦≥下限 或 有词法证据。
    //   否则「热路已按证据清空、冷层又补一波无关归档条」会让噪声整页复活，等于没修。
    const simFloor = Number(p.simFloor ?? 0);
    const ranked = [...agg.keys()]
        .map((id) => {
        const rc = rows.get(id);
        if (!rc || rc.status !== "archived")
            return null; // 只认 archived（词法路已限定状态，此处双重保险）
        if (String(rc.sensitivity ?? "normal") === "secret")
            return null;
        if (rc.superseded_by || rc.conflict_with || (rc.valid_from && Date.parse(rc.valid_from) > Date.now()) || (rc.valid_until && Date.parse(rc.valid_until) <= Date.now())) return null;
        if (rc.type === "task" && (rc.source_ref ?? "").startsWith("card:"))
            return null;
        // ★ 阶段6（2026-10-14）证据成色判据：冷层与热路同口径（短小且无词法证据的高余弦归档条降权）
        return { id, rc, final: agg.get(id) * specPenaltyOf(p, id, rc, rawSim, lexScores, simFloor) };
    })
        .filter((x) => x !== null)
        .filter((x) => simFloor <= 0 || (rawSim.get(x.id) ?? 0) >= simFloor || lexScores.has(x.id) || (keywordMap.get(x.id)?.hits ?? 0) >= 2)
        .sort((a, b) => b.final - a.final);
    return distinctMemories(ranked, (x) => x.rc.content).slice(0, limit).map(({ id, rc }) => ({
        id: rc.id,
        content: rc.content,
        type: rc.type,
        agent: rc.agent,
        project: rc.project,
        status: rc.status,
        confidence: rc.confidence,
        created_at: rc.created_at,
        valid_from: rc.valid_from, valid_until: rc.valid_until, source_ref: rc.source_ref,
        conflict_with: rc.conflict_with, conflict_peers: rc.conflict_peers ?? conflictMap(db,[rc.id]).get(Number(rc.id)) ?? [], superseded_by: rc.superseded_by,
        score: rc.salience,
        via: semScores.has(id) ? (lexScores.has(id) ? "hybrid" : "semantic") : "lexical",
        archived: true,
    }));
}
