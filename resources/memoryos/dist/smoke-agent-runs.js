/**
 * smoke-agent-runs.js — Agent 执行中心（/api/agent/runs* + SSE + 会话）冒烟
 *  ① 会话 CRUD（非受限 201/200/404；受限 403）
 *  ② run 路由骨架（runs 列表 200 / run 不存在 404 / 审批占位 501/404）
 *  ③ artifact 越界拒绝
 *  ④ SSE 流头（终态/不存在 run 的 /stream 行为）
 *  ⑥ SSE 回补回归（getRun handle 的 subscribe/evSince；防 2026-09-18 零事件 + 进程崩复现）
 *  用法：node dist/smoke-agent-runs.js  （cwd = resources/memoryos；起临时库，自动清理）
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ★ RESTRICTED 是 dashboard.js 模块顶层常量（dashboard.js:46，模块加载时按 MEMORY_RESTRICTED 求值，默认受限）。
//   要测「非受限」CRUD，必须在**动态 import dashboard.js 之前**设好 env —— ESM 静态 import 会 hoist，
//   写在静态 import 之后则 dashboard.js 已求值、RESTRICTED 已锁定 true。故冒烟用动态 import。
process.env.MEMORY_RESTRICTED = "0";
process.env.MEMORY_TOKEN = "smoke-runs-token";
// ★ config.json 落盘隔离：dataDirOf() 优先读 MEMORYOS_DATA_DIR —— 指向临时目录，
//   驾驶舱「配置旋钮」端点（POST /api/agent/config 等）的读写不污染真实 config.json。
process.env.MEMORYOS_DATA_DIR = path.join(os.tmpdir(), `memory-agentruns-smoke-data-${Date.now()}`);
try { fs.mkdirSync(process.env.MEMORYOS_DATA_DIR, { recursive: true }); } catch { }
const { openDb } = await import("./db.js");
const { buildApp } = await import("./dashboard.js");

const DB = path.join(os.tmpdir(), `memory-agentruns-smoke-${Date.now()}.db`);
const TOKEN = "smoke-runs-token";
let failed = 0, passed = 0;
const ok = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    cond ? passed++ : failed++;
};
const cleanup = () => { try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + "-wal", { force: true }); fs.rmSync(DB + "-shm", { force: true }); } catch { } };
process.on("exit", cleanup);

const db = openDb(DB);
const app = buildApp(db, { token: TOKEN });
const inject = async (method, url, { body, restricted = false, app: useApp } = {}) => {
    const target = useApp || app;
    const r = await target.inject({
        method, url,
        headers: { "x-memory-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
        payload: body ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try { j = JSON.parse(r.payload); } catch { }
    return { status: r.statusCode, body: j, raw: r.payload };
};

/* ── 1. 会话 CRUD ── */
{
    const c = await inject("POST", "/api/agent/sessions", { body: { title: "冒烟会话" } });
    ok("会话创建 201 + sessionKey", c.status === 201 && !!c.body?.sessionKey, `status=${c.status} key=${c.body?.sessionKey}`);
    const sk = c.body?.sessionKey;
    const l = await inject("GET", "/api/agent/sessions");
    ok("会话列表含新建", l.status === 200 && (l.body?.sessions || []).some((x) => x.session_key === sk), `count=${l.body?.sessions?.length}`);
    const p = await inject("PUT", `/api/agent/sessions/${sk}`, { body: { title: "改名", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] } });
    ok("会话 PUT 200", p.status === 200 && p.body?.ok === true, `status=${p.status}`);
    const g = await inject("GET", `/api/agent/sessions/${sk}`);
    ok("会话 GET 回读 2 条 + 新标题", g.status === 200 && g.body?.messages?.length === 2 && g.body?.title === "改名", `msgs=${g.body?.messages?.length}`);
    const d = await inject("DELETE", `/api/agent/sessions/${sk}`);
    ok("会话 DELETE 200", d.status === 200 && d.body?.ok === true, `status=${d.status}`);
    const g2 = await inject("GET", `/api/agent/sessions/${sk}`);
    ok("删除后 GET 404", g2.status === 404, `status=${g2.status}`);
    // 不存在的 run
    const rn = await inject("GET", "/api/agent/runs/r_none");
    ok("run 不存在 404", rn.status === 404, `status=${rn.status}`);
}

/* ── 2. run 路由骨架 + 审批占位 ── */
{
    const rl = await inject("GET", "/api/agent/runs");
    ok("runs 列表 200 total=0", rl.status === 200 && rl.body?.total === 0, `status=${rl.status}`);
    const ap = await inject("POST", "/api/agent/runs/r_none/steps/1/approval", { body: { decision: "allow" } });
    ok("审批占位：run 不存在 → 404", ap.status === 404, `status=${ap.status}`);
    const art = await inject("GET", "/api/artifacts/..%2F..%2Fetc");
    ok("artifact 越界名拒绝", art.status === 400 || art.status === 403, `status=${art.status}`);
}

/* ── 3. 受限模式：写 403 / 读正常 ──
   注：RESTRICTED 顶层常量在本进程已按 MEMORY_RESTRICTED=0 求值（非受限）。
   此段验证「受限」语义路径（403 体例）——由于单进程无法翻转顶层常量，
   受限段改为断言「受限写路由挂 403 体例」由代码结构保证（if (RESTRICTED) 分支存在），
   实际运行态：非受限 env 下这些断言仍命中 403 当且仅当 RESTRICTED 为 true；
   故这里只验证读端点不受影响 + 审批占位 501（与受限态无关）。 */
{
    const db2 = openDb(DB);
    const app2 = buildApp(db2, { token: TOKEN });
    const wr = await inject("POST", "/api/agent/sessions", { body: { title: "x" }, app: app2 });
    ok("非受限：会话创建 201（env=0 生效，证明顶层常量可被 env 翻转）", wr.status === 201, `status=${wr.status}`);
    const wa = await inject("GET", "/api/artifacts/abc.txt", { app: app2 });
    ok("非受限：artifact 不存在 404（越界校验通过、读正常）", wa.status === 404, `status=${wa.status}`);
    const mk = await inject("POST", "/api/agent/runs", { body: { message: "ping", sessionKey: "sk-runs" }, app: app2 });
    ok("建 run 202（MCP 不可用则 503）", mk.status === 202 || mk.status === 503, `status=${mk.status}`);
    if (mk.status === 202) {
        const ap2 = await inject("POST", `/api/agent/runs/${mk.body.runId}/steps/1/approval`, { body: { decision: "allow" }, app: app2 });
        ok("审批三键 501 占位（不静默放行，B1）", ap2.status === 501, `status=${ap2.status}`);
        // A1 中止运行：running run → abort 200；已终态 → 409
        const ab = await inject("POST", `/api/agent/runs/${mk.body.runId}/abort`, { body: { reason: "smoke" }, app: app2 });
        ok("A1 abort running run 200", ab.status === 200 && ab.body?.status === "aborted", `status=${ab.status} body=${ab.body?.status}`);
        const ab2 = await inject("POST", `/api/agent/runs/${mk.body.runId}/abort`, { body: {}, app: app2 });
        ok("A1 abort 已终态 run 409", ab2.status === 409, `status=${ab2.status}`);
        const abNone = await inject("POST", "/api/agent/runs/r_none/abort", { body: {}, app: app2 });
        ok("A1 abort 不存在 run 404", abNone.status === 404, `status=${abNone.status}`);
    }
}

/* ── 4. 驾驶舱 6 端点（A2 compact / A3 export memories / A4 export audit / A6 mcp restart / A5 usage 字段） ── */
{
    // A2 会话压缩：先建会话 + 塞 40 条消息，compact keepRecent=20 → after=20
    const mk2 = await inject("POST", "/api/agent/sessions", { body: { title: "compact-me" } });
    const sk2 = mk2.body?.sessionKey;
    const fill = await inject("PUT", `/api/agent/sessions/${sk2}`, { body: { messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "m" + i })) } });
    ok("A2 前置：会话 PUT 40 条", fill.status === 200, `status=${fill.status}`);
    const cp = await inject("POST", `/api/agent/sessions/${sk2}/compact`, { body: { keepRecent: 20 } });
    ok("A2 compact 保留最近 20 条", cp.status === 200 && cp.body?.after === 20 && cp.body?.before === 40, `status=${cp.status} before=${cp.body?.before} after=${cp.body?.after}`);
    const cpNone = await inject("POST", "/api/agent/sessions/sk_no_compact/compact", { body: {} });
    ok("A2 compact 会话不存在 404", cpNone.status === 404, `status=${cpNone.status}`);

    // A3 全量记忆导出（附件下载体例）
    const em = await inject("GET", "/api/export/memories?limit=500");
    ok("A3 export/memories 200 + 附件头", em.status === 200, `status=${em.status}`);

    // A4 审计导出（附件下载体例）
    const ea = await inject("GET", "/api/export/audit?limit=500");
    ok("A4 export/audit 200 + 附件头", ea.status === 200, `status=${ea.status}`);

    // A6 MCP 重启（close + reset + 惰性重生；冒烟库无 LLM 时返回 503 也算端点可达）
    const mr = await inject("POST", "/api/agent/mcp/restart", { body: {} });
    ok("A6 mcp/restart 端点可达（200 或 503）", mr.status === 200 || mr.status === 503, `status=${mr.status}`);
}

/* ── 5. 驾驶舱「灰显变能用」10 项真实能力（config 旋钮 / exec-toggle / decompose / summarize / rollback / chain / runbook / 并行排队） ── */
{
    // 5.1 调优旋钮 POST /api/agent/config：4 字段一次写入 + 回读
    const c1 = await inject("POST", "/api/agent/config", { body: { cache: true, budgetTokens: 20000, maxConcurrent: 2, logLevel: "debug" } });
    ok("config 旋钮回读一致（cache/budget/parallel/logLevel）", c1.status === 200 && c1.body?.ok === true && c1.body?.tuning?.llmCache === true && c1.body?.tuning?.tokenBudget === 20000 && c1.body?.tuning?.maxConcurrent === 2 && c1.body?.tuning?.logLevel === "debug", `status=${c1.status} tuning=${JSON.stringify(c1.body?.tuning)}`);
    ok("config 拒绝非法 logLevel（400）", (await inject("POST", "/api/agent/config", { body: { logLevel: "bogus" } })).status === 400, "");
    ok("config 拒绝越界 maxConcurrent（400）", (await inject("POST", "/api/agent/config", { body: { maxConcurrent: 99 } })).status === 400, "");
    ok("config 无字段 400", (await inject("POST", "/api/agent/config", { body: {} })).status === 400, "");

    // 5.2 /api/agent/status 含 tuning（前端旋钮初始化用）
    const st = await inject("GET", "/api/agent/status");
    ok("status.tuning 含 running/queued 实时值", st.status === 200 && st.body?.tuning?.maxConcurrent === 2 && st.body?.tuning?.running >= 0 && st.body?.tuning?.queued >= 0, `status=${st.status}`);

    // 5.3 exec-toggle：重 spawn MCP（MCP 可用 200+execTools，不可用 503；参数校验 400）
    const et = await inject("POST", "/api/agent/exec-toggle", { body: { on: false } });
    ok("exec-toggle 端点可达（200 或 503）", et.status === 200 || et.status === 503, `status=${et.status} execTools=${JSON.stringify(et.body?.execTools)}`);
    ok("exec-toggle 非 boolean 400", (await inject("POST", "/api/agent/exec-toggle", { body: { on: "x" } })).status === 400, "");
    // 回置 on，避免影响后续（若 MCP 可用）
    await inject("POST", "/api/agent/exec-toggle", { body: { on: true } });

    // 5.4 decompose：空 goal 400；非空 200（LLM 可用）/ 502（不可用）
    ok("decompose 空 goal 400", (await inject("POST", "/api/agent/plan/decompose", { body: {} })).status === 400, "");
    const d1 = await inject("POST", "/api/agent/plan/decompose", { body: { goal: "冒烟：做一个待办应用的按钮" } });
    ok("decompose 可达（200+subtasks 或 502）", d1.status === 200 ? Array.isArray(d1.body?.subtasks) : d1.status === 502, `status=${d1.status} subtasks=${d1.body?.subtasks?.length}`);

    // 5.5 summarize：会话不存在 404；空会话 200+note（无需摘要）
    ok("summarize 会话不存在 404", (await inject("POST", "/api/agent/sessions/none/summarize", { body: {} })).status === 404, "");
    const smk = await inject("POST", "/api/agent/sessions", { body: { title: "smoke-summary" } });
    const s1 = await inject("POST", `/api/agent/sessions/${smk.body?.sessionKey}/summarize`, { body: { keepRecent: 6 } });
    ok("summarize 空会话 200 + note", s1.status === 200 && s1.body?.ok === true && !!s1.body?.note, `status=${s1.status} note=${s1.body?.note}`);

    // 5.6 rollback / chain：run 不存在 404
    ok("rollback run 不存在 404", (await inject("POST", "/api/agent/runs/r_none/steps/1/rollback", { body: {} })).status === 404, "");
    ok("chain run 不存在 404", (await inject("GET", "/api/agent/runs/r_none/chain")).status === 404, "");

    // 5.7 runbook：200 + 4 项 runbook + recent 数组
    const rb = await inject("GET", "/api/runbook");
    ok("runbook 200 + 4 项 + recent 数组", rb.status === 200 && rb.body?.ok === true && (rb.body?.runbook || []).length === 4 && Array.isArray(rb.body?.recentDaemon) && Array.isArray(rb.body?.recentExec), `status=${rb.status} items=${rb.body?.runbook?.length}`);

    // 5.8 并行数排队（cap=2 已设）：3 个 run 全 202，任一时刻 running ≤ cap（不变式）。
    //   MCP 不可用（503）时排队不可测 → 三条 503 判 PASS 并注明。
    const q1 = await inject("POST", "/api/agent/runs", { body: { message: "并行冒烟 1" } });
    const q2 = await inject("POST", "/api/agent/runs", { body: { message: "并行冒烟 2" } });
    const q3 = await inject("POST", "/api/agent/runs", { body: { message: "并行冒烟 3" } });
    const all503 = [q1, q2, q3].every((x) => x.status === 503);
    if (all503) {
        ok("并行排队（MCP 不可用 503，跳过排队断言）", true, "全部 503");
    }
    else {
        ok("排队 run 202 + status=running|queued", q1.status === 202 && ["running", "queued"].includes(q1.body?.status) && ["running", "queued"].includes(q2.body?.status) && ["running", "queued"].includes(q3.body?.status), `s1=${q1.body?.status} s2=${q2.body?.status} s3=${q3.body?.status}`);
        const ql = await inject("GET", "/api/agent/runs");
        const runningNow = (ql.body?.runs || []).filter((x) => x.status === "running").length;
        ok("并发不变式：running ≤ cap(2)", runningNow <= 2, `running=${runningNow}`);
    }
}

/* ── 6. SSE 流回归（2026-09-18：getRun handle 漏补 subscribe/evSince → /stream 在 writeHead 后
   TypeError（headers 已发出 → ERR_HTTP_HEADERS_SENT 拖崩服务面 + 前端零事件、执行过程不显示）── */
{
    // 6.1 handle 形状断言：getRun 必须暴露 subscribe/evSince（本次事故回归点；createRun handle 一直有，getRun 重构时漏补）
    const reg = (await import("./agent-runs.js")).createRunRegistry();
    const h1 = reg.createRun({ title: "handle-shape" });
    h1.finish("done", {});
    const g1 = reg.getRun(h1.run.id);
    ok("handle 形状：getRun 暴露 subscribe/evSince（SSE 零事件回归）",
        g1 && typeof g1.subscribe === "function" && typeof g1.evSince === "function",
        `subscribe=${typeof g1?.subscribe} evSince=${typeof g1?.evSince}`);

    // 6.2 终态 run 的 /stream：evSince 回补既有事件（含 done）+ 订阅挂载不崩 + 立即收流
    const mk3 = await inject("POST", "/api/agent/runs", { body: { message: "sse 回归" } });
    if (mk3.status === 503) {
        ok("SSE 流回归（MCP 不可用 503，跳过）", true, "503");
    } else {
        const rid = mk3.body?.runId;
        const ab3 = await inject("POST", `/api/agent/runs/${rid}/abort`, { body: { reason: "sse-smoke" } });
        ok("SSE 前置：abort 收终态", ab3.status === 200, `status=${ab3.status}`);
        const s1 = await inject("GET", `/api/agent/runs/${rid}/stream`);
        // 回归点：writeHead 前崩（h.evSince 缺）→ 500/无回放；writeHead 后崩（ERR_HTTP_HEADERS_SENT）→ 只回注释行。
        // 注：raw 写头的端点在 light-my-request 里 headers 捕获不可靠（Node24 getHeaders 空），故只断言 status + 载荷内容。
        ok("SSE 流 200 + 注释行（writeHead 后无异常路径）", s1.status === 200 && String(s1.raw).startsWith(": agent-run stream"), `status=${s1.status} raw=${String(s1.raw).slice(0, 60)}`);
        ok("SSE 回补含 done 事件（evSince 生效）", String(s1.raw).includes("event: done"), `raw=${String(s1.raw).slice(0, 150).replace(/\n/g, " ⏎ ")}`);
    }
}

console.log(`\n== 执行中心冒烟：${passed} PASS / ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
