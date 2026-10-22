/**
 * MemoryOS — LLM 流式调用（★ DSH 参考：AssistantStreamAttempt，有界版）
 * OpenAI 兼容 SSE 流式（stream:true）：累积 content + tool_calls delta，
 * 返回契约与 agent-core.callLlm 一致（{ msg, usage }），可与 withLlmRetry 互换。
 *  - content delta：累积进 msg.content，每段调 onDelta(delta)
 *  - tool_calls delta：按 index 累积（id/name 取首个非空、arguments 字符串拼接）
 *  - usage：流尾 chunk 若带 usage 则透传，否则 null（与 callLlm 口径一致）
 * 流式请求不走 LLM 响应缓存（缓存与流式互斥，缓存命中直接回放无增量）。
 * ★ 2026-09-19：本文件曾中途截断（并行会话遗留，语法错误）；已按上述原契约补全
 *   SSE data 解析 / delta 累积 / usage 透传 / 返回 { msg, usage }。
 * ★ 2026-09-23 批次①接线：agent-core.runAgent 的 streamOn 路径（o.stream===true 且未开缓存）
 *   各轮调用本函数；tools 参数与 callLlm 同义（非末轮传工具面，末轮传 null 强制文本收尾）。
 */
export async function callLlmStream(cfg, messages, onDelta, signal, tools = null) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 180000) * 3);
    let content = "";
    const tc = new Map();
    let usage = null;
    const body = { model: cfg.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream: true };
    if (cfg.numCtx) body.options = { num_ctx: cfg.numCtx };
    if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }
    try {
        const res = await fetch(cfg.baseUrl + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}) },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
        });
        if (!res.ok) {
            const errText = String(await res.text()).slice(0, 300);
            throw new Error("LLM HTTP " + res.status + ": " + errText);
        }
        if (!res.body) throw new Error("LLM 流式响应无 body");
        const reader = res.body.getReader();
        const dec = new TextDecoder("utf-8");
        let buf = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                let chunk;
                if (payload === "[DONE]") break;
                try { chunk = JSON.parse(payload); }
                catch { continue; }
                const ch = chunk.choices || [];
                const choice = ch.length ? ch.shift() : {};
                const delta = choice.delta || {};
                if (typeof delta.content === "string" && delta.content) {
                    content += delta.content;
                    if (typeof onDelta === "function") onDelta(delta.content);
                }
                for (const tcd of delta.tool_calls || []) {
                    const idx = Number(tcd.index ?? 0);
                    const cur = tc.get(idx) || { index: idx, id: "", type: "function", function: { name: "", arguments: "" } };
                    if (tcd.id) cur.id = tcd.id;
                    if (tcd.type) cur.type = tcd.type;
                    if (tcd.function && tcd.function.name) cur.function.name = tcd.function.name;
                    if (tcd.function && tcd.function.arguments) cur.function.arguments += tcd.function.arguments;
                    tc.set(idx, cur);
                }
                if (chunk.usage) usage = chunk.usage;
            }
        }
    }
    finally { clearTimeout(timer); }
    const toolCalls = [];
    for (const c of tc.values()) {
        if (!c.function.name) continue; // 不完整的 tool_call（name 未到达）不造假
        toolCalls.push({
            id: c.id || "call_" + c.index,
            type: c.type || "function",
            function: { name: c.function.name, arguments: c.function.arguments },
        });
    }
    const msg = { role: "assistant", content: content || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return { msg, usage };
}
