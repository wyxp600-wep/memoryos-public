/**
 * MemoryOS — LLM 提炼客户端（采集消化用）
 * 端点配置**每次调用现读**：LLM_* 显式覆盖 > config.json（设置页） > MIMOS_URL/INGEST_MODEL 旧变量 > 默认 mimo-proxy。
 *   为什么改成现读：原先在模块加载时把 MIMOS_URL/INGEST_MODEL 读成常量，运行中的进程看不到设置页的改动，
 *   于是「保存 LLM 配置」必须重启内核才生效。现读之后设置页保存即时生效，无需重启。
 * 端点写法兼容：填 base（http://host/v1）或完整端点（http://host/v1/chat/completions）都能用。
 * 密钥：env LLM_API_KEY/INGEST_KEY 优先；否则解 config.json 的 llmKeyEnc（DPAPI 密文，见 secret-store.js）。
 * 只读调用，不做任何写库。
 */
import { env } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { unprotectSecret } from "./secret-store.js";
const DEFAULT_URL = "http://127.0.0.1:18900/v1/chat/completions";
const DEFAULT_MODEL = "agnes-2.5-flash";
/** 数据目录：与 dashboard.js 同口径（MEMORYOS_DATA_DIR 优先，否则由 MEMORY_DB 反推） */
function dataDir() {
    if (env.MEMORYOS_DATA_DIR)
        return env.MEMORYOS_DATA_DIR;
    const db = env.MEMORY_DB;
    return db ? path.dirname(path.dirname(db)) : "";
}
function readDiskConfig() {
    const dir = dataDir();
    if (!dir)
        return {};
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    }
    catch {
        return {};
    }
}
/** 端点归一化：base（…/v1）或完整端点（…/v1/chat/completions）都接受 */
export function normalizeLlmEndpoint(u) {
    const s = String(u ?? "").trim().replace(/\/+$/, "");
    if (!s)
        return "";
    return /\/chat\/completions$/i.test(s) ? s : `${s}/chat/completions`;
}
/** 生效的 LLM 配置（现读，故设置页改动即时生效） */
export async function llmConf() {
    const cfg = readDiskConfig();
    const url = normalizeLlmEndpoint(env.LLM_BASE_URL || cfg.llmUrl || env.MIMOS_URL || DEFAULT_URL);
    const model = String(env.LLM_MODEL || cfg.llmModel || env.INGEST_MODEL || DEFAULT_MODEL).trim();
    let key = String(env.LLM_API_KEY || env.INGEST_KEY || "");
    let keySource = key ? "env" : "none";
    if (!key && cfg.llmKeyEnc) {
        const plain = await unprotectSecret(cfg.llmKeyEnc);
        if (plain) {
            key = plain;
            keySource = "encrypted";
        }
        else {
            keySource = "undecryptable"; // 换机器/换用户 → 明确暴露，不静默当无密钥用
        }
    }
    return { url, model, key, keySource, source: cfg.llmUrl ? "config.json" : (env.MIMOS_URL ? "env" : "default") };
}
/** 调本地 LLM 提炼一段原文为 0~N 条结构化记忆（JSON 数组）。失败/超时返回空并抛错由上层决定跳过。 */
export async function extractFromSource(original, kind, sourceLabel) {
    const conf = await llmConf();
    if (conf.keySource === "undecryptable")
        throw new Error("LLM 密钥无法解密（密文由其他 Windows 用户/机器加密）：请在设置页重新填写密钥");
    const typeHint = kind === "rule"
        ? "优先抽取可作为「规则/约定」的约束（供所有 AI Agent 复用）。"
        : kind === "memory"
            ? "优先抽取「经验/踩坑/决策」型结论。"
            : "优先抽取「决策 / 踩坑 / 隐藏约定」型结论。";
    const system = `你是记忆提取器（不是摘要器）：从原文中提取【值得跨会话/跨工具复用的工程记忆】，而不是复述过程。\n` +
        `${typeHint}\n` +
        `只提取这四类：\n` +
        `  ① decision  做了什么选择 + 为什么（含被否掉的备选方案）\n` +
        `  ② pitfall   现象 + 根因 + 解法（三者齐全才收；缺根因或解法的不要）\n` +
        `  ③ convention 不写在代码里、但必须遵守的隐藏约定\n` +
        `  ④ experience/rule 可复用的资产：脚本/工具/路径/命令的存在与用法\n` +
        `不提取：过程叙述、计划与待办、讨论中间态、闲聊寒暄、任何 LLM 已通识（如"如何写好代码""审计注意事项"）。\n` +
        `要求：每条 ≤200 字；自包含（脱离上下文他人也可读懂）；含具体数值/路径/命令，拒绝模糊。\n` +
        `情绪信号（★ M10）：若原文含明显情绪——负面（烦/崩溃/搞不定/气死/头大）或纠错（又错了/说多少遍/别这样）或强正向偏好（太好了/就这样）——请给该条目补 valence(-1~1) 与 arousal(0~1) 字段；无情绪信号则省略。\n` +
        `输出 0~3 条，宁缺毋滥；没有合格的条目就输出 [ ]。\n` +
        `只输出 JSON 数组，每个元素形如 {"content":"一句话精炼结论","type":"decision|pitfall|convention|experience|rule","valence":-0.8,"arousal":0.7}。除了 JSON 数组，不要输出任何其它字。`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000); // per-call 超时防挂起
    try {
        const res = await fetch(conf.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(conf.key ? { Authorization: `Bearer ${conf.key}` } : {}),
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: conf.model,
                messages: [
                    { role: "system", content: system },
                    {
                        role: "user",
                        content: `来源：${sourceLabel}\n` + `请对下面原文提炼（原文可超出，仅提炼要点）：\n\n${original.slice(0, 6000)}`,
                    },
                ],
                max_tokens: 700,
                temperature: 0.3,
            }),
        });
        if (!res.ok)
            throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json());
        const text = String(data?.choices?.[0]?.message?.content ?? "");
        return parseItems(text);
    }
    catch (e) {
        throw new Error(`LLM 提炼失败：${e instanceof Error ? e.message : String(e)}`);
    }
    finally {
        clearTimeout(timer);
    }
}
const TYPES = ["experience", "rule", "decision", "pitfall", "convention"];
/** 规范化模型输出的单条条目：content 为空返回 null；type 非法回退 experience；valence/arousal 非法数值丢弃 */
function normalizeItem(x) {
    const c = String(x?.content ?? "").trim();
    if (!c)
        return null;
    const out = { content: c, type: TYPES.includes(x?.type) ? x.type : "experience" };
    const v = Number(x?.valence);
    if (Number.isFinite(v) && v >= -1 && v <= 1)
        out.valence = Math.round(v * 100) / 100;
    const a = Number(x?.arousal);
    if (Number.isFinite(a) && a >= 0 && a <= 1)
        out.arousal = Math.round(a * 100) / 100;
    return out;
}
/** 容错解析模型输出的 JSON（可能带 ```json 围栏或前后噪音），失败回退为单条 experience */
function parseItems(text) {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (m ? m[1] : text).trim();
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            throw new Error("not-array");
        return arr.map(normalizeItem).filter((x) => !!x);
    }
    catch {
        // 容错回退：去掉围栏/前后噪音后再解析（模型可能输出单个对象而非数组）
        const cleaned = stripJsonFence(text);
        if (!cleaned)
            return [];
        try {
            const j = JSON.parse(cleaned);
            if (Array.isArray(j))
                return j.map(normalizeItem).filter((x) => !!x);
            if (j && typeof j === "object") {
                const n = normalizeItem(j);
                return n ? [n] : [];
            }
        }
        catch {
            /* 仍非 JSON，按纯文本回落 */
        }
        return [{ content: cleaned, type: "experience" }];
    }
}
function stripJsonFence(text) {
    return text
        .replace(/```json\s*/gi, "")
        .replace(/```/g, "")
        .replace(/^\s*\[\s*/, "")
        .replace(/\s*\]\s*$/, "")
        .trim();
}
/**
 * 探测 LLM 代理可用性（定时采集的快速门禁）。
 * 背景：定时采集若遇代理离线，会对每个源各跑一次 45s 超时 → 一轮白等几十分钟。
 * 先发一个 max_tokens=1 的极低成本请求，不可用则整轮跳过。
 */
export async function probeLlm(timeoutMs = 5000) {
    const conf = await llmConf();
    return (await probeEndpoint(conf, timeoutMs)).ok;
}

/** 探测任意端点（设置页「测试连接」用）：返回结构化结果而非布尔，便于定位是 URL/密钥/模型哪一步不对 */
export async function probeEndpoint(conf, timeoutMs = 8000) {
    const url = normalizeLlmEndpoint(conf?.url);
    const model = String(conf?.model ?? "").trim();
    if (!url)
        return { ok: false, error: "端点为空" };
    if (!model)
        return { ok: false, error: "模型名为空" };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(conf?.key ? { Authorization: `Bearer ${conf.key}` } : {}),
            },
            signal: ctrl.signal,
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: "ping" }],
                max_tokens: 1,
            }),
        });
        const latencyMs = Date.now() - t0;
        if (res.ok)
            return { ok: true, url, model, latencyMs };
        const body = (await res.text().catch(() => "")).slice(0, 300);
        const hint = res.status === 401 || res.status === 403
            ? "认证失败：检查密钥是否正确/是否填错字段"
            : res.status === 404
                ? "端点不存在：URL 一般应形如 https://host/v1（或 …/v1/chat/completions）"
                : res.status === 429 ? "被限流：稍后重试或换模型" : "";
        return { ok: false, status: res.status, url, model, latencyMs, error: body, hint };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint = /abort/i.test(msg)
            ? `超时（>${timeoutMs}ms）：端点未响应，本地模型冷启动可放宽`
            : /ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg) ? "网络不可达：检查 URL/代理/是否需科学上网" : "";
        return { ok: false, url, model, error: msg, hint };
    }
    finally {
        clearTimeout(t);
    }
}
