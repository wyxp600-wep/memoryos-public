import { MEMORY_BODY_GUIDE, MEMORY_BODY_TEMPLATE } from './memory-body.js';
/**
 * MemoryOS — Agent 核心（可复用：CLI agent.js / dashboard agent 端点共用）
 * 职责：
 *  ① 可插拔 LLM 端点（OpenAI 兼容 /chat/completions + tool_calls）——默认本地 Ollama qwen3:8b，
 *     可切任意云端 API（LLM_BASE_URL / LLM_MODEL / LLM_API_KEY，或运行时传入 llm 覆盖）。
 *  ② MCP 客户端：stdio 拉起 dist/server.js（MemoryOS MCP，工具清单以 `--list-tools` 为准），tools/list → OpenAI tools 格式。
 *  ③ Agent 循环：LLM ⇄ 工具；写类工具经 writeGate 门禁（交互确认 / 无头自动）。
 * 纪律：记忆写操作先获同意（writeGate）；绝不写入敏感凭据（系统提示词约束 + 人工 gate 双保险）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { callLlmStream } from "./agent-stream.js";

/* ── 写类工具门禁（修 F1：改为「工具自声明」驱动，不再硬编码名单）──────
 *  风险前缀由 server.js 在注册期注入工具描述（单一真相源 = exec-tools.js 的 TOOL_RISK）：
 *    ⟨risk:L1|gate:required⟩  → 必须过 writeGate
 *    ⟨risk:L0|gate:auto⟩      → 自动放行
 *  未声明风险级的工具由 server.js 注入 fail-closed 前缀（L4/required），故此集合仅用于
 *  **兼容未打前缀的旧 server.js**（升级期回落），不是主判据。                        */
export const LEGACY_WRITE_TOOLS = new Set([
    "memory_write", "memory_feedback", "memory_cite", "memory_work", "memory_evidence",
    "obsidian", "method_apply",
    "task_assign", "task_claim", "task_done", "task_supersede", "task_admin",
]);
/** 解析风险前缀；无前缀返回 null（旧服务端） */
export function parseRiskPrefix(desc) {
    const m = /^⟨risk:(L[0-4])\|gate:(required|auto)⟩/.exec(String(desc ?? ""));
    return m ? { risk: m[1], gate: m[2] === "required" } : null;
}
/** 该工具是否需要过 writeGate。tool = tools/list 里的定义对象 */
export function needsGate(tool) {
    const p = parseRiskPrefix(tool?.description);
    if (p) return p.gate;
    return LEGACY_WRITE_TOOLS.has(tool?.name); // 旧服务端回落
}

/** 组装系统提示词（工具用法约定 + 记忆纪律） */
export function buildSystemPrompt(agentName, extra = "") {
    return [
        `你是 ${agentName}，MemoryOS 共享记忆中心的本地 agent。你通过 MCP 工具读写团队共享记忆库与多 Agent 任务队列。`,
        `工具用法约定：`,
        `1. 会话/关键任务开始：用户指定任务卡时先 memory_context(task_card_id=<稳定卡ID>,project=<scope>,limit=3) 同次读任务简报与定向经验，需全文再 memory_work(action=read,task_card_id,project)。无任务卡则 memory_context(project,focus=<下一步与症状>,keywords=<2至5个明确锚点>,limit=3)。不凭最近会话猜任务；关键词辅助排序试验默认关闭。`,
        `2. 检索用 memory_search（语义+关键词混合，scope 隔离）；命中片段要精确引用/展开时用 memory_read。`,
        `3. 写记忆纪律：${MEMORY_BODY_GUIDE}\n${MEMORY_BODY_TEMPLATE}`,
        `4. 发现记忆已过时/有误 → memory_feedback 标记；落地方案实际采用了某条记忆 → memory_cite 声明。`,
        `5. 任务队列：task_next 查可做集（含依赖拓扑与优先级）；task_claim 领取（pending→in_progress）；完成实质工作后 task_done 附结论；发现跨链路重复任务用 task_supersede 归档到主任务。`,
        `阶段变化保存 memory_work(action=write,task_card_id,session_id,project,expected_version,checkpoint)；checkpoint含goal/acceptance/completed及evidence/pending/blockers/decisions及scope与evidence/next_step/workspace/environment/verified_at。读取检查点不授予认领、部署或重试权限；条件变化先复核，不机械沿用失败路径。`,
        `回答风格：结论先行；引用记忆时带 [#记忆ID]；无工具结果支撑的内容明确标注「（推测）」。`,
        // ★ 2026-09-20：输出契约 —— 前端按 <结论>/<过程> 切分：结论进对话气泡，过程进「执行过程」区。
        //   无过程段可省略；标记外不写正文（解析不到标记时前端按整段结论兜底，不会丢内容）。
        `输出格式约定（必须遵守）：最终答复先写 <结论>…</结论>（面向用户的完整回答，含表格/清单等）；若此前有推理、判断依据或中间过程，写在其后的 <过程>…</过程> 段内。无过程时可省略 <过程> 段。`,
        `节制原则：拿到足够工具结果后立即用文本给出最终答案，不要为调工具而调工具；同一工具同参数不要重复调用。`,
        extra,
    ].filter(Boolean).join("\n");
}

/* ── LLM 端点（可插拔）─────────────────────────────────────────── */
/** 解析 LLM 配置：运行时 llm 覆盖 > 环境变量 > 默认本地 Ollama
 *  兼容本项目既有惯例变量：Electron 壳把设置页配置注入为 MIMOS_URL / INGEST_MODEL / INGEST_KEY
 *  （见 services/core-process.js），其中 MIMOS_URL 是**完整端点**（…/v1/chat/completions），需归一化成 base。 */
export function resolveLlm(llm = {}) {
    const env = process.env;
    const rawUrl = String(llm.baseUrl || env.LLM_BASE_URL || env.MIMOS_URL || "http://127.0.0.1:11434/v1").trim();
    const baseUrl = rawUrl.replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "");
    const model = String(llm.model || env.LLM_MODEL || env.INGEST_MODEL || "qwen3:8b").trim();
    const apiKey = String(llm.apiKey ?? env.LLM_API_KEY ?? env.INGEST_KEY ?? "");
    // Ollama 默认上下文 4096 不够装全量工具 schema + 长对话；对 Ollama 端点注入 options.num_ctx
    const isOllama = /:11434|ollama/i.test(baseUrl);
    const numCtx = Number(llm.numCtx || env.LLM_NUM_CTX || (isOllama ? 8192 : 0));
    return {
        baseUrl,
        model,
        apiKey,
        numCtx,
        temperature: Number(llm.temperature ?? env.LLM_TEMPERATURE ?? 0.3),
        maxTokens: Number(llm.maxTokens ?? env.LLM_MAX_TOKENS ?? 2048),
        timeoutMs: Number(llm.timeoutMs ?? env.LLM_TIMEOUT_MS ?? 180000),
    };
}

/** 调一次 OpenAI 兼容 chat/completions（带 tools）。返回 { msg, usage }。 */
const _llmCache = new Map();   // key → { msg, usage, hits }
const LLM_CACHE_MAX = 64;
/** ★ 驾驶舱「缓存」开关的 LLM 响应缓存（opt-in：callLlm 第 5 参 cacheOn=true 才启用）。
 *  键 = model|baseUrl|messages|工具数 的 sha256（仅作去重键，非密码学用途）；
 *  同历史同工具面的重复 LLM 轮次直接命中，省真实推理（本地 Ollama 尤值）。
 *  进程级 Map，上限 64 条 FIFO 逐出，不落盘；命中后仍走工具循环（缓存只替 LLM 调用本身）。 */
export function llmCacheStats() {
    return { size: _llmCache.size, max: LLM_CACHE_MAX };
}
export function llmCacheClear() { _llmCache.clear(); }
export async function callLlm(cfg, messages, tools, signal, cacheOn = false) {
    if (cacheOn && !signal) {
        // 有外部 AbortSignal 时不走缓存（中断路径要真请求，避免命中中断前的旧应答）
        const key = crypto.createHash("sha256")
            .update(`${cfg.model}|${cfg.baseUrl}|${JSON.stringify(messages)}|${tools?.length || 0}`)
            .digest("hex");
        const hit = _llmCache.get(key);
        if (hit) {
            hit.hits += 1;
            return { msg: hit.msg, usage: hit.usage ?? null, cached: true };
        }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    const body = {
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
    };
    if (tools?.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }
    if (cfg.numCtx) body.options = { num_ctx: cfg.numCtx }; // Ollama 扩展字段；非 Ollama 端点会忽略
    try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        const msg = data?.choices?.[0]?.message;
        if (!msg) throw new Error("LLM 返回空 choices");
        // ★ A5：透传 token 用量（OpenAI 兼容 prompt_tokens/completion_tokens；
        //   Ollama 非流式常无 usage → null，由调用侧估算兜底）。不影响既有 return 契约（msg 仍为主返回）。
        const out = { msg, usage: data?.usage ?? null };
        if (cacheOn && !signal) {
            // 仅缓存成功应答；FIFO 逐出（Map 保序，超上限删最老 key）
            const key = crypto.createHash("sha256")
                .update(`${cfg.model}|${cfg.baseUrl}|${JSON.stringify(messages)}|${tools?.length || 0}`)
                .digest("hex");
            _llmCache.set(key, { msg, usage: data?.usage ?? null, hits: 0 });
            while (_llmCache.size > LLM_CACHE_MAX) {
                const oldest = _llmCache.keys().next().value;
                if (oldest === key) break;
                _llmCache.delete(oldest);
            }
        }
        return out;
    }
    finally { clearTimeout(timer); }
}

/* ── LLM 重试 / 流式 / 注入（★ DSH 参考）──────────────────────────
 * DSH packages/core/agent-loop：瞬时错误可 retry、末轮流式、steer/inject 边界注入。
 * ★ 2026-09-19 事实校准（原注释宣称「本处落地三项」与代码不符）：
 *  - isTransientLlmError / withLlmRetry：✅ 已落地（本文件下方）——瞬时错误（网络/5xx/限流）退避重试，确定性错误立即失败。
 *  - callLlmStream：✅ 已接线（2026-09-23 批次①）——runAgent 的 streamOn 路径各轮流式调用
 *    dist/agent-stream.js 的 callLlmStream；增量经 onStep({type:'answer_delta'}) 上抛，
 *    该轮出现 tool_calls 即补发 reset（试渲文字丢弃，事件契约 answer 不变）；与 LLM 缓存互斥
 *    （缓存命中直接回放、无增量可推 → cacheOn 时自动降级非流式）。
 *  - drainInjections：❌ 未实现——仅为计划项（runAgent 轮边界吸收运行中注入的用户消息，steer-lite），
 *    全仓无任何实现。接线时请同步更新本注释。 */
const TRANSIENT_LLM_RE = /(ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|ECONNABORTED|socket hang up|fetch failed|LLM HTTP 5\d\d|LLM HTTP 429|overloaded|rate.?limit|too many requests|timed? ?out)/i;
/** 瞬时错误（网络/5xx/429/限流/超时）判定——可重试；4xx 确定性错误（401/404/400）立即失败 */
export function isTransientLlmError(e) {
    return TRANSIENT_LLM_RE.test(e instanceof Error ? e.message : String(e));
}
/** LLM 调用瞬时错误退避重试（线性 1.5s/3s/…；abort 中不重试；retries=0 关闭） */
export async function withLlmRetry(fn, retries = 2, signal, label = "LLM") {
    let attempt = 0;
    for (;;) {
        try {
            return await fn();
        }
        catch (e) {
            attempt += 1;
            if (signal?.aborted || !isTransientLlmError(e) || attempt > retries)
                throw e;
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
}
/** ★ P3-perf：嵌入侧车 env 面 —— 宿主进程同时提供 MEMORY_PORT+MEMORY_TOKEN（壳注入的两个变量）时，
 *  agent 子进程不再各载 560MB BGE-M3，改共享 dashboard 常驻的 /v1/embeddings（Bearer=MEMORY_TOKEN）；
 *  缺一即回落旧默认（EMBED_MODE 未设→local），零回归。令牌只走进程 env 传递，不写入任何配置文件（隐私红线）。 */
export function agentEmbedEnv() {
    if (process.env.MEMORY_PORT && process.env.MEMORY_TOKEN) {
        return {
            EMBED_MODE: "api",
            EMBED_API_URL: "http://127.0.0.1:" + process.env.MEMORY_PORT + "/v1/embeddings",
            EMBED_API_KEY: process.env.MEMORY_TOKEN,
        };
    }
    return { EMBED_MODE: process.env.EMBED_MODE || "local" };
}
/* ── MCP 客户端（stdio 拉起 server.js）─────────────────────────── */
export async function createMcpClient({ serverPath, agentName, agentFpath, cwd, env } = {}) {
    const server = serverPath || fileURLToPath(new URL("./server.js", import.meta.url));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [server],
        cwd: cwd || undefined,
        env: {
            ...process.env,
            MEMORY_AGENT: agentName || "unknown",
            ...(agentFpath ? { MEMORY_AGENT_FPATH: agentFpath } : {}),
            ...agentEmbedEnv(),
            ...(env || {}), // 显式 env 参数优先级最高（测试可强制 EMBED_MODE=fake）
        },
        stderr: "pipe",
    });
    const client = new Client({ name: "memoryos-agent", version: "1.0.0" });
    await client.connect(transport);
    return {
        client,
        transport,
        async tools() {
            const r = await client.listTools();
            return r.tools;
        },
        async callTool(name, args) {
            const r = await client.callTool({ name, arguments: args || {} });
            const text = (r.content ?? [])
                .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                .join("\n");
            if (r.isError) return { text: `⚠ ${text}`, isError: true };
            return { text };
        },
        async close() {
            try { await client.close(); } catch { /* 已断 */ }
        },
    };
}

/** MCP 工具（JSON Schema inputSchema）→ OpenAI tools 格式
 *  修 F2：除 properties/required/description 外，**透传其余顶层关键字**
 *  （additionalProperties / $defs / oneOf / anyOf 等），避免复杂 schema 降级；
 *  仅剔除 $schema（OpenAI 兼容端不需要，部分端会因它报错）。 */
export function mcpToolsToOpenai(mcpTools) {
    return mcpTools.map((t) => {
        const schema = t.inputSchema || { type: "object", properties: {} };
        const { $schema, ...rest } = schema;
        const parameters = { ...rest, type: "object", properties: rest.properties || {} };
        return {
            type: "function",
            function: {
                name: t.name,
                description: String(t.description ?? "").slice(0, 500),
                parameters,
            },
        };
    });
}

/* ── Agent 循环 ───────────────────────────────────────────────── */
const TOOL_RESULT_BUDGET = 3000; // 工具结果预算（护本地小模型上下文）
const TRUNC_HEAD = 1200;         // 截断时保留的头部字符数
const TRUNC_TAIL = 1500;         // 截断时保留的尾部字符数（★ 修 F3：错误信息在尾部，绝不能只留头部）
const MAX_SAME_CALL = 2;      // 同工具同参数最多真跑几次；超出的重复不再执行（弱模型常见死循环）

/** 修 F3：超预算时保留「头 + 尾 + 中间省略标记」，避免丢掉尾部的报错与栈信息 */
export function truncateToolResult(text) {
    const s = String(text ?? "");
    if (s.length <= TOOL_RESULT_BUDGET) return s;
    const head = s.slice(0, TRUNC_HEAD);
    const tail = s.slice(-TRUNC_TAIL);
    return `${head}\n\n…（中间省略 ${s.length - TRUNC_HEAD - TRUNC_TAIL} 字，原长 ${s.length} 字；完整输出见工具返回的 artifact 路径或调小 limit）…\n\n${tail}`;
}

/** 修 F17：toolsFilter 语义反转 + 静默失败。
 *  undefined = 全量；[] = 明确零工具；含未知名 = 抛错；过滤后为空 = 抛错。
 *  原实现 `o.toolsFilter?.length ? filter : allTools` 会让 [] 回落成全量（想收窄权限反而全暴露），
 *  且名字拼错时静默退化成"不给模型任何工具"（模型不再调工具且无任何报错）。 */
export function pickTools(allTools, filter) {
    if (filter === undefined || filter === null) return allTools;
    if (!Array.isArray(filter)) throw new Error(`toolsFilter 必须是数组（收到 ${typeof filter}）`);
    if (filter.length === 0) return [];
    const known = new Set(allTools.map((t) => t.function.name));
    const unknown = filter.filter((n) => !known.has(n));
    if (unknown.length) throw new Error(`toolsFilter 含未知工具：${unknown.join(", ")}（可用：${[...known].join(", ")}）`);
    const picked = allTools.filter((t) => filter.includes(t.function.name));
    if (!picked.length) throw new Error(`toolsFilter 过滤后为空（${filter.join(", ")}）`);
    return picked;
}

/**
 * 跑一轮 agent（用户消息已置于 messages 末尾）。
 * @param {object} o
 * @param {object} o.llm        resolveLlm() 结果
 * @param {object} o.mcp       createMcpClient() 结果
 * @param {Array}  o.messages  对话（会被原地追加；调用方负责 system/user 起步）
 * @param {number} [o.maxSteps] 最大 LLM 轮次（默认 12）
 * @param {fn}    [o.onStep]   进度回调 {type:'llm'|'answer_delta'|'tool_call'|'tool_result'|'tool_repeat'|'answer'|'write_denied'|'max_steps', ...}
 *                   answer_delta：流式文字增量 {delta} 或试渲丢弃指令 {reset:true}（★ 批次①）
 * @param {fn}    [o.writeGate] (toolName, args) → Promise<boolean>；写类工具门禁。默认交互式 y/N 由 CLI 提供；无头默认全拒。
 * @param {string[]} [o.toolsFilter] 只暴露这些工具（最小权限：如收尾阶段只给 task_done）
 * @param {AbortSignal} [o.signal]
 * @param {boolean} [o.cache]   LLM 响应缓存开关（★ 驾驶舱「缓存」；同历史轮次命中省真实推理）
 * @param {number}  [o.budgetTokens] token 预算上限（★ 驾驶舱「预算上限」；usage.total 超过即中止本 run）
 * @param {number}  [o.maxParallelToolCalls] 同轮并行安全工具的最大并发数（1..8，默认 4；
 *                   参考 DSH agent-loop 有界并行池——L0 只读工具并发，L1+ 独占屏障）
 * @returns {Promise<{answer: string, steps: number, toolCalls: number, usage: object|null, cache: {hits:number}|null}>}
 */
export async function runAgent(o) {
    const { llm, mcp, messages, signal } = o;
    const maxSteps = o.maxSteps ?? 12;
    const onStep = o.onStep || (() => {});
    // 未提供门禁 = 一律拒绝（fail-closed）——B1「写操作先获同意」的循环级兜底，杜绝静默放行
    const writeGate = typeof o.writeGate === "function" ? o.writeGate : () => false;
    const cacheOn = o.cache === true;
    const budgetTokens = Number(o.budgetTokens) > 0 ? Number(o.budgetTokens) : 0;
    let cacheHits = 0;   // ★ 驾驶舱「缓存」命中计数（随 answer 事件回报）
    // ★ DSH 参考三项（均有界/opt-in，默认不改变既有行为）：
    const retryN = o.retry ?? 2;                       // 瞬时 LLM 错误重试次数（0=关闭）
    const streamOn = o.stream === true;                 // 各轮流式（answer_delta 增量；★ 批次① 已接线）
    const useStream = streamOn && !cacheOn;             // ★ 与缓存互斥：缓存开启 → 降级非流式（回放无增量）
    const rawTools = await mcp.tools();
    const gateByName = new Map(rawTools.map((t) => [t.name, needsGate(t)]));
    // ★ DSH 参考（tool-calls.ts 有界并行池）：并行安全判定用工具自声明风险级——
    //   L0 只读且 gate:auto = 可并行；L1+（写/执行）或未知前缀 = 独占屏障（fail-safe 串行）。
    const riskByName = new Map(rawTools.map((t) => [t.name, parseRiskPrefix(t?.description)?.risk ?? null]));
    const parallelSafe = (name) => riskByName.get(name) === "L0" && gateByName.get(name) === false;
    const POOL = Math.max(1, Math.min(8, Number(o.maxParallelToolCalls) || 4));  // 并行池宽（1..8，默认 4）
    const allTools = mcpToolsToOpenai(rawTools);
    const tools = pickTools(allTools, o.toolsFilter);
    onStep({ type: "tool_face", exposed: tools.map((t) => t.function.name), total: allTools.length });
    const seen = new Map(); // 调用签名 → 次数（死循环护栏）
    let steps = 0;
    let toolCalls = 0;
    let usage = null;   // ★ A5：token 用量累加（prompt/completion）
    for (;;) {
        if (signal?.aborted) throw new Error("aborted");
        // 末轮：不再给工具，强制模型基于已有结果出文本收尾（弱模型常无限调工具不收口）
        const last = steps + 1 >= maxSteps;
        const roundTools = last ? [] : tools;
        let r;
        if (useStream) {
            // ★ 批次①：每轮流式。文字增量以 answer_delta 推给呈现层；若本轮以 tool_calls 收尾，
            //   已推文字只是「模型先说后调」的试渲 → 补发 reset 让呈现层丢弃，避免与工具卡错序。
            r = await callLlmStream(llm, messages, (delta) => onStep({ type: "answer_delta", delta }), signal, roundTools);
            if (r.msg && Array.isArray(r.msg.tool_calls) && r.msg.tool_calls.length)
                onStep({ type: "answer_delta", reset: true });
        }
        else {
            r = await callLlm(llm, messages, roundTools, signal, cacheOn);
        }
        const msg = r.msg, u = r.usage;
        if (r.cached) cacheHits += 1;
        if (u) {
            usage = {
                prompt: (usage?.prompt || 0) + (u.prompt_tokens ?? 0),
                completion: (usage?.completion || 0) + (u.completion_tokens ?? 0),
            };
            usage.total = usage.prompt + usage.completion;
        }
        // ★ 驾驶舱「预算上限」：usage 累计超预算即中止（错误信息明示，前端时间线可见原因）
        if (budgetTokens && usage?.total > budgetTokens) {
            onStep({ type: "budget_exceeded", total: usage.total, budget: budgetTokens });
            throw new Error(`token 预算上限已触发（已用 ${usage.total} > 上限 ${budgetTokens}），本次 run 中止`);
        }
        steps++;
        const tcs = last ? [] : (msg.tool_calls || []);
        if (!tcs.length) {
            const answer = String(msg.content ?? "").trim() || "（模型未返回内容）";
            if (last) onStep({ type: "max_steps", note: `达到最大步数 ${maxSteps}，已强制收尾` });
            messages.push({ role: "assistant", content: answer });
            // ★ A5：估算兜底（usage 缺失时按消息体 chars/4 粗估 token）
            const estimatedTokens = usage ? null : Math.ceil(JSON.stringify(messages).length / 4);
            const cache = cacheOn ? { enabled: true, hits: cacheHits } : { enabled: false, hits: 0 };
            onStep({ type: "answer", answer, usage, estimatedTokens, cache });
            return { answer, steps, toolCalls, usage, estimatedTokens, cache };
        }
        messages.push({ role: "assistant", content: msg.content || null, tool_calls: tcs });
        let allRepeats = true; // 本轮是否全是重复调用
        /* ★ 工具调用调度（★ 参考 DSH packages/core/agent-loop/src/tool-calls.ts 的有界并行池）：
         *  ① 前置门禁按模型序逐个执行（死循环护栏 + writeGate 审批——审批是交互式的，必须串行）；
         *  ② 分发：连续的并行安全调用（L0 只读 + gate:auto）进宽度 POOL 的有界池并发跑；
         *     独占调用（L1+ 写/执行 或 未知前缀 fail-safe）单独作为屏障跑；
         *  ③ 结果按模型序回填 context（tool_call_id 对齐 OpenAI tools 契约；事件契约不变，
         *     tool_result 从「完成序」变为「模型序」批量——UI 时间线语义不变）。 */
        const modelOrder = [];   // 与 tcs 对齐的处置槽：{kind:'repeat'|'denied'|'ready', ...}
        for (const tc of tcs) {
            const name = tc.function?.name;
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || "{}"); }
            catch { /* 弱模型偶发坏 JSON：传空参让工具报错，LLM 下一轮自纠 */ }
            // 死循环护栏：同工具同参数第 3 次起不再执行，改为回灌提醒
            const sig = `${name}|${JSON.stringify(args)}`;
            const n = (seen.get(sig) || 0) + 1;
            seen.set(sig, n);
            if (n > MAX_SAME_CALL) {
                onStep({ type: "tool_repeat", tool: name, count: n });
                modelOrder.push({ kind: "repeat", tc, repeatMsg: `⚠ 你已用相同参数调用 ${name} ${n - 1} 次，结果不会变化。停止重复调用，直接基于已有结果给出最终答案。` });
                continue;
            }
            allRepeats = false;
            // 写门禁：判定改由「工具自声明风险级」驱动（修 F1）；gateByName 取不到 → 按需审批（fail-closed）。
            // 未提供 writeGate 时上面已兜底为「一律拒绝」，故此处不存在静默放行路径（修 F7 的循环级兜底）。
            if (gateByName.get(name) !== false) {
                let ok = false;
                try { ok = !!(await writeGate(name, args)); }
                catch { ok = false; }
                if (!ok) {
                    onStep({ type: "write_denied", tool: name, args });
                    modelOrder.push({ kind: "denied", tc, deniedMsg: "⚠ 该操作未获同意（被拒绝或无审批通道）。不要重试，基于已有信息完成回答，或改为只读方式继续。" });
                    continue;
                }
            }
            onStep({ type: "tool_call", tool: name, args });
            toolCalls++;
            modelOrder.push({ kind: "ready", tc, name, args });
        }
        // ② 分发：有界并行池（并行安全段）+ 独占屏障（其余 ready）
        const dispatchOne = async (slot) => {
            let res;
            try {
                res = await mcp.callTool(slot.name, slot.args);
            }
            catch (e) {
                res = { text: `⚠ ${slot.name} 调用失败：${e instanceof Error ? e.message : String(e)}`, isError: true };
            }
            slot.result = { text: res.text, ok: !res.isError };
        };
        const runPool = async (group) => {
            let next = 0;
            const n = Math.min(POOL, group.length);
            await Promise.all(Array.from({ length: n }, async () => {
                for (;;) {
                    const idx = next++;
                    if (idx >= group.length) return;
                    await dispatchOne(group[idx]);
                }
            }));
        };
        let mi = 0;
        while (mi < modelOrder.length) {
            const s = modelOrder[mi];
            if (s.kind === "ready" && parallelSafe(s.name)) {
                // 连续并行安全段：进有界池并发
                const group = [];
                let mj = mi;
                while (mj < modelOrder.length && modelOrder[mj].kind === "ready" && parallelSafe(modelOrder[mj].name)) {
                    group.push(modelOrder[mj]);
                    mj++;
                }
                await runPool(group);
                mi = mj;
            }
            else if (s.kind === "ready") {
                await dispatchOne(s);   // 独占（写/执行/未知）：单独跑，前后不并行
                mi++;
            }
            else mi++;   // repeat/denied：无需分发
        }
        // ③ 结果按模型序回填（repeat/denied 回灌合成消息；ready 回灌工具结果）
        for (const s of modelOrder) {
            if (s.kind === "repeat") {
                messages.push({ role: "tool", tool_call_id: s.tc.id, content: s.repeatMsg });
            }
            else if (s.kind === "denied") {
                messages.push({ role: "tool", tool_call_id: s.tc.id, content: s.deniedMsg });
            }
            else {
                onStep({ type: "tool_result", tool: s.name, ok: s.result.ok, result: s.result.text.slice(0, 500) });
                messages.push({ role: "tool", tool_call_id: s.tc.id, content: truncateToolResult(s.result.text) }); // 修 F3：头尾双端保留
            }
        }
        // 整轮都在重复 → 直接把下一轮变成末轮（无工具）逼出文本答案，避免空转到 maxSteps
        if (allRepeats) {
            onStep({ type: "tool_repeat", tool: "(整轮重复)", count: 0, note: "强制进入收尾轮" });
            messages.push({ role: "user", content: "你刚才的调用全部与之前重复。现在不要再调用任何工具，直接用文本给出最终答案。" });
            steps = Math.max(steps, maxSteps - 1);
        }
    }
}
