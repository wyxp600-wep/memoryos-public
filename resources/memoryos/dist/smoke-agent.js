/**
 * smoke-agent.js — MemoryOS Agent 冒烟
 *  ① LLM 端点工具调用直测（qwen3:8b / 任意 OpenAI 兼容，--llm-url/--llm-model 覆盖）
 *  ② MCP 客户端连通 + tools/list（期望工具面由 server --list-tools 派生，不再手抄清单）
 *  ③ 只读 agent 单轮（memory_context 注入，不触发写门禁）
 * 用法：node dist/smoke-agent.js [--llm-url U --llm-model M]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMcpClient, resolveLlm, callLlm, mcpToolsToOpenai, runAgent, buildSystemPrompt } from "./agent-core.js";

const execFileP = promisify(execFile);

const extra = process.argv.slice(2);
function opt(name) {
    const i = extra.indexOf(name);
    return i >= 0 ? extra[i + 1] : undefined;
}
const llm = resolveLlm({
    baseUrl: opt("--llm-url"),
    model: opt("--llm-model"),
    apiKey: opt("--llm-key"),
});
let failed = 0;
const ok = (name, cond, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
    if (!cond) failed++;
};

// ① LLM 工具调用直测
{
    const tools = mcpToolsToOpenai([{
        name: "get_temp",
        description: "查询某城市当前温度（°C）",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }]);
    const t0 = Date.now();
    let msg = null, err = null;
    try {
        const r = await callLlm(llm, [
            { role: "system", content: "你是最小工具调用测试器。用户报城市就调用 get_temp，不要闲聊。" },
            { role: "user", content: "北京现在几度？" },
        ], tools);
        msg = r.msg; // callLlm 现返回 {msg, usage}（A5：透传 token 用量）
    } catch (e) { err = e; }
    const tcs = msg?.tool_calls || [];
    ok("LLM 端点可达", !err, err ? String(err.message).slice(0, 120) : `${(Date.now() - t0) / 1000}s`);
    ok("LLM 发起工具调用", tcs.length === 1 && tcs[0].function.name === "get_temp",
        tcs.length ? `tool_calls=${JSON.stringify(tcs.map((t) => t.function)).slice(0, 120)}` : "content=" + String(msg?.content).slice(0, 80));
    // ② MCP
    const mcp = await createMcpClient({ agentName: "smoke", agentFpath: "dist/smoke-agent.js" });
    try {
        const tools2 = await mcp.tools();
        /* 断言策略（★ 2026-09-19 第 6 次同类修正 = 根治）：**手抄清单必过期** —— 前五次见 git 历史
         *   （F16 写死 17 → "18 或 21" → P2-6 22 工具 → memory_credential/task_gate/task_delegate →
         *   task_verify 落地后 REQUIRED 仍停在 25，实跑 got 26 必 FAIL）。根治：期望清单改由
         *   `node dist/server.js --list-tools` 打印的**实际注册清单**派生（server.js 的 addTool 覆写层
         *   维护 REGISTERED_TOOLS，单一事实源；新增/删减工具只改 server 注册一处，本冒烟零维护）。
         *   断言语义 = 「客户端 tools/list 所见 == server 实际注册」的 wire 层一致性；单个工具的功能
         *   正确性由 smoke-mcp / smoke-macp 逐一调用覆盖，不在本断言职责内。 */
        const listOut = await execFileP(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url)), "--list-tools"], { maxBuffer: 1 << 20 });
        const tm = /##TOOLS##(\[[^\n]*\])/.exec(String(listOut.stdout));
        const expected = tm ? JSON.parse(tm[1]) : [];
        const EXEC = ["file_read", "file_write", "exec_run"];   // P0（默认关闭，需 MEMORYOS_EXEC_ON=1；暴露开关一致性单测）
        const names = tools2.map((t) => t.name);
        const execOn = process.env.MEMORYOS_EXEC_ON === "1";
        const unexpected = names.filter((n) => !expected.includes(n));
        const missing = expected.filter((n) => !names.includes(n));
        ok(`MCP 工具面与 server 注册清单一致（--list-tools 派生，期望 ${expected.length} 个）`,
            expected.length > 0 && names.length === expected.length && missing.length === 0 && unexpected.length === 0,
            `got ${names.length}｜缺失=[${missing.join(", ")}]｜多出=[${unexpected.join(", ")}]${expected.length ? "" : "｜--list-tools 输出解析失败"}`);
        const execNames = EXEC.filter((n) => names.includes(n));
        ok("执行面 3 工具的暴露与开关一致", execOn ? execNames.length === 3 : execNames.length === 0, `实际暴露 ${execNames.length} 个${execNames.length ? `: ${execNames.join(", ")}` : ""}`);
        const tn = await mcp.callTool("task_next", { project: "global", as: "" });
        ok("task_next 只读调用", !tn.isError, String(tn.text).replace(/\s+/g, " ").slice(0, 120));
        // ③ 只读 agent 单轮
        const messages = [
            { role: "system", content: buildSystemPrompt("smoke-agent") },
            { role: "user", content: "调用一次 memory_context(project=global)，然后用三句话告诉我：当前项目最该先记住的一件事是什么？只调用这一个工具。" },
        ];
        let saw = false;
        let r;
        try {
            r = await runAgent({
                llm, mcp, messages, maxSteps: 8,
                onStep: (s) => { if (s.type === "tool_result" && s.tool === "memory_context" && s.ok) saw = true; },
            });
            ok("agent 单轮（memory_context）", saw, "answer: " + r.answer.replace(/\s+/g, " ").slice(0, 150));
        } catch (e) {
            ok("agent 单轮（memory_context）", false, String(e.message).slice(0, 120));
        }
    } finally {
        await mcp.close();
    }
}
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
/* ★ 2026-09-19 修进程崩溃：Windows + Node 24 下紧跟 mcp.close() 的 process.exit 会与
 *   stdio transport 句柄关闭竞态，触发 libuv 断言（win/async.c:76，退出码 0xC0000409 fail-fast），
 *   把一条断言失败放大成整进程崩溃。改设 exitCode 让事件循环自然排空后退出；
 *   2 秒兜底强退（unref 不保活），防个别句柄滞留挂住 smoke-all。 */
process.exitCode = failed ? 1 : 0;
const _forceExit = setTimeout(() => process.exit(process.exitCode), 2000);
if (typeof _forceExit.unref === "function") _forceExit.unref();
