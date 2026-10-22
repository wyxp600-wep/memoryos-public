/**
 * MemoryOS v0.1 → v0.2 — embedding 适配层（M-1.2）
 * 双模式 + query 指令前缀 + 结果缓存 + 降级。
 *   EMBED_MODE=local  本地 BGE-M3（@huggingface/transformers 懒加载，需模型下载，几百MB）
 *   EMBED_MODE=api    外部 OpenAI 兼容 embeddings API（EMBED_API_URL / EMBED_API_KEY / EMBED_MODEL）
 *   EMBED_MODE=fake   确定性伪向量（仅供管线自测，不具真实语义）
 *       默认 fake —— 需真实语义时显式切 local/api。
 */
import path from "node:path";
import os from "node:os";
/** ★ 2026-09-25 P0③：模式改为**调用时**惰性解析（原为模块体求值 —— 会把 import 瞬间的 env 固化，
 *  调用方（如 server.js）在其后补的缺省 EMBED_MODE 就永远读不到，语义检索会静默退化成 fake）。
 *  默认值不变：未设 env → fake。 */
const resolveMode = () => process.env.EMBED_MODE ?? "fake";
const RUNTIME_DIM = Number(process.env.EMBED_DIM ?? 1024);
/* ---------- 通用缓存 ---------- */
class TextCache {
    max;
    m = new Map();
    hits = 0;
    misses = 0;
    evicted = 0;
    constructor(max = 4096) {
        this.max = max;
    }
    get(text) {
        const v = this.m.get(text);
        if (v) {
            this.hits++;
            return v;
        }
        this.misses++;
        return undefined;
    }
    set(text, v) {
        if (this.m.size >= this.max) {
            // P0-perf（B7′）：满时 FIFO 逐出最旧一条，替代旧 clear() 全清 —— 全清会让后续 4096 条
            // 全部 miss 重跑嵌入推理形成洪峰；Map 迭代序=插入序，delete 最旧 key 即 FIFO。
            const oldest = this.m.keys().next().value;
            this.m.delete(oldest);
            this.evicted++;
            if (this.evicted % 1024 === 0) {
                console.log(`[embed-cache] FIFO 逐出 ${this.evicted} 条（上限 ${this.max}，hits=${this.hits} misses=${this.misses}）`);
            }
        }
        this.m.set(text, v);
    }
    stats() {
        return { size: this.m.size, max: this.max, hits: this.hits, misses: this.misses, evicted: this.evicted };
    }
}
/* ---------- fake：确定性伪向量（仅测机制，无语义） ---------- */
class FakeEmbedder {
    dim = RUNTIME_DIM;
    mode = "fake";
    cache = new TextCache();
    /** ★ 2026-10-15：向量出处（供 upsertVector 的 opts.model/dim 使用；见 db.js） */
    provenance() {
        return { model: "fake", dim: this.dim };
    }
    /** 基于字符二元组哈希 → 稳定单位向量。同"主题词"共享子串故局部相似。 */
    async embedTexts(texts) {
        return texts.map((t) => {
            const hit = this.cache.get(t);
            if (hit)
                return hit;
            const v = new Float32Array(this.dim);
            const norm = 0;
            for (let i = 0; i < t.length - 1; i++) {
                const h = hash(`${t[i]}${t[i + 1]}`);
                v[h % this.dim] += 1;
            }
            if (t.length === 1)
                v[hash(t) % this.dim] = 1;
            // 归一化（余弦相似度需要单位向量）
            let n = 0;
            for (let i = 0; i < v.length; i++)
                n += v[i] * v[i];
            n = Math.sqrt(n) || 1;
            for (let i = 0; i < v.length; i++)
                v[i] /= n;
            this.cache.set(t, v);
            return v;
        });
    }
}
/* ---------- API 模式：OpenAI 兼容 /v1/embeddings ---------- */
class ApiEmbedder {
    dim = RUNTIME_DIM;
    mode = "api";
    cache = new TextCache();
    url = process.env.EMBED_API_URL ?? "http://127.0.0.1:18900/v1/embeddings";
    model = process.env.EMBED_MODEL ?? "bge-m3";
    key = process.env.EMBED_API_KEY ?? "";
    constructor() {
        if (!this.key)
            throw new Error("EMBED_MODE=api 但 EMBED_API_KEY 未设置，请在环境变量中配置后重试");
    }
    /** ★ 2026-10-15：向量出处（model 名取自 EMBED_MODEL 配置，与写入请求体一致） */
    provenance() {
        return { model: this.model, dim: this.dim };
    }
    async embedTexts(texts) {
        const out = [];
        const miss = [];
        const missIdx = [];
        texts.forEach((t, i) => {
            const c = this.cache.get(t);
            if (c)
                out[i] = c;
            else {
                miss.push(t);
                missIdx.push(i);
            }
        });
        if (miss.length) {
            const res = await fetch(this.url, {
                method: "POST",
                headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
                body: JSON.stringify({ model: this.model, input: miss }),
            });
            if (!res.ok)
                throw new Error(`embed API ${res.status}`);
            const data = (await res.json());
            data.data.forEach((d, j) => {
                const v = Float32Array.from(d.embedding);
                this.cache.set(miss[j], v);
                out[missIdx[j]] = v;
            });
        }
        return out;
    }
}
/* ---------- 本地模式：@huggingface/transformers 懒加载 BGE-M3 ---------- */
async function loadLocalEmbedder() {
    // 用变量间接 import()：包未显式安装，非字面量 import() TS 不解析模块（返回 any），避免 TS2307
    const hf = "@huggingface/transformers";
    const xenova = "@xenova/transformers";
    let tf;
    let isXenova = false;
    try {
        tf = await import(hf);
    }
    catch {
        // 兼容旧包名
        tf = await import(xenova);
        isXenova = true;
    }
    // 国内镜像注入：EMBED_REMOTE_HOST=https://hf-mirror.com（旧 @xenova 用 env.remoteHost，新 @huggingface 用 HF 下载 env）
    const host = process.env.EMBED_REMOTE_HOST;
    if (host) {
        try {
            if (isXenova && tf.env)
                tf.env.remoteHost = host;
            else if (tf.env?.remoteHost)
                tf.env.remoteHost = host; // @huggingface/transformers ≥3 用 env.remoteHost
        }
        catch {
            /* 镜像注入失败不阻断 */
        }
    }
    const modelName = process.env.EMBED_MODEL ?? "Xenova/bge-m3";
    const pipe = await tf.pipeline("feature-extraction", modelName, {
        dtype: "fp32",
        cache_dir: process.env.EMBED_CACHE_DIR ?? path.join(os.homedir(), ".cache", "memoryos-embed"),
    });
    return new LocalEmbedder(pipe, modelName);
}
class LocalEmbedder {
    mode = "local";
    dim = RUNTIME_DIM;
    cache = new TextCache();
    pipe;
    modelName;
    constructor(pipe, model) {
        this.pipe = pipe;
        this.modelName = model;
    }
    /** ★ 2026-10-15：向量出处（model 名 = 实际加载的 HF 模型标识，dim = RUNTIME_DIM） */
    provenance() {
        return { model: this.modelName, dim: this.dim };
    }
    async embedTexts(texts) {
        const out = [];
        for (let i = 0; i < texts.length; i++) {
            const c = this.cache.get(texts[i]);
            if (c) {
                out[i] = c;
                continue;
            }
            // BGE 系 query 指令前缀：检索端点需加，保证两侧一致
            const input = texts[i]; // 写入与查询同一模板；如需 query 指令可在负载里按需加
            const outT = await this.pipe(input, { pooling: "mean", normalize: true });
            const v = Float32Array.from(outT.data);
            this.cache.set(texts[i], v);
            out[i] = v;
        }
        return out;
    }
}
/* ---------- 工具 ---------- */
function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
export function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (!na || !nb)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/** 序列化 float32 -> Buffer（存 SQLite BLOB） */
export function vecToBuf(v) {
    const b = Buffer.alloc(v.length * 4);
    for (let i = 0; i < v.length; i++)
        b.writeFloatLE(v[i], i * 4);
    return b;
}
/** Buffer -> Float32Array（兼容 node:sqlite 把 BLOB 返回为 Uint8Array） */
export function bufToVec(b) {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
    const n = Math.floor(buf.length / 4);
    // 零拷贝快路径：同址建 Float32 视图，省掉 n 次 readFloatLE 调用（检索/治理每次要解上千条向量）。
    // 前提：宿主为小端（x64/arm64 均满足）且 byteOffset 4 字节对齐；不满足则回落逐元素解码。
    if (buf.byteOffset % 4 === 0 && buf.buffer.byteLength >= buf.byteOffset + n * 4) {
        return new Float32Array(buf.buffer, buf.byteOffset, n);
    }
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++)
        v[i] = buf.readFloatLE(i * 4);
    return v;
}
let _local = null;
let _api = null;
/** ★ 2026-10-14（架构重构 1a）：**本进程**是否已真正驻留嵌入模型 —— 只读状态位，不触发加载。
 *  核心 /ops/catalog 据此如实上报（1a 的收敛目标正是"模型只让核心加载一份"）。 */
export function embedderLoaded() { return _local !== null || _api !== null; }
/** 工厂：按 EMBED_MODE 生产；local 为懒加载（首次真正调用才下载模型）。 */
export async function getEmbedder() {
    const mode = resolveMode(); // ★ P0③：每次调用解析（惰性），不再吃模块体固化的值
    if (mode === "local") {
        if (!_local)
            _local = await loadLocalEmbedder();
        return _local;
    }
    if (mode === "api") {
        if (!_api)
            _api = new ApiEmbedder();
        return _api;
    }
    return new FakeEmbedder();
}
export function embedMode() {
    return resolveMode();
}
/**
 * ★ 2026-10-15 向量出处：取当前嵌入器的 model/dim 标签，供 upsertVector 的 opts.model/dim 使用。
 * 惰性解析——不触发 local 模型加载（未调用 getEmbedder() 时 model 名按当前 EMBED_MODE/EMBED_MODEL
 * 配置推导，与真正的写入路径一致，仅用于「记录出处」，不承担推理职责）。
 */
export function embedderProvenance() {
    const mode = resolveMode();
    if (mode === "local")
        return { model: process.env.EMBED_MODEL ?? "Xenova/bge-m3", dim: RUNTIME_DIM };
    if (mode === "api")
        return { model: process.env.EMBED_MODEL ?? "bge-m3", dim: RUNTIME_DIM };
    return { model: "fake", dim: RUNTIME_DIM };
}
