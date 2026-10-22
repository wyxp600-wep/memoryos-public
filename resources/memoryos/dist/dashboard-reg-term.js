/** Orca 融合 P2 · term 域（2026-10-03 CLAIM §5 登记，A 分区）
 * 能力：准终端分屏 —— exec_run 的**流式版**（SSE 逐块回传 stdout/stderr），无 pty。
 * 设计取舍（方案已陈述、用户拍板「要」启动 P2）：
 *  - 排除真 pty（node-pty/xterm 违「零新 npm 依赖」硬约束）；排除 shell:true（["powershell","-Command"]
 *    可绕过白名单 = 没有白名单，exec-tools.js:153-155 注释明写的坑）；
 *  - 与 MCP exec_run **同一白名单口径**：execAllowlist()（npm/git/node，env 可扩）+
 *    resolveInside() cwd 白名单 + spawn(shell:false) argv 数组 + killTree 超时/断连杀树 + logExecAudit。
 *  - ★ 2026-10-14 刻意差异：MCP exec_run 另加「命令形态守卫」execDenyReason()（拦 node -e / npm
 *    exec·install / git -c alias 等单次调用即任意代码的形态）；**本终端不施加该守卫** —— 这里是人
 *    手敲命令、自负其责，与「防被提示注入的 LLM 乱跑 argv」是两个威胁模型。故命令集保持宽松。
 *  - 无管道/重定向（argv 模式固有边界）——「准终端」名副其实，前端输入框旁有文案提示。
 * SSE 约定：event=start/out/err/exit/trunc；data 为 JSON.stringify 字符串（内容可含换行）。
 * 鉴权走全局 onRequest hook（同源 EventSource 自动带 cookie，与 /api/cards/stream 同体例）。
 * 校验一律在 writeHead **之前**返回 400 —— 快照探针（无参 GET 自动发现）因此得到确定性状态码。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execAllowlist, resolveInside, digestArgs } from "./exec-tools.js";
import { logExecAudit } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 工作区口径与 server.js / dashboard-reg-workbench.js 一致：MEMORYOS_WORKSPACE 优先，缺省 = 仓根 */
const WORKSPACE = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(HERE, "..", "..", ".."));

const ARGV_MAX = 32;            // argv 条目上限
const ARG_MAX = 2048;           // 单条参数长度上限
const OUT_FORWARD_CAP = 2 * 1024 * 1024; // 单次运行向前端转发的字节上限（防 DOM/内存爆；超出发 trunc 后停转发，进程继续）
const TIMEOUT_DEFAULT = 300000; // 缺省 5 分钟（交互式命令比 exec_run 的 30s 更长）
const TIMEOUT_MAX = 600000;     // 上限 10 分钟（与 exec_run 同口径）

/** 杀整棵进程树（与 exec-tools.js killTree 同模式：Windows taskkill /T /F，POSIX 进程组） */
function killTree(child) {
    try {
        if (process.platform === "win32") {
            if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref?.();
        }
        else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
    }
    catch { /* 已退出 */ }
}

/** exe 基名归一（去扩展名小写）——与 exec-tools exec_run 同口径 */
const exeBase = (exe) => path.basename(String(exe)).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();

export function registerTerm(app, ctx) {
    const { db, RESTRICTED } = ctx;
    /** runId → {child, done}：kill 端点与断连清理由此表定位 */
    const runs = new Map();

    const audit = (r) => { try { logExecAudit(db, { agent: "dashboard:terminal", ...r }); } catch { /* 审计失败不阻断 */ } };

    /** argv 解析与白名单校验（供 /api/exec/stream 使用；返回 {ok} 或 {status,error}） */
    function parseArgv(queryArgv) {
        let arr;
        try { arr = JSON.parse(String(queryArgv ?? "")); }
        catch { return { status: 400, error: "argv 必须是 JSON 数组字符串，例：[\"git\",\"status\"]" }; }
        if (!Array.isArray(arr) || !arr.length || arr.length > ARGV_MAX)
            return { status: 400, error: `argv 须为 1~${ARGV_MAX} 项的数组` };
        for (const a of arr) {
            if (typeof a !== "string" || !a.trim() || a.length > ARG_MAX || a.includes("\0"))
                return { status: 400, error: "argv 每项须为非空字符串（≤2048 字符，禁 \\0）" };
        }
        const allow = execAllowlist();
        const base = exeBase(arr[0]);
        if (!allow.has(base))
            return { status: 400, error: `命令 ${arr[0]} 不在允许清单内（当前允许：${[...allow].join(", ")}）。如确需，请加入 MEMORYOS_EXEC_ALLOW` };
        return { argv: arr };
    }

    // ── GET /api/exec/stream：SSE 流式执行（校验先行，之后才升级 SSE） ──
    app.get("/api/exec/stream", (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const pv = parseArgv(req.query.argv);
        if (pv.status)
            return reply.code(pv.status).send({ ok: false, error: pv.error });
        const argv = pv.argv;
        let cwd;
        try {
            cwd = resolveInside(WORKSPACE, String(req.query.cwd ?? "."));
            if (!fs.statSync(cwd).isDirectory())
                throw new Error(`cwd 不是目录：${req.query.cwd}`);
        }
        catch (e) {
            return reply.code(400).send({ ok: false, error: `cwd 校验失败：${e.message}` });
        }
        const timeoutMs = Math.min(TIMEOUT_MAX, Math.max(1000, Number(req.query.timeout_ms) || TIMEOUT_DEFAULT));
        const argsDigest = digestArgs({ cmd: argv, cwd: String(req.query.cwd ?? ".") });

        const runId = randomUUID();
        const t0 = Date.now();
        audit({ tool: "exec_stream", risk: "L1", approval: "human-ui", argsDigest, detail: `$ ${argv.join(" ")} (cwd=${cwd}) 启动 ${runId.slice(0, 8)}` });

        // —— 升级 SSE ——
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
        });
        const send = (event, obj) => { try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`); } catch { /* 已断 */ } };
        const ping = setInterval(() => { try { reply.raw.write(": ping\n\n"); } catch { /* 已断 */ } }, 25000);
        // ★ 响应写失败是异步 'error' 事件（try/catch 不生效），不监听会未捕获 → 进程崩；只收流不杀子进程
        reply.raw.on("error", () => clearInterval(ping));
        reply.raw.on("close", () => clearInterval(ping));

        send("start", { runId, argv, cwd, timeoutMs });
        const [exe, ...rest] = argv;
        const child = spawn(exe, rest, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32" });
        const rec = { child, done: false };
        runs.set(runId, rec);

        let forwarded = 0;
        let truncNotified = false;
        const forward = (event, chunk) => {
            if (rec.done) return;
            const s = chunk.toString();
            if (forwarded + s.length > OUT_FORWARD_CAP) {
                if (!truncNotified) {
                    truncNotified = true;
                    send("trunc", { runId, cap: OUT_FORWARD_CAP, note: "输出超过转发上限，后续输出不再回传（进程继续运行）" });
                }
                return;
            }
            forwarded += s.length;
            send(event, { runId, s });
        };
        child.stdout.on("data", (d) => forward("out", d));
        child.stderr.on("data", (d) => forward("err", d));

        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

        const finish = (code, error) => {
            if (rec.done) return;
            rec.done = true;
            runs.delete(runId);
            clearTimeout(timer);
            clearInterval(ping);
            const ms = Date.now() - t0;
            send("exit", { runId, code: timedOut ? null : code, timedOut, ms, error: error ?? null });
            audit({
                tool: "exec_stream", risk: "L1", approval: "human-ui", argsDigest,
                detail: `$ ${argv.join(" ")} exit=${timedOut ? "TIMEOUT" : (error ? "SPAWN_ERROR" : code)} ${ms}ms`,
                durationMs: ms,
            });
            try { reply.raw.end(); } catch { /* 已断 */ }
        };
        child.on("error", (e) => finish(null, String(e?.message ?? e)));
        child.on("close", (code) => finish(code));

        // 客户端断开（关闭抽屉/停止按钮/刷新）→ 立即杀树，绝不留孤儿进程
        req.raw.on("close", () => {
            if (!rec.done) {
                killTree(child);
                // close 事件仍会触发 finish 补发 exit（对已断连接写失败被 send 吞掉）
            }
        });
    });

    // ── POST /api/exec/kill：显式停止（SSE 已断但进程残留时的兜底通道） ──
    app.post("/api/exec/kill", (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const runId = String(req.body?.runId ?? "").trim();
        const rec = runId && runs.get(runId);
        if (!rec)
            return reply.code(404).send({ ok: false, error: "运行不存在或已结束" });
        killTree(rec.child);
        audit({ tool: "exec_stream", risk: "L1", approval: "human-ui", argsDigest: null, detail: `kill ${runId.slice(0, 8)}（显式停止）` });
        return { ok: true, runId };
    });
}
