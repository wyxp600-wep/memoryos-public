/**
 * MemoryOS — IVF-Flat ANN（Approximate Nearest Neighbor）索引
 *
 * 问题：hybridSearch 语义路对全量向量逐条 cosine，O(n×dim)，n=1500→≈15ms；n→万条退化为秒级。
 * 方案：进程内 IVF-Flat 索引（纯 JS，零额外依赖）：
 *   · 构建：随机初始化 + k-means 迭代，一次性，随向量缓存失效自动重建；
 *   · 查询：只对最近 nProbe 个聚类内的向量做精确 cosine，候选集≈(nProbe/k)×n，约 6-10x 加速；
 *   · 兜底：建索引前或 n < IVF_MIN_N 时返回 null，调用方自动降级全量扫描。
 *
 * 约束：
 *   · node:sqlite 禁 load_extension → sqlite-vec 不可用，必须纯 JS 实现；
 *   · 不 import embed.js / ONNX 等 ML 层（db.js 依赖反向禁止规则）；
 *   · 只处理 Float32Array，不感知向量语义。
 */

/**
 * ★ 2026-10-13（检索优化）：召回优先的参数整定。
 *   实证（dist/bench-retrieval.js，n=1664）：原参数（FRAC=0.15 / MIN_CANDS=100）只勘察
 *   15%~25% 的向量，15 道转述题里 6 道的正确答案被直接挡在候选外 —— 其中一道正确答案
 *   本为全量第 1 名（cos=0.81）也丢了。近似省下的时间（vec 阶段 0.4ms）远抵不上丢掉的召回。
 *   取向：**小库一律精确比对**（n < IVF_MIN_N 直接不建索引，调用方降级全量 scan），
 *   大库才启用 ANN，且勘察面显著放大 + 候选不足自动继续扩 probe。
 */
/** n < IVF_MIN_N 时跳过建索引，直接全量 cosine。
 *  1664 条规模下全量 cosine ≈ 2ms，比 ANN 多花约 1.5ms，但召回 100% —— 净赚。 */
const IVF_MIN_N = 6000;
/** K = max(IVF_K_MIN, ceil(sqrt(n) × IVF_K_SCALE)) */
const IVF_K_SCALE = 0.8;
const IVF_K_MIN = 8;
/** k-means 迭代次数（少量迭代，构建速度优先） */
const IVF_ITERS = 2;
/** 默认 probe 比例：nProbe = max(IVF_NPROBE_MIN, ceil(k × IVF_NPROBE_FRAC)) */
const IVF_NPROBE_FRAC = 0.45;
const IVF_NPROBE_MIN = 8;
/** probe 上限按簇数放开（原 30 会在 k 大时把 45% 的目标卡回 ~21%） */
const IVF_NPROBE_MAX = 4096;
/** 自适应 probe：候选绝对下限 */
const IVF_MIN_CANDS = 300;
/** 自适应 probe：候选数低于 n × TARGET_FRAC 时继续扩 probe（直到探完所有簇） */
const IVF_TARGET_FRAC = 0.35;

/** L2 范数 */
function l2norm(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
}

/** 点积（a、b 等长 Float32Array） */
function dotProd(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

/** 返回最近聚类中心下标（中心已 L2 归一化，dot == cosine） */
function nearestCentroid(v, centroids) {
    let best = 0, bestD = -Infinity;
    for (let c = 0; c < centroids.length; c++) {
        const d = dotProd(centroids[c], v);
        if (d > bestD) { bestD = d; best = c; }
    }
    return best;
}

/**
 * 进程内 IVF-Flat ANN 索引。
 * 生命周期由 db.js 的向量缓存管理：缓存版本变化时重建。
 */
export class IvfAnnIndex {
    constructor() {
        this._built = false;
        this._n = 0;
        this._k = 0;
        this._dim = 0;
        /** @type {Float32Array[]} L2 归一化的聚类中心 */
        this._centroids = [];
        /** @type {Array<Array<{id:number,vec:Float32Array,stale:boolean}>>} */
        this._lists = [];
    }

    /**
     * 构建索引（同步）。
     * @param {Array<{id:number, vec:Float32Array, stale:boolean}>} vectors
     */
    build(vectors) {
        this._built = false;
        const n = vectors.length;
        if (n < IVF_MIN_N || !vectors[0]?.vec?.length) return;

        const dim = vectors[0].vec.length;
        const k = Math.max(IVF_K_MIN, Math.ceil(Math.sqrt(n) * IVF_K_SCALE));

        /* 随机初始化：Fisher-Yates 洗牌取前 k 个 */
        const perm = Array.from({ length: n }, (_, i) => i);
        for (let i = 0; i < k; i++) {
            const j = i + Math.floor(Math.random() * (n - i));
            const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        }
        const centroids = perm.slice(0, k).map(idx => {
            const c = new Float32Array(vectors[idx].vec);
            const mag = l2norm(c);
            if (mag > 1e-9) for (let d = 0; d < dim; d++) c[d] /= mag;
            return c;
        });

        /* k-means 迭代：Float64 累加防精度损失 */
        for (let iter = 0; iter < IVF_ITERS; iter++) {
            const sums = Array.from({ length: k }, () => new Float64Array(dim));
            const cnts = new Int32Array(k);
            for (const v of vectors) {
                const ci = nearestCentroid(v.vec, centroids);
                const s = sums[ci];
                for (let d = 0; d < dim; d++) s[d] += v.vec[d];
                cnts[ci]++;
            }
            for (let c = 0; c < k; c++) {
                if (cnts[c] === 0) continue; // 空聚类保留原中心
                const s = sums[c], nc = centroids[c];
                let mag = 0;
                for (let d = 0; d < dim; d++) mag += s[d] * s[d];
                mag = Math.sqrt(mag);
                if (mag > 1e-9) for (let d = 0; d < dim; d++) nc[d] = s[d] / mag;
            }
        }

        /* 构建倒排列表 */
        const lists = Array.from({ length: k }, () => []);
        for (const v of vectors) lists[nearestCentroid(v.vec, centroids)].push(v);

        this._built = true;
        this._n = n; this._k = k; this._dim = dim;
        this._centroids = centroids; this._lists = lists;
    }

    /**
     * ANN 查询：返回候选向量集合（调用方做精确 cosine 重排序）。
     * @param {Float32Array} qv 查询向量
     * @returns {Array<{id:number,vec:Float32Array,stale:boolean}>|null}
     *   null = 未构建，调用方降级全量扫描
     */
    query(qv) {
        if (!this._built) return null;
        const k = this._k;

        /* 对所有聚类中心打分 */
        const scores = new Float32Array(k);
        for (let c = 0; c < k; c++) scores[c] = dotProd(this._centroids[c], qv);
        /* 按相似度降序排列中心下标 */
        const order = Array.from({ length: k }, (_, i) => i)
            .sort((a, b) => scores[b] - scores[a]);

        const nProbeBase = Math.min(
            IVF_NPROBE_MAX,
            Math.max(IVF_NPROBE_MIN, Math.ceil(k * IVF_NPROBE_FRAC)));
        /* 自适应目标：候选既不能少于绝对下限，也不能少于全量的 TARGET_FRAC ——
         * 不足则继续探下一近簇，直到「两个条件都满足」或「所有簇探完」（不会死循环）。 */
        const target = Math.min(this._n, Math.max(IVF_MIN_CANDS, Math.ceil(this._n * IVF_TARGET_FRAC)));

        const seen = new Set();
        const cands = [];
        for (let p = 0; p < k; p++) {
            for (const v of this._lists[order[p]]) {
                if (!seen.has(v.id)) { seen.add(v.id); cands.push(v); }
            }
            if (p + 1 >= nProbeBase && cands.length >= target) break;
        }
        return cands;
    }

    /** 调试/诊断统计 */
    stats() {
        if (!this._built) return { built: false, n: this._n };
        const sizes = this._lists.map(l => l.length);
        return {
            built: true, n: this._n, k: this._k,
            avgListSize: (this._n / this._k).toFixed(1),
            minListSize: Math.min(...sizes),
            maxListSize: Math.max(...sizes),
        };
    }
}
