/**
 * smoke-agent-parallel.js — 工具调用有界并行池（DSH 参考实现）冒烟
 *  全确定性：假 LLM（本地 http server，2 轮：先 4 个 tool_calls 再收尾）+ 假 MCP（记录并发区间），
 *  不依赖真实 Ollama/网络。验证：
 *   ① L0 只读段并发（2 个 search 重叠）② L1 独占屏障（write 不与任何调用重叠，且打断并行段）
 *   ③ 结果按模型序回填（tool_result 事件序 = 模型序）④ 串行兼容（单调用轮不受池影响）
 *  用法：node dist/smoke-agent-parallel.js
 */
import http from "node:http";
import { runAgent } from "./agent-core.js";

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    cond ? passed++ : failed++;
};

// ── 假 LLM：第 1 轮回 4 个 tool_calls（search a, search b, write c, search d），第 2 轮收尾 ──
const PORT = Number(process.env.FAKE_LLM_PORT ?? 0);
const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(404); return res.end(); }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const msgs = JSON.parse(body || "{}").messages || [];
        const isRound1 = !msgs.some((m) => m.role === "tool");
        if (isRound1) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [
                            { id: "c1", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "a" }) } },
                            { id: "c2", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "b" }) } },
                            { id: "c3", type: "function", function: { name: "memory_write", arguments: JSON.stringify({ content: "c" }) } },
                            { id: "c4", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "d" }) } },
                        ],
                    },
                }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            }));
        }
        else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                choices: [{ message: { content: "done" } }],
                usage: { prompt_tokens: 8, completion_tokens: 2 },
            }));
        }
    });
});
const listenPort = await new Promise((resolve) => {
    server.listen(PORT === 0 ? 0 : PORT, "127.0.0.1", () => resolve(server.address().port));
});

// ── 假 MCP：L0 search 带 150ms 延迟 + 并发区间记录；L1 write 独占同样延迟 ──
const intervals = [];   // {name, q, t0, t1}
let inFlight = 0, maxInFlight = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeMcp = {
    async tools() {
        return [
            { name: "memory_search", description: "⟨risk:L0|gate:auto⟩ 检索", inputSchema: { type: "object" } },
            { name: "memory_write", description: "⟨risk:L1|gate:required⟩ 写入", inputSchema: { type: "object" } },
        ];
    },
    async callTool(name, args) {
        const t0 = Date.now();
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(150);
        inFlight--;
        const t1 = Date.now();
        intervals.push({ name, q: args?.query ?? args?.content, t0, t1 });
        return { text: `${name} ok:${args?.query ?? ""}` };
    },
};

const events = [];
const r = await runAgent({
    llm: { baseUrl: `http://127.0.0.1:${listenPort}/v1`, model: "fake", temperature: 0, maxTokens: 100, timeoutMs: 15000, apiKey: "" },
    mcp: fakeMcp,
    messages: [{ role: "user", content: "start" }],
    maxSteps: 4,
    writeGate: () => true,   // 测试面：放行写（审批交互在真实 run 里由路由提供）
    onStep: (s) => events.push(s.type + (s.tool ? ":" + s.tool : "")),
});

// ① 并行：两个 search 必须重叠（池宽 ≥2）
const overlap = (x, y) => x.t0 < y.t1 && y.t0 < x.t1;
const sA = intervals.find((i) => i.name === "memory_search" && i.q === "a");
const sB = intervals.find((i) => i.name === "memory_search" && i.q === "b");
const wC = intervals.find((i) => i.name === "memory_write");
const sD = intervals.find((i) => i.name === "memory_search" && i.q === "d");
ok("L0 段并发（search a/b 重叠）", sA && sB && overlap(sA, sB), `maxInFlight=${maxInFlight}`);
ok("峰值并发 ≥2", maxInFlight >= 2, `maxInFlight=${maxInFlight}`);
// ② 独占屏障：write 不与任何调用重叠
const disjointAll = (w) => intervals.every((i) => i === w || !overlap(i, w));
ok("L1 独占（write 不与他人重叠）", wC && disjointAll(wC), "write 为屏障");
// ③ 屏障打断并行段：search d 在 write 结束后才跑
ok("write 打断并行段（d 在 c 之后）", sD && wC && sD.t0 >= wC.t1 - 1, `d.t0=${sD?.t0 - sA.t0}ms c.t1=${wC.t0 - sA.t0}ms（相对）`);
// ④ 模型序回填：tool_result 事件序 = c1..c4 的工具序
const resultOrder = events.filter((e) => e.startsWith("tool_result")).map((e) => e.split(":")[1]);
ok("结果按模型序回填", JSON.stringify(resultOrder) === JSON.stringify(["memory_search", "memory_search", "memory_write", "memory_search"]), `order=${resultOrder.join(",")}`);
// ⑤ 串行兼容 + 正常收尾
ok("收尾答案 + 工具计数", r.answer === "done" && r.toolCalls === 4, `answer=${r.answer} toolCalls=${r.toolCalls}`);
ok("usage 累加正确", r.usage?.total === 25, `total=${r.usage?.total}`);

server.close();
await new Promise((res) => server.on("close", res));   // 等 http 句柄完全关闭再退出
console.log(`\n== 并行池冒烟：${passed} PASS / ${failed} FAIL ==`);
// ★ 不用 process.exit()：Windows libuv 在句柄关闭中 process.exit 会触发 UV_HANDLE_CLOSING
//   abort（smoke-agent 同款 flake）——自然退出 + exitCode 语义等价且无竞态。
process.exitCode = failed ? 1 : 0;
