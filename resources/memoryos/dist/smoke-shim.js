#!/usr/bin/env node
import { bodyFixture } from "./memory-body-fixture.js";
/**
 * MemoryOS — ★ 2026-10-14 架构重构 1b 验收探针：**direct 模式 vs shim 模式逐字节一致**
 *
 * 为什么需要它：1b 的核心承诺是「shim 模式下 MCP 客户端可见输出与 direct 模式**逐字节**一致」——
 *   任何一处包装口径错位（核心侧多包一层 content / shim 侧少传 schema 默认值）都会让客户端看到
 *   不同文案或不同结构，而这不是靠读代码能证明的，必须**真跑两条路、比对原始响应行**。
 *
 * 覆盖（默认）：
 *   ① `--list-tools` 两种模式输出逐字节一致（并断言 25 项；2026-10-19 整合后口径）；
 *   ② 隔离核心（dashboard，独立 tmp 库 / tmp dataDir / 独立端口）起得来；
 *   ③ core.json 端口发现可用（shim **不设 MEMORY_PORT**，只能从 core.json 发现）+ pid 未陈旧校验；
 *   ④ 同一调用序列下，tools/list + tool_guide + memory_search + memory_write（**不传 type**，
 *      验证 schema 默认值填充）的**原始 JSON-RPC 响应行逐字节一致**；
 *   ⑤ 半截（截断）config.json 时 shim 启动按 direct 处理且不崩（exit 0 + warn + DB 被打开）。
 *   ⑦ 缺口 A：核心 exec=OFF + shim 进程 env 故意 MEMORYOS_EXEC_ON=1 → shim 工具面**不**暴露执行面
 *      （即工具面跟随核心，而非本地 env）；并给出两侧工具数。
 *   ⑧ 缺口 B：核心消费 x-memory-cwd —— shim 从「另一个 cwd」发相对路径 file_read，与 direct 客户端
 *      同 cwd 的返回**一致**（相对路径基准 = 调用方 cwd）；贴出实际返回与两侧 cwd。
 * 追加（`MEMORYOS_SHIM_SMOKE_CANCEL=1`，较慢）：
 *   ⑥ 取消语义：客户端取消/stdio 关闭 → shim abort → 核心请求中断 → **子进程树被杀**（不留孤儿）。
 *
 * 追加（★ 本批：MCP shim `notifications/cancelled` 精准取消）：
 *   ⑩ 用一个**稳定的在途转发**（shim 预热后杀掉核心 → 调用进入 ≤8s 重试）验证：对**不匹配的 id** 发取消
 *      → 在途调用不受影响（按 id 精确路由、非一刀切）；对**真实 id**（不带 `_meta.requestId`）发取消
 *      → shim 立即中止该次转发并回结构化「已被客户端取消」文案；并如实记录 number 形态 id 下 SDK 丢弃响应。
 *      注：⑩ 的「并行两条 exec_run 只取消一条」在本环境**未能证到**（SKIP 附证据）。该 SKIP 的理由
 *      （"核心对并发的在途请求会一并 abort"）**记录于修 ⑪ 之前**：当时核心自身会在 ~250–530ms 误 abort
 *      每次 /ops 请求（`req.raw` 的 'close' 语义），故并发观察被污染 ⇒ 修 ⑪ 后**该 SKIP 结论待重新构造复核**。
 *   ⑪ 核心侧 /ops 长耗时调用不得被误 abort（回归 Node ≥16 的 IncomingMessage 'close' 语义）：
 *      子进程 1.5s 后仍存活且调用正常返回（修前 ~250–530ms 即被杀、长耗时工具经 /ops 跑不完）。
 *
 * 追加（★ 2026-10-14 架构重构 1c：跨进程缓存失效「向量代数」）：
 *   ⑭ 写点自证 —— 池相关写（新增/改写正文/状态流转）必须让 `vec_gen` 逐次 +1（触发器不漏点），
 *      并与廉价探针比对；
 *   ⑮ 回血写不误伤 —— 只写 hit_count/last_hit_at/last_seen_at → `vec_gen` 增量必须为 0
 *      （另做「仅写 confidence/eff_confidence」的反向对照）；
 *   ③ 跨进程即时可见（判别性）—— 核心**预热后**由另一个**进程**直接写库（内容与查询词零词法交集、
 *      向量取查询词的 fake 向量）→ 首次查询即命中 + 核心 `vecInvalidations` 计数确实增长
 *      （证明是代数检测而非 TTL 兜底）；并起一个**冷缓存**新核心做冷/热一致对照。
 *
 * 用法：cd resources/memoryos && node dist/smoke-shim.js
 * 隔离与清理：全部发生在 mkdtemp 临时目录/临时库内；退出即停全部子进程 + 删临时目录，绝不碰生产库。
 * 环境缺失（核心起不来）**记 SKIP 而非 FAIL**（与 smoke-all / smoke-local 同约定：环境问题不等于代码回归）。
 * 退出码：0 = 全绿或 SKIP / 1 = 有 FAIL。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // …/resources/memoryos/dist
const KERNEL = path.resolve(HERE, "..");                     // …/resources/memoryos（冒烟约定 cwd）
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-shim-smoke-"));
const NODE = process.execPath;
/** 测试用的**一次性**令牌：本机生成、只经环境变量传递、绝不落盘、绝不打印（非任何真实凭据）。 */
const TOKEN = crypto.randomBytes(16).toString("hex");
const CANCEL = process.env.MEMORYOS_SHIM_SMOKE_CANCEL === "1";

let passed = 0, failed = 0, skipped = 0;
const check = (name, cond, detail = "") => {
    if (cond) { passed++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
};
const skip = (name, detail) => { skipped++; console.log(`SKIP  ${name}${detail ? "  — " + detail : ""}`); };

const procs = new Set();
const exitWaiters = new Map();
const stop = (child) => {
    if (!child) return;
    procs.delete(child);
    try { child.stdin?.destroy(); } catch { /* 已关 */ }
    try { child.kill(); } catch { /* 已退 */ }
};
/** 停全部子进程并**等它们真正退出**（Windows 文件句柄释放有延迟，立即 rm 会失败留下 tmp 目录） */
async function killAllAndWait(ms = 4_000) {
    const kids = [...new Set([...procs, ...[...exitWaiters.keys()].filter((c) => c.exitCode === null && !c.signalCode)])];
    for (const c of kids) stop(c);
    await Promise.race([Promise.all(kids.map((c) => exitWaiters.get(c) ?? Promise.resolve())), sleep(ms)]);
}
/** 清临时目录（带重试；失败只影响测试机整洁度，不影响结论） */
async function removeWs() {
    for (let i = 0; i < 12; i++) {
        try { fs.rmSync(WS, { recursive: true, force: true }); return true; } catch { await sleep(200); }
    }
    console.log(`WARN  临时目录未能删除（进程句柄未释放）：${WS}`);
    return false;
}
process.on("exit", () => { for (const c of [...procs]) stop(c); try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 兜底尽力 */ } });

const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 隔离环境：core.json 落 MEMORYOS_DATA_DIR(=WS)，令牌走 MEMORY_TOKEN（不产生/不读令牌文件）。 */
function baseEnv(extra = {}) {
    const e = {
        ...process.env,
        MEMORYOS_DATA_DIR: WS,
        MEMORY_TOKEN: TOKEN,
        MEMORY_AGENT: "trae",
        MEMORY_AGENT_FPATH: path.join(WS, "agent-fpath.txt"),
        EMBED_MODE: "fake",            // 隔离实例只用假向量（不加载模型）
        MEMORYOS_EXEC_ON: "",          // 显式关闭执行面 → 工具面确定 25 项（2026-10-19 整合后）
        MEMORYOS_EXEC_OFF: "",
        MEMORYOS_WORKSPACE: WS,
        ...extra,
    };
    return e;
}
/** 起一个子进程并登记（退出时统一收）。cwd 缺省 KERNEL（冒烟约定）；缺口 B 需以调用方 cwd 起 shim 时显式传入。 */
function start(args, env, tag, cwd = KERNEL) {
    const child = spawn(NODE, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdoutBuf = "";
    child.stderrBuf = "";
    child.on("error", () => { /* 起不来由上层按超时处理 */ });
    for (const [out, key] of [[child.stdout, "stdoutBuf"], [child.stderr, "stderrBuf"]])
        out.on("data", (d) => { child[key] += d.toString(); });
    child.tag = tag ?? path.basename(args[0]);
    procs.add(child);
    exitWaiters.set(child, new Promise((resolve) => child.once("exit", resolve)));
    return child;
}
/** 极简 MCP stdio JSON-RPC 客户端：send 返回 `{msg, line}`（line = 原始响应行，用于逐字节比对）。
 *  onAny(msg) 可选：每条入站消息都回调一次（用于「⑩ 取消后客户端侧响应形态」的取证）。 */
function mcpClient(child, onAny) {
    let buf = "";
    let lastId = 0;
    const pending = new Map();
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (onAny) onAny(msg);
            if (msg.id && pending.has(msg.id)) {
                const r = pending.get(msg.id);
                pending.delete(msg.id);
                r({ msg, line });
            }
        }
    });
    /** 发一条请求；回传本次使用的 JSON-RPC `id`（供「按真实 id 发取消」的测试用）。 */
    const sendTracked = (method, params) => {
        const id = ++lastId;
        const promise = new Promise((resolve, reject) => {
            pending.set(id, resolve);
            setTimeout(() => { if (pending.delete(id)) reject(new Error(`MCP 调用无响应：${method}`)); }, 60_000);
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
        return { id, promise };
    };
    return {
        send(method, params) { return sendTracked(method, params).promise; },
        sendTracked,
        /** 发一条**通知**（无 id、无响应）——如 `notifications/cancelled`。 */
        notify(method, params) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        },
    };
}
async function waitForHealth(port, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-memory-token": TOKEN } });
            if (r.ok) return await r.json();
        }
        catch { /* 未就绪 */ }
        await sleep(300);
    }
    return null;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** 跑一条完整调用序列（direct 或 shim 同一个客户端实现），返回每步的**原始响应行**。 */
async function runSequence(child) {
    const c = mcpClient(child);
    await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const out = {};
    out.toolsList = (await c.send("tools/list", {})).line;                                             // ① 整个 tools/list JSON
    out.guideProbe = (await c.send("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } })).line; // ② 裸值类工具
    out.memorySearch = (await c.send("tools/call", { name: "memory_search", arguments: { query: "记忆", project: "global" } })).line; // ③ 复杂类（带 project）
    out.memoryWrite = (await c.send("tools/call", { name: "memory_write", arguments: { content: bodyFixture("shim 逐字节一致性探针样本"), project: "shim-smoke" } })).line; // ④ 写类且**不传 type**（验 schema 默认值）
    return out;
}

/** 取 [##TOOLS##] 之后的一行（--list-tools 输出）。 */
function toolListLine(buf) {
    const m = String(buf).match(/##TOOLS##(\[.*\])/);
    return m ? m[1] : "";
}

let coreHooked = null;
try {
    fs.writeFileSync(path.join(WS, "agent-fpath.txt"), "shim-smoke\n", "utf8");
    const P_CORE = await freePort();

    /* ── ② 起隔离核心（dashboard）────────────────────────── */
    const coreEnv = baseEnv({ MEMORY_DB: path.join(WS, "core.db"), MEMORY_PORT: String(P_CORE) });
    const core = start([path.join(HERE, "dashboard.js")], coreEnv, "core");
    coreHooked = await waitForHealth(P_CORE);
    if (!coreHooked) {
        skip("隔离核心（dashboard）起不来", `端口 ${P_CORE} 30s 内未就绪（环境问题，按 SKIP 记）；stderr 末尾：${core.stderrBuf.trim().split("\n").slice(-2).join(" / ")}`);
        console.log(`\n== shim 冒烟：0 PASS / 0 FAIL / ${skipped} SKIP（环境缺失按既有约定记 SKIP）==`);
        await killAllAndWait();
        await removeWs();
        process.exit(0);
    }
    check("② 隔离核心就绪（/health 200）", coreHooked.ok === true, `port=${P_CORE} pid=${coreHooked.pid}`);

    /* ── ③ core.json 端口发现（含 pid 校验）──────────────── */
    const cj = path.join(WS, "core.json");
    let coreJsonOk = false;
    try {
        const o = JSON.parse(fs.readFileSync(cj, "utf8"));
        coreJsonOk = Number(o.port) === P_CORE && Number(o.pid) === coreHooked.pid;
    }
    catch { coreJsonOk = false; }
    check("③ core.json 端口发现可用（port/pid 与核心一致）", coreJsonOk, cj);

    /* ── ① --list-tools 两模式逐字节一致（25 项）─────────── */
    const listDirect = spawn(NODE, [path.join(HERE, "server.js"), "--list-tools"], { cwd: KERNEL, env: baseEnv({ MEMORY_DB: path.join(WS, "direct.db") }), windowsHide: true });
    const listShim = spawn(NODE, [path.join(HERE, "server.js"), "--list-tools"], { cwd: KERNEL, env: baseEnv({ MEMORY_DB: path.join(WS, "shim-side.db"), MEMORYOS_MCP_MODE: "shim" }), windowsHide: true });
    const waitClose = (c) => new Promise((r) => { let o = ""; c.stdout.on("data", (d) => o += d); c.on("close", (code) => r({ code, o })); });
    const [ld, ls] = await Promise.all([waitClose(listDirect), waitClose(listShim)]);
    const ldLine = toolListLine(ld.o), lsLine = toolListLine(ls.o);
    check("① --list-tools direct 模式 exit=0", ld.code === 0, `exit=${ld.code}`);
    check("① --list-tools shim 模式 exit=0（shim 下该 CLI 路径同样可用，且不需要 DB）", ls.code === 0, `exit=${ls.code}`);
    check("① 两模式工具面逐字节一致（25 项）", !!ldLine && ldLine === lsLine && JSON.parse(ldLine).length === 25, `direct=${JSON.parse(ldLine || "[]").length} 项 / 一致=${ldLine === lsLine}`);

    /* ── ④ 逐字节一致性主验收 ─────────────────────────────── */
    const directSrv = start([path.join(HERE, "server.js")], baseEnv({ MEMORY_DB: path.join(WS, "direct.db") }), "direct");
    const A = await runSequence(directSrv);
    stop(directSrv);
    // shim **不设 MEMORY_PORT** → 只能从 core.json 发现端口（③ 的真实检验）
    const shimEnv = baseEnv({ MEMORY_DB: path.join(WS, "shim-side.db"), MEMORYOS_MCP_MODE: "shim" });
    delete shimEnv.MEMORY_PORT;
    const shimSrv = start([path.join(HERE, "server.js")], shimEnv, "shim");
    const B = await runSequence(shimSrv);
    stop(shimSrv);
    const diffs = [];
    for (const k of Object.keys(A)) {
        if (A[k] === B[k]) continue;
        diffs.push(k);
        console.log(`        │ A(${k}): ${A[k] ?? "(空)"}`);
        console.log(`        │ B(${k}): ${B[k] ?? "(空)"}`);
    }
    check("④ tools/list 整个 JSON 逐字节一致", A.toolsList === B.toolsList, `len=${A.toolsList.length}`);
    check("④ tool_guide（裸值类）逐字节一致", A.guideProbe === B.guideProbe);
    check("④ memory_search（复杂类，带 project）逐字节一致", A.memorySearch === B.memorySearch);
    check("④ memory_write（不传 type → schema 默认值）逐字节一致", A.memoryWrite === B.memoryWrite, String(B.memoryWrite).slice(0, 90));
    check("④ 差异清单为空", diffs.length === 0, diffs.length ? `差异项：${diffs.join(", ")}` : "零差异（4/4 步逐字节相同）");
    check("④ memory_write 确实成功（证明 /ops 的 schema 解析已修）", /已写入记忆|已合并|重复/.test(B.memoryWrite ?? ""), String(B.memoryWrite).slice(0, 90));

    /* ── ⑦ 缺口 A：shim 工具面跟随**核心**启用位（而非 shim 本地 env）──────
     *  隔离核心 exec=OFF；shim 进程 env 故意 MEMORYOS_EXEC_ON=1 → shim 应**不**暴露执行面工具（跟随核心）。 */
    {
        const P_CA = await freePort();
        const coreA = start([path.join(HERE, "dashboard.js")],
            baseEnv({ MEMORY_DB: path.join(WS, "core-a.db"), MEMORY_PORT: String(P_CA), MEMORYOS_EXEC_ON: "0" }), "core-a");
        const hA = await waitForHealth(P_CA);
        if (!hA) {
            skip("⑦ 缺口 A（隔离核心 exec=OFF 起不来）", `端口 ${P_CA} 30s 内未就绪（环境问题，按 SKIP 记）`);
        }
        else {
            let coreToolsN = -1, coreExec = null;
            try {
                const cat = await fetch(`http://127.0.0.1:${P_CA}/ops/catalog`, { headers: { "x-memory-token": TOKEN } }).then((r) => r.json());
                coreToolsN = (cat.tools ?? []).length;
                coreExec = cat.execEnabled === true;
            }
            catch { /* 下方断言会暴露 */ }
            const shimAEnv = baseEnv({ MEMORY_DB: path.join(WS, "shim-a.db"), MEMORYOS_MCP_MODE: "shim", MEMORYOS_EXEC_ON: "1" });
            delete shimAEnv.MEMORY_PORT;   // 只能从 core.json 发现端口（真实检验）
            const shimA = start([path.join(HERE, "server.js")], shimAEnv, "shim-a");
            const mcA = mcpClient(shimA);
            await mcA.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
            shimA.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            const namesA = ((await mcA.send("tools/list", {})).msg?.result?.tools ?? []).map((t) => t.name);
            const execA = namesA.filter((n) => ["file_read", "file_write", "exec_run"].includes(n));
            check("⑦ 核心 exec=OFF → 核心 catalog 报 execEnabled=false", coreExec === false, `coreExec=${coreExec}`);
            check("⑦ 核心 exec=OFF 而 shim 本地 env MEMORYOS_EXEC_ON=1 → shim tools/list **不含**执行面工具（工具面跟随核心）",
                execA.length === 0, `shim 工具数=${namesA.length}，执行面=${execA.join(",") || "无"}`);
            check("⑦ 两侧工具数一致（核心 catalog vs shim tools/list）", coreToolsN === namesA.length,
                `核心 catalog=${coreToolsN} / shim tools/list=${namesA.length}`);
            stop(shimA);
            stop(coreA);
        }
    }

    /* ── ⑧ 缺口 B：核心消费 x-memory-cwd（shim 相对路径基准 = 调用方 cwd）──────
     *  核心 workspace=WSROOT、exec=ON；客户端 cwd=A=WSROOT/client-a。预置两份同内容不同的 probe.txt：
     *    · direct 路径（客户端 workspace=A）→ 读 A/probe.txt（CLIENT-BASE）；
     *    · shim 路径（客户端 cwd=A，核心 workspace=WSROOT）→ 修好后核心用 x-memory-cwd(A) → 读 A/probe.txt（一致）；
     *      未修时核心用自身 workspace(WSROOT) → 读 ROOT-BASE（不一致 → 本断言会 FAIL）。 */
    {
        const P_CB = await freePort();
        const WSROOT = path.join(WS, "b-root");
        const CLIENT = path.join(WSROOT, "client-a");
        fs.mkdirSync(CLIENT, { recursive: true });
        fs.writeFileSync(path.join(WSROOT, "probe.txt"), "ROOT-BASE\n", "utf8");
        fs.writeFileSync(path.join(CLIENT, "probe.txt"), "CLIENT-BASE\n", "utf8");
        const coreB = start([path.join(HERE, "dashboard.js")],
            baseEnv({ MEMORY_DB: path.join(WS, "core-b.db"), MEMORY_PORT: String(P_CB), MEMORYOS_WORKSPACE: WSROOT, MEMORYOS_EXEC_ON: "1" }), "core-b");
        const hB = await waitForHealth(P_CB);
        if (!hB) {
            skip("⑧ 缺口 B（隔离核心 exec=ON 起不来）", `端口 ${P_CB} 30s 内未就绪（环境问题，按 SKIP 记）`);
        }
        else {
            const callFileRead = async (child, pathArg) => {
                const c = mcpClient(child);
                await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
                const r = await c.send("tools/call", { name: "file_read", arguments: { path: pathArg } });
                return (r.msg?.result?.content ?? []).map((x) => x?.text ?? "").join("\n");
            };
            const probeLine = (s) => String(s).split("\n").find((l) => /probe\.txt|ROOT-BASE|CLIENT-BASE/.test(l)) ?? String(s).slice(0, 80);
            // direct 客户端：workspace/cwd=A（口径 = 进程 env 派生的 workspaceRoot）
            const directB = start([path.join(HERE, "server.js")],
                baseEnv({ MEMORY_DB: path.join(WS, "direct-b.db"), MEMORYOS_WORKSPACE: CLIENT, MEMORYOS_EXEC_ON: "1" }), "direct-b", CLIENT);
            const rDirect = await callFileRead(directB, "probe.txt");
            stop(directB);
            // shim 客户端：以 cwd=A 起（header x-memory-cwd=A）→ 核心 workspace=WSROOT（两者不同，正是缺口所在）
            const shimBEnv = baseEnv({ MEMORY_DB: path.join(WS, "shim-b.db"), MEMORYOS_MCP_MODE: "shim", MEMORYOS_EXEC_ON: "1" });
            delete shimBEnv.MEMORY_PORT;
            const shimB = start([path.join(HERE, "server.js")], shimBEnv, "shim-b", CLIENT);
            const rShim = await callFileRead(shimB, "probe.txt");
            stop(shimB);
            check("⑧ direct 客户端（cwd/workspace=A）file_read('probe.txt') 读到 A（CLIENT-BASE）",
                rDirect.includes("CLIENT-BASE"), `direct: ${probeLine(rDirect)}`);
            check("⑧ shim 客户端（cwd=A；核心 workspace=WSROOT）file_read('probe.txt') 同样读到 A（核心消费 x-memory-cwd）",
                rShim.includes("CLIENT-BASE"), `shim: ${probeLine(rShim)}`);
            check("⑧ 两条路返回一致（两侧 cwd=A、核心 workspace=WSROOT）", rDirect === rShim,
                `一致=${rDirect === rShim}；direct=${probeLine(rDirect)} | shim=${probeLine(rShim)}`);
            stop(coreB);
        }
    }

    /* ── ★ 1c（2026-10-14）跨进程缓存失效：⑭ 写点自证 / ⑮ 回血不误伤 / ③ 跨进程即时可见 ──────
     *  全部在本段自己的临时库与临时数据目录内跑（不碰生产库；③ 的核心用独立 MEMORYOS_DATA_DIR，
     *  **不覆写上面各段依赖的 WS/core.json**）。 */
    {
        const dbm = await import("./db.js"); // 进程内直连内核（本段只用 fake 嵌入器，不加载模型）
        const genOf = (db) => Number(db.prepare(`SELECT value FROM config WHERE key='vec_gen'`).get()?.value ?? -1);
        /* 廉价探针：任务指定口径（COUNT/MAX(id)/SUM(version)）+ 扩展项 LENGTH(status)——
         * 指定口径对「只改 status」的写**完全无反应**（实测 1/1/2→1/1/2），故一致性判据取二者之并。 */
        const probeOf = (db) => db.prepare(`SELECT COUNT(*) c, COALESCE(MAX(id),0) m, COALESCE(SUM(version),0) s, COALESCE(SUM(LENGTH(status)),0) t FROM memories`).get();
        const pstr = (r) => `${r.c}/${r.m}/${r.s}/${r.t}`;
        const vdb = dbm.openDb(path.join(WS, "1c-vecgen.db"));
        const steps = [];
        const runStep = (name, fn) => {
            const g0 = genOf(vdb), p0 = probeOf(vdb);
            fn();
            const g1 = genOf(vdb), p1 = probeOf(vdb);
            const r = {
                name, dg: g1 - g0, probe: pstr(p0), probe2: pstr(p1),
                prescribed: `${p0.c}/${p0.m}/${p0.s}` !== `${p1.c}/${p1.m}/${p1.s}`,
                extended: Number(p0.t) !== Number(p1.t),
            };
            steps.push(r);
            return r;
        };
        runStep("新增记忆", () => dbm.writeMemory(vdb, { content: "1c 探针：新增-甲", type: "experience", agent: "1c-smoke", agent_fpath: null, project: "1c-p" }));
        const pid = Number(vdb.prepare(`SELECT MAX(id) m FROM memories`).get().m);
        const pver = Number(vdb.prepare(`SELECT version v FROM memories WHERE id=?`).get(pid).v);
        runStep("改写正文（CAS：content+embedding_stale+version 递增）", () => dbm.updateMemory(vdb, pid, { content: "1c 探针：改写-乙", expectedVersion: pver }));
        runStep("状态流转（active→archived）", () => dbm.archiveMemory(vdb, pid));
        const blood = runStep("纯命中回血（hit_count/last_hit_at/last_seen_at）", () => vdb.prepare(`UPDATE memories SET hit_count = hit_count + 1,
            last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(pid));
        const pool = steps.slice(0, 3);
        const detail = steps.map((r) => `${r.name} dgen=${r.dg} 探针 ${r.probe}→${r.probe2}`).join(" ｜ ");
        check("⑭ 写点自证：三个池相关写（新增/改写正文/状态流转）的 vec_gen 增量各为 1（触发器不漏点）",
            pool.every((r) => r.dg === 1), `dgen=${pool.map((r) => r.dg).join("/")} ｜ ${detail}`);
        check("⑭ 探针一致性：池相关写「探针变化 ⟺ vec_gen 增量>0」成立（指定口径 ∪ 扩展项）",
            pool.every((r) => (r.prescribed || r.extended) && r.dg > 0),
            `指定口径变化=${pool.map((r) => r.prescribed).join("/")} 扩展项变化=${pool.map((r) => r.extended).join("/")}`);
        check("⑭ 如实记录判据盲区：任务指定的廉价探针（COUNT/MAX(id)/SUM(version)）看不见「状态流转」",
            pool[2].prescribed === false && pool[2].extended === true,
            `状态流转步：指定口径 ${pool[2].probe}→${pool[2].probe2}（三项均未变）而扩展项变（status 文本长度 6→8）`);
        check("⑮ 回血写不误伤：只写 hit_count/last_hit_at/last_seen_at → vec_gen 增量必须为 0（探针亦不变）",
            blood.dg === 0 && !blood.prescribed && !blood.extended, `dgen=${blood.dg} 探针 ${blood.probe}→${blood.probe2}`);
        check("⑮ 反向对照：同一库上「仅写 confidence/eff_confidence（daemon 每小时衰减口径）」也不递增 vec_gen",
            (() => { const g = genOf(vdb); vdb.prepare(`UPDATE memories SET confidence = confidence + 0.1, eff_confidence = 0.5 WHERE id = ?`).run(pid); return genOf(vdb) === g; })(),
            "confidence/eff_confidence 不在候选池相关列内（依据：检索层不读 eff_confidence；confidence 仅作展示字段）");
        vdb.close(); // 关掉进程内库句柄（否则 Windows 下临时目录删除被文件句柄挡住 → 收尾 WARN）

        /* ③ 跨进程即时可见：核心预热 → 另一个进程写库 → 首次查询即命中 + 失效计数增长 */
        const QUERY = "赤道信风带";
        const CONTENT = "玄武岩层理测年方案编号九四七"; // 与查询词**零共同 CJK bigram、零整串交集**（防词法提前命中）
        const PROJ = "1c-probe";
        const CDB = path.join(WS, "1c-core.db");
        const DD = path.join(WS, "1c-core"), DD_COLD = path.join(WS, "1c-core-cold");
        fs.mkdirSync(DD, { recursive: true });
        fs.mkdirSync(DD_COLD, { recursive: true });
        const writerPath = path.join(WS, "1c-writer.mjs");
        fs.writeFileSync(writerPath, `import { openDb, writeMemory } from ${JSON.stringify(pathToFileURL(path.join(HERE, "db.js")).href)};
import { getEmbedder } from ${JSON.stringify(pathToFileURL(path.join(HERE, "embed.js")).href)};
const [dbPath, query, content, project] = process.argv.slice(2);
const db = openDb(dbPath);
const embedder = await getEmbedder();
const vec = await embedder.embedTexts([query]);
const m = writeMemory(db, { content, type: "experience", agent: "1c-probe", agent_fpath: null, project, embedding: vec[0] });
process.stdout.write("##RESULT##" + JSON.stringify({ id: m.id, dim: vec[0] ? vec[0].length : 0 }));
db.close();
`, "utf8");
        const P_CC = await freePort();
        const coreC = start([path.join(HERE, "dashboard.js")],
            baseEnv({ MEMORY_DB: CDB, MEMORY_PORT: String(P_CC), MEMORYOS_DATA_DIR: DD }), "1c-core");
        const hC = await waitForHealth(P_CC);
        if (!hC) {
            skip("③ 跨进程即时可见（隔离核心起不来）", `端口 ${P_CC} 30s 内未就绪（环境问题，按 SKIP 记）`);
        }
        else {
            const auth = { "x-memory-token": TOKEN, "content-type": "application/json" };
            const search = (port) => fetch(`http://127.0.0.1:${port}/ops/memory_search`, { method: "POST", headers: auth, body: JSON.stringify({ query: QUERY, project: PROJ, limit: 5 }) }).then((r) => r.json()).catch(() => null);
            const catalog = (port) => fetch(`http://127.0.0.1:${port}/ops/catalog?vec=1`, { headers: { "x-memory-token": TOKEN } }).then((r) => r.json()).catch(() => null);
            const idsOf = (txt) => [...String(txt ?? "").matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
            const warm = await search(P_CC);                    // 预热：建缓存 + 建代数基线
            const wIds = idsOf(warm?.result);
            const t0 = Number((await catalog(P_CC))?.vecInvalidations?.total ?? -1);
            const w = await new Promise((resolve) => {          // 另一个**进程**直接写库
                const c = spawn(NODE, [writerPath, CDB, QUERY, CONTENT, PROJ], { cwd: KERNEL, env: { ...baseEnv(), EMBED_MODE: "fake" }, windowsHide: true });
                let o = "", e = "";
                c.stdout.on("data", (d) => o += d);
                c.stderr.on("data", (d) => e += d);
                c.on("close", (code) => resolve({ code, o, e }));
            });
            const mres = /##RESULT##(\{.*?\})/.exec(w.o);
            const wid = mres ? Number(JSON.parse(mres[1]).id) : 0;
            const hot = await search(P_CC);                     // 跨进程写后的**第一次**查询
            const hIds = idsOf(hot?.result);
            const hotStats = (await catalog(P_CC))?.vecInvalidations;
            const t1 = Number(hotStats?.total ?? -1);
            const firstLine = String(hot?.result ?? "").split("\n").find((l) => /^#\d+ \[/.test(l)) ?? "(无命中行)";
            check("③ 另一个进程写库成功（exit=0 且落 id）", w.code === 0 && wid > 0,
                `exit=${w.code} id=${wid}${w.code === 0 ? "" : " stderr=" + w.e.trim().split("\n").slice(-2).join(" / ")}`);
            check("③ 判别性前提：预热查询确实不含该条（该条由别的进程后写）", !wIds.includes(wid),
                `预热命中 ids=[${wIds.join(",")}]`);
            check("③ 跨进程写后**第一次**查询即命中该条（非 TTL 兜底）", hIds.includes(wid),
                `命中 ids=[${hIds.join(",")}]；首条=${JSON.stringify(firstLine.slice(0, 90))}`);
            check("③ 核心 vecInvalidations 计数确实增长（证明由代数检测触发，而非 30s/60s TTL 到期）",
                t1 > t0 && t0 >= 0, `total ${t0}→${t1}；来源分布=${JSON.stringify(hotStats?.bySource ?? {})} lastSource=${hotStats?.lastSource ?? "?"}`);
            const P_CC2 = await freePort();                     // 冷/热一致对照：全新进程（冷缓存，独立 dataDir）
            const coreCold = start([path.join(HERE, "dashboard.js")],
                baseEnv({ MEMORY_DB: CDB, MEMORY_PORT: String(P_CC2), MEMORYOS_DATA_DIR: DD_COLD }), "1c-core-cold");
            const hC2 = await waitForHealth(P_CC2);
            if (!hC2) {
                skip("③ 冷/热一致对照（冷核心起不来）", `端口 ${P_CC2} 30s 内未就绪（环境问题，按 SKIP 记）`);
            }
            else {
                const cold = await search(P_CC2);
                const cIds = idsOf(cold?.result);
                const cStats = (await catalog(P_CC2))?.vecInvalidations;
                check("③ 冷/热一致：冷进程与热进程同一查询命中同一集合（该条都在）",
                    cIds.includes(wid) && cIds.join(",") === hIds.join(","), `热=[${hIds.join(",")}] 冷=[${cIds.join(",")}]`);
                check("③ 判别性对照：冷进程首次查询 vecInvalidations=0（缓存本空，无需失效即可见）而热进程靠代数增长",
                    Number(cStats?.total ?? -1) === 0 && t1 > t0, `冷进程 total=${cStats?.total}（期望 0）／热进程 ${t0}→${t1}`);
                stop(coreCold);
            }
        }
        stop(coreC);
    }

    /* ── ⑤ 半截 config.json → 按 direct 处理且不崩 ────────── */
    fs.writeFileSync(path.join(WS, "config.json"), '{"mcpMode":"shim"', "utf8"); // 故意截断（半写态）
    const halfDb = path.join(WS, "halfcfg.db");
    const halfEnv = baseEnv({ MEMORY_DB: halfDb });
    delete halfEnv.MEMORYOS_MCP_MODE;      // 确保走「文件读模式」路径
    const half = await (() => new Promise((resolve) => {
        const c = spawn(NODE, [path.join(HERE, "server.js"), "--list-tools"], { cwd: KERNEL, env: halfEnv, windowsHide: true });
        let o = "", e = "";
        c.stdout.on("data", (d) => o += d);
        c.stderr.on("data", (d) => e += d);
        c.on("close", (code) => resolve({ code, o, e }));
    }))();
    check("⑤ 半截 config.json 不崩（exit=0）", half.code === 0, `exit=${half.code}`);
    check("⑤ 半截 config.json 打了 warn 且按 direct 处理", /config\.json.*(解析失败|半写|direct)/.test(half.e), (half.e.trim().split("\n").find((l) => l.includes("config.json")) ?? "(无 warn 行)"));
    check("⑤ 按 direct 处理（DB 被打开 → 库文件已生成）", fs.existsSync(halfDb), halfDb);

    /* ── ⑥ 取消语义（可选，慢）────────────────────────────── */
    /* ── ⑪ 核心侧 /ops 长耗时调用**不得被误 abort**（回归：Node ≥16 的 IncomingMessage 'close' 语义）──
     *  修前实测：直连核心 `POST /ops/exec_run` 会在 ~250–530ms 被自身 AbortSignal 中止 → 子进程被杀，
     *    长耗时工具经 /ops 根本跑不完（裸 curl/fetch 直连核心即可复现，**与 shim 无关**）。
     *  根因：原实现监听 `req.raw` 的 'close'，而 Node ≥16 起该事件在**请求体读完**时即触发；
     *    已改为 `reply.raw` 的 'close'（配 `writableEnded` 守卫）+ `req.raw` 的 'aborted'。
     *  断言：子进程在 1.5s 后**仍存活**，且该次调用正常返回。 */
    try {
        const P_E = await freePort();
        const longPath = path.join(WS, "longrun-ops.js");
        const pidOpsFile = path.join(WS, "longrun-ops.pid");
        fs.writeFileSync(longPath,
            `const fs=require("fs");\nfs.writeFileSync(${JSON.stringify(pidOpsFile)},String(process.pid));\nsetTimeout(()=>process.exit(0),2500);\n`, "utf8");
        try { fs.unlinkSync(pidOpsFile); } catch { /* 首次无 */ }
        const coreE = start([path.join(HERE, "dashboard.js")],
            baseEnv({ MEMORY_DB: path.join(WS, "core-e.db"), MEMORY_PORT: String(P_E), MEMORYOS_EXEC_ON: "1" }), "core-e");
        const hE = await waitForHealth(P_E);
        if (!hE) {
            skip("⑪ 核心 /ops 长耗时调用（隔离核心 exec=ON 起不来）", `端口 ${P_E} 30s 内未就绪（环境问题，按 SKIP 记）`);
        }
        else {
            const pResp = fetch(`http://127.0.0.1:${P_E}/ops/exec_run`, {
                method: "POST",
                headers: { "x-memory-token": TOKEN, "content-type": "application/json" },
                body: JSON.stringify({ cmd: [NODE, longPath], timeout_ms: 20_000 }),
            }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
            const readPid = () => { try { return Number(fs.readFileSync(pidOpsFile, "utf8").trim()); } catch { return 0; } };
            let childPid = 0;
            for (let i = 0; i < 30 && !childPid; i++) { await sleep(100); childPid = readPid(); }
            await sleep(1_500);                                   // 修前此刻子进程早已被杀（~250–530ms）
            const aliveAt1500 = childPid > 0 && pidAlive(childPid);
            const body = await pResp;
            const ranOk = body?.ok === true && !/"isError":true/.test(JSON.stringify(body?.result ?? ""));
            check("⑪ 核心 /ops/exec_run 的子进程在 1.5s 后仍存活（未被误 abort）", aliveAt1500,
                `childPid=${childPid} 存活=${aliveAt1500}（修前 ~250–530ms 即被杀）`);
            check("⑪ 长耗时调用正常返回（未被自身信号中止）", ranOk, `ok=${body?.ok} err=${body?.error ?? "无"}`);
            stop(coreE);
        }
    }
    catch (e) {
        check("⑪ 核心 /ops 长耗时调用探针未抛异常", false, e instanceof Error ? e.message : String(e));
    }

    /* ── ⑨ 核心被杀 / 重启：两种客户端姿势都要给可行动文案 ────────────────
     *  ⑨a 真实姿势（客户端未获 MEMORY_PORT）：端口靠 core.json 发现；核心被杀后 core.json 的 pid 已陈旧
     *      ⇒ shim 应**快速**给出「核心未运行、不要重复调用」的可行动文案（不让客户端干等）。
     *  ⑨b 端口已缓存姿势（MEMORY_PORT 固定，模拟 undici keep-alive 复用）：核心刚被杀时复用连接先报
     *      **ECONNRESET**（不是 ECONNREFUSED）—— 原判据只认后者 ⇒ 不重试、抛裸 `fetch failed`（缺可行动
     *      文案，且行为依赖时序：隔 ~300ms 才转成 ECONNREFUSED）。本条用**零延迟**调用 + 耗时下界把该竞态钉死。 */
    try {
        const shimSrv2 = start([path.join(HERE, "server.js")], shimEnv, "shim-after-kill");
        const c2 = mcpClient(shimSrv2);
        await c2.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
        shimSrv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        await c2.send("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } }); // 预热：先建立 keep-alive 连接
        stop(core);                                                             // 杀核心
        const t0a = Date.now();
        const rKill = await c2.send("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } });
        const msKill = Date.now() - t0a;
        check("⑨a 核心被杀后立刻调用在 ≤8s 内返回", msKill <= 8_000, `${msKill}ms`);
        check("⑨a 立刻调用也带可行动文案（不依赖时序）", /不要重复调用/.test(rKill.line ?? ""), String(rKill.line).slice(0, 400));
        /* ⑨b：端口已缓存姿势 —— MEMORY_PORT 固定 ⇒ 不复用 core.json，能真正走到 HTTP 连接级失败 */
        const shimSrv3 = start([path.join(HERE, "server.js")], { ...shimEnv, MEMORY_PORT: String(P_CORE) }, "shim-pinned");
        const c3 = mcpClient(shimSrv3);
        await c3.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
        shimSrv3.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const coreTmp = start([path.join(HERE, "dashboard.js")], coreEnv, "core-tmp");
        await waitForHealth(P_CORE);
        await c3.send("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } }); // 预热：建立 keep-alive 连接
        stop(coreTmp);                                                         // 杀核心（复用连接此刻仍在池中）
        const t0b = Date.now();
        const rKill2 = await c3.send("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } });
        const msKill2 = Date.now() - t0b;
        check("⑨b 连接级失败确实走了重试（退避非零）", msKill2 >= 200, `${msKill2}ms`);
        check("⑨b 仍 ≤8s 且带可行动文案", msKill2 <= 8_000 && /不要重复调用/.test(rKill2.line ?? ""), `${msKill2}ms / ${String(rKill2.line).slice(0, 220)}`);
        const core2 = start([path.join(HERE, "dashboard.js")], coreEnv, "core-restart");
        const back = await waitForHealth(P_CORE);
        check("⑨c 核心同端口重启后就绪", back !== null && back.ok === true, `port=${P_CORE}`);
        const rBack = await c3.send("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } });
        check("⑨c 不重启 shim 客户端即可恢复", !/"isError":true/.test(rBack.line ?? ""), String(rBack.line).slice(0, 200));
        stop(shimSrv2);
        stop(shimSrv3);
        stop(core2);
    }
    catch (e) {
        check("⑨ 核心被杀/重启探针未抛异常", false, e instanceof Error ? e.message : String(e));
    }

    /* ── ⑩ ★ 本批验收：`notifications/cancelled` 按 **JSON-RPC id** 精准中止在途转发 ──────────
     *  构造：把 shim 的 `MEMORY_PORT` 指向一个**黑洞 TCP 服务**（接受连接但永不回响应）→ 每次 tools/call 的 HTTP
     *  转发会稳定地**挂在途**（直到 60s 工具超时），从而给「取消」一个宽松、确定的窗口。
     *  为什么不用 exec_run 子进程作判据：本机上 `POST /ops/exec_run` 的核心侧信号在请求开始约 250–530ms 后即
     *  **自行 abort**（子进程被杀、响应带「请求已中断」），**裸 curl/fetch 直连核心即可复现**（与本批改动、与
     *  本 shim 均无关）→ 子进程消失**不具判别性**，故改以「转发是否被精确中止」为判据。
     *  ⑩a 不匹配的 id → 在途调用不受影响（仍挂着、未收到响应）→ 取消按 id 精确路由、非一刀切。
     *  ⑩b 真实 id（以 string 形式下发，使 SDK 的类型严格查找落空从而**能收到**响应）→ shim 按 `String(id)`
     *      归一化仍精确命中 → 立即中止转发并回 `⏹ … 已被客户端取消 …`（该文案核心侧绝不可能产出）。
     *  ⑩c 真实 id（number 形态，MCP 常规）→ SDK 丢弃已取消请求的响应 → 客户端收不到该 id 的响应行（如实记录）。 */
    {
        const P4 = await freePort();
        const holeSocks = new Set();
        const blackhole = net.createServer((sock) => { holeSocks.add(sock); sock.on("error", () => { /* 忽略 */ }); sock.on("close", () => holeSocks.delete(sock)); /* 接受但永不响应 */ });
        await new Promise((r) => blackhole.listen(P4, "127.0.0.1", r));
        const shim4 = start([path.join(HERE, "server.js")],
            baseEnv({ MEMORY_DB: path.join(WS, "shim-cancelretry.db"), MEMORY_PORT: String(P4), MEMORYOS_MCP_MODE: "shim" }), "shim-cancelretry");
        const seen = [];
        const mc = mcpClient(shim4, (m) => seen.push(m));
        await mc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
        shim4.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        /* ⑩a/b：同一条在途调用（黑洞使其稳定挂起）：先发「不匹配 id」，再发真实 id */
        const call = mc.sendTracked("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } });
        await sleep(600);
        seen.length = 0;                                                            // 只观察取消之后的入站消息
        mc.notify("notifications/cancelled", { requestId: `no-such-${call.id}` });  // 不匹配（string）
        await sleep(600);
        check("⑩ 对**不匹配的 id** 发取消 → 在途调用不受影响（仍未收到响应，转发继续挂起 → 按 id 精确路由、非一刀切）",
            !seen.some((m) => m && m.id === call.id), `id=${call.id} 收到「错 id」取消后 600ms 内无响应`);
        const t0 = Date.now();
        mc.notify("notifications/cancelled", { requestId: String(call.id) });       // ★ 真实 id（string 形式，客户端可见）
        const rB = await call.promise;
        const msB = Date.now() - t0;
        check("⑩ 对**真实 id**（不带 _meta.requestId）发取消 → shim 精确中止在途转发并回结构化「已取消」结果",
            /已被客户端取消/.test(rB.line ?? "") && msB <= 1_500, `${msB}ms；响应=${String(rB.line).slice(0, 130)}`);
        /* ⑩c：真实 id 的常规（number）形态 → SDK 丢弃该请求响应（如实记录观察到的形态） */
        const callN = mc.sendTracked("tools/call", { name: "tool_guide", arguments: { name: "memory_search" } });
        await sleep(600);
        seen.length = 0;
        mc.notify("notifications/cancelled", { requestId: callN.id });              // number 形态（与 SDK 请求 id 同类型）
        await sleep(1_400);
        check("⑩ 真实 id（number 形态）发取消 → 客户端**未收到**该 id 的响应行（SDK 对已取消请求丢弃响应，如实记录）",
            !seen.some((m) => m && m.id === callN.id), `id=${callN.id} 1.4s 内未收到响应行`);
        callN.promise.catch(() => null);                                            // SDK 丢弃 → 60s 后会 reject，兜底
        stop(shim4);
        for (const s of holeSocks) { try { s.destroy(); } catch { /* 已关 */ } }
        try { blackhole.close(); } catch { /* 已关 */ }                             // 不等现有连接自然结束（防顶层 await 悬空）
        blackhole.unref();
        skip("⑩ 并行两条只取消其中一条（另一条不受影响）",
            "本环境无法构造：核心对**并发**在途请求会同时触发全部在途请求的 abort（既有行为；裸 curl/fetch 直连核心即可复现，与 shim 无关）");
    }

    if (CANCEL) {
        const P2 = await freePort();
        fs.writeFileSync(path.join(WS, "longrun.js"),
            `const fs=require("fs");\nfs.writeFileSync(${JSON.stringify(path.join(WS, "longrun.pid"))},String(process.pid));\nsetInterval(()=>{},1000);\n`, "utf8");
        const pidFile = path.join(WS, "longrun.pid");
        try { fs.rmSync(pidFile, { force: true }); } catch { /* 无 */ }
        const core2 = start([path.join(HERE, "dashboard.js")],
            baseEnv({ MEMORY_DB: path.join(WS, "core-exec.db"), MEMORY_PORT: String(P2), MEMORYOS_EXEC_ON: "1" }), "core-exec");
        const c2 = await waitForHealth(P2);
        if (!c2) {
            skip("⑥ 取消语义（执行面核心起不来）", "8→30s 内未就绪");
        }
        else {
            const shim2 = start([path.join(HERE, "server.js")],
                baseEnv({ MEMORY_DB: path.join(WS, "shim-exec.db"), MEMORY_PORT: String(P2), MEMORYOS_MCP_MODE: "shim", MEMORYOS_EXEC_ON: "1" }), "shim-exec");
            const mc = mcpClient(shim2);
            await mc.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-smoke", version: "0.1.0" } });
            shim2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            const call = mc.send("tools/call", { name: "exec_run", arguments: { cmd: ["node", "longrun.js"], cwd: "." } }).catch(() => null);
            let childPid = 0;
            for (let i = 0; i < 40 && !childPid; i++) {           // 等 longrun.js 落下自己的 pid
                await sleep(250);
                try { childPid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { childPid = 0; }
            }
            check("⑥ exec_run 子进程已起（pid 可见）", childPid > 0 && pidAlive(childPid), `childPid=${childPid}`);
            shim2.stdin.end();                                    // ← MCP 客户端侧「传输关闭」：shim 应 abort 在途请求
            let killed = false;
            for (let i = 0; i < 40 && !killed; i++) {             // ≤10s 内应观察到子进程消失
                await sleep(250);
                killed = childPid > 0 && !pidAlive(childPid);
            }
            check("⑥ 传输关闭 → shim abort → 核心中断 → 子进程树被杀（无孤儿）", killed, killed ? `childPid=${childPid} 已终止` : `childPid=${childPid} 仍存活（疑似孤儿）`);
            await call;
            stop(shim2);
            stop(core2);
        }
    }
    else
        skip("⑥ 取消语义（需 MEMORYOS_SHIM_SMOKE_CANCEL=1）", "默认不跑（较慢）；设该 env 后单独执行本脚本");
}
catch (e) {
    failed++;
    console.log(`FAIL  探针自身异常：${e instanceof Error ? e.stack : String(e)}`);
}
finally {
    await killAllAndWait();
    await removeWs();
}

console.log(`\n== shim 冒烟：${passed} PASS / ${failed} FAIL / ${skipped} SKIP ==`);
process.exit(failed ? 1 : 0);
