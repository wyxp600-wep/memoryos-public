#!/usr/bin/env node
/**
 * MemoryOS — T12 内核自愈 / 调度锁超时 / 统一错误处理器（P2-1）冒烟
 *
 * 覆盖（全部用注入替身，不真起内核、不杀真实进程）：
 *   A. core-process 自愈：健康存活归零计数 / 崩溃后按指数退避排重启 / 超限弹框不再重启 /
 *      退出流程不重启 / killAll 作废待重启
 *   B. scheduler 调度锁：同轮重入跳过 / 子进程退出后锁释放 / 陈旧锁（超 TTL）自动接管 /
 *      子进程超时 → 杀树 + 锁释放
 *   C. dashboard 统一错误处理器：5xx 结构化 JSON、不回堆栈与内部路径、4xx 保留原状态码、鉴权仍 fail-closed
 *
 * 用法：cd resources/memoryos && node dist/smoke-t12.js     退出码 0/1
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { buildApp } from "./dashboard.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICES = path.resolve(HERE, "..", "..", "..", "services");   // 仓库根/services（Electron 主进程 CJS）

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
};

/* ── 替身工具 ─────────────────────────────────────────────── */
const logs = [];
const log = (...a) => logs.push(a.join(" "));
const logHas = (re) => logs.some((l) => re.test(l));

/** 采集式假定时器：只登记回调，由用例手动触发 */
function fakeTimers() {
    const pending = new Map();
    let seq = 0;
    return {
        pending,
        timers: {
            setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
            clearTimeout: (id) => { pending.delete(id); },
        },
        fireAll(filter) {
            const fired = [];
            for (const [id, t] of [...pending.entries()]) {
                if (filter && !filter(t)) continue;
                pending.delete(id);
                fired.push(t.ms);
                t.fn();
            }
            return fired;
        },
    };
}

/** 假子进程：EventEmitter + stdout/stderr 流 + 可手动 exit */
function fakeChild(pid = 4242) {
    const c = new EventEmitter();
    c.pid = pid;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => { c.killed = true; };
    c.exit = (code = 1) => c.emit("exit", code);
    return c;
}

/** 让 portOpen 立刻返回 true 的本地监听端口（避免 startCore 走 60s 等待） */
const srv = net.createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const OPEN_PORT = srv.address().port;

/* ── A. core-process 自愈 ─────────────────────────────────── */
process.env.CORE_MAX_RESTARTS = "2";
process.env.CORE_RESTART_BASE_MS = "3000";
process.env.CORE_RESTART_MAX_MS = "10000";
delete process.env.CORE_SELFHEAL;
const { createCore } = require(path.join(SERVICES, "core-process.js"));

const dialogs = [];
/** 造一个 core 实例：假 spawn（记录子进程）+ 假定时器（手动触发） */
function makeCore({ isQuitting = false, healthyMs, timers } = {}) {
    const kids = [];
    if (healthyMs != null) process.env.CORE_HEALTHY_MS = String(healthyMs);
    const core = createCore({
        nodeExe: () => process.execPath,
        getKernel: () => path.resolve(HERE, ".."),
        dataDir: () => path.join(os.tmpdir(), "memoryos-t12-fake"),
        readConfig: () => ({}),
        getPort: () => OPEN_PORT,
        getToken: () => "t12-token",
        isQuitting: () => isQuitting,
        log,
        dialog: { showMessageBox: (o) => dialogs.push(o.message) },
        spawnImpl: () => { const c = fakeChild(1000 + kids.length); kids.push(c); return c; },
        timers,
    });
    return { core, kids, last: () => kids[kids.length - 1] };
}

// A0/A1：参数可观测 + 启动两进程
const a1 = makeCore({ healthyMs: 60000 });
check("A0.stats 暴露自愈参数（可观测）", a1.core.stats().maxRestarts === 2 && a1.core.stats().selfHeal === true, JSON.stringify({ max: a1.core.stats().maxRestarts, heal: a1.core.stats().selfHeal }));
await a1.core.startCore();
check("A1.startCore 拉起 dashboard + daemon", a1.kids.length === 2 && a1.core.stats().scripts["dashboard.js"]?.restarts === 0, `kids=${a1.kids.length}`);

// A2~A4：崩溃 → 退避重启 → 超限弹框
const tA = fakeTimers();
const a2 = makeCore({ healthyMs: 60000, timers: tA.timers });
await a2.core.startCore();
logs.length = 0;
a2.last().exit(1);
const pendingMs = () => [...tA.pending.values()].map((t) => t.ms);
check("A2.崩溃后按退避排定重启（不再只弹框）", pendingMs().includes(3000), `pending=${pendingMs().join(",")}`);
check("A2.自愈生效时不打扰用户（无弹框）", dialogs.length === 0, `dialogs=${dialogs.length}`);
tA.fireAll((t) => t.ms === 3000);                 // 触发重启 → 拉起新子进程
await new Promise((r) => setTimeout(r, 30));
a2.last().exit(1);                                // 第 2 次崩溃
check("A3.退避指数增长（3000 → 6000）", pendingMs().includes(6000), `pending=${pendingMs().join(",")}`);
tA.fireAll((t) => t.ms === 6000);
await new Promise((r) => setTimeout(r, 30));
a2.last().exit(1);                                // 第 3 次崩溃（超 MAX_RESTARTS=2）
check("A4.超限后弹框告知（不无限重启）", dialogs.length === 1, `dialogs=${dialogs.length}`);
check("A4.超限后无待重启定时器", tA.pending.size === 0, `pending=${tA.pending.size}`);

// A5：killAll 作废待重启
const tA5 = fakeTimers();
const a5 = makeCore({ healthyMs: 60000, timers: tA5.timers });
await a5.core.startCore();
a5.last().exit(1);
const hadPending = tA5.pending.size > 0;
a5.core.killAll();
check("A5.killAll 作废待重启（退出不留悬浮定时器）", hadPending && tA5.pending.size === 0, `had=${hadPending} after=${tA5.pending.size}`);

// A6：退出流程不重启、不弹框
const tA6 = fakeTimers();
const dlgBefore = dialogs.length;
const a6 = makeCore({ isQuitting: true, healthyMs: 60000, timers: tA6.timers });
await a6.core.startCore();
a6.kids.forEach((c) => c.exit(0));
check("A6.退出流程不重启、不弹框", tA6.pending.size === 0 && dialogs.length === dlgBefore, `pending=${tA6.pending.size}`);

// A7：健康存活过阈值 → 计数归零（偶发崩溃不累积耗尽额度）
const tA7 = fakeTimers();
const a7 = makeCore({ healthyMs: 0, timers: tA7.timers });
await a7.core.startCore();
a7.last().exit(1);
const after1 = a7.core.stats().scripts["daemon.js"].restarts;
tA7.fireAll();
await new Promise((r) => setTimeout(r, 30));
a7.last().exit(1);
const after2 = a7.core.stats().scripts["daemon.js"].restarts;
check("A7.健康存活后计数归零（不会累计到超限）", after1 === 1 && after2 === 1, `第1次=${after1} 第2次=${after2}`);

/* ── B. scheduler 调度锁 ─────────────────────────────────── */
process.env.SCHED_LOCK_TTL_MIN = "1";
process.env.SCHED_CHILD_TIMEOUT_MIN = "1";
const { createScheduler } = require(path.join(SERVICES, "scheduler.js"));

// 用真脚本路径（existsSync 需要文件存在）：在 <kernel>/dist/ 下放一个占位 ingest-cli.js
const fakeScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "t12-sched-"));
fs.mkdirSync(path.join(fakeScriptDir, "dist"), { recursive: true });
fs.writeFileSync(path.join(fakeScriptDir, "dist", "ingest-cli.js"), "// fake\n", "utf8");

const t2s = fakeTimers();
let spawned = [];
let lastSchedKid = null;
const sched = createScheduler({
    nodeExe: () => process.execPath,
    getKernel: () => fakeScriptDir,       // ingest-cli.js 落在此目录（存在即通过存在性校验）
    dataDir: () => fakeScriptDir,
    // ★ 2026-09-22（A 分区）：原缺这两个注入。scheduler 的 runAutoIngest 在构建子进程 env 时
    //   会调 getPort()/getToken()（拼 EMBED_API_URL / EMBED_API_KEY，P1-perf B6′ 嵌入侧车引入），
    //   未注入即抛「getPort is not a function」→ 被 catch 捕获 → 不 spawn → B1/B2 失败。
    //   属测试依赖漂移（非产品回归），补上即可。
    getPort: () => 17877,
    getToken: () => "t12-smoke-token",
    log,
    spawnImpl: () => { const c = fakeChild(7000 + spawned.length); spawned.push(c); lastSchedKid = c; return c; },
    timers: t2s.timers,
});
logs.length = 0;
await sched.runAutoIngest();               // 第 1 次：拿到锁 → 起子进程
check("B1.首次采集启动子进程且锁生效", spawned.length === 1 && sched.stats().locks["自动采集"]?.running === true);
await sched.runAutoIngest();               // 第 2 次：子进程未退出 → 跳过
check("B2.同轮重入被跳过（防重入仍有效）", spawned.length === 1 && logHas(/上一轮仍在运行/));
lastSchedKid.exit(0);                      // 子进程正常结束 → 锁释放
await new Promise((r) => setTimeout(r, 20));
check("B3.子进程退出后锁释放", sched.stats().locks["自动采集"]?.running === false);
await sched.runAutoIngest();
check("B4.锁释放后可再次运行", spawned.length === 2);

// 陈旧锁接管：把「现在」推后 2 分钟（>TTL 1min），不退出子进程也应被接管
const realNow = Date.now;
Date.now = () => realNow() + 2 * 60 * 1000;
await sched.runAutoIngest();
Date.now = realNow;
check("B5.超 TTL 的陈旧锁被接管（避免永久停摆）", sched.stats().locks["自动采集"]?.takeovers === 1 && spawned.length === 3, `takeovers=${sched.stats().locks["自动采集"]?.takeovers}`);

// 子进程超时 → 杀树 + 释放锁
logs.length = 0;
const runningKid = spawned[spawned.length - 1];
t2s.fireAll((t) => t.ms === 60 * 1000);    // 子进程超时定时器（SCHED_CHILD_TIMEOUT_MIN=1）
check("B6.子进程超时触发终止", logHas(/子进程超时/), logs.filter((l) => /超时/.test(l))[0] ?? "");
runningKid.exit(null);                     // 杀树后进程退出
await new Promise((r) => setTimeout(r, 20));
check("B7.超时路径同样释放锁（不会卡死）", sched.stats().locks["自动采集"]?.running === false);

/* ── C. dashboard 统一错误处理器 ─────────────────────────── */
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t12-dash-")), "t12.db");
const db = openDb(tmpDb);
const app = buildApp(db, { token: "t12-dash-token" });
app.get("/api/__t12_boom", async () => { throw new Error("boom-secret-internal-path C:\\secret\\x.db"); });
await app.ready();
const req = (url, opts = {}) => app.inject({ ...opts, url, headers: { "x-memory-token": "t12-dash-token", ...(opts.headers ?? {}) } });

const r500 = await req("/api/__t12_boom");
const body500 = r500.body;
check("C1.未捕获异常 → 500", r500.statusCode === 500, `status=${r500.statusCode}`);
check("C2.5xx 结构化 JSON（ok/env 形状）", (() => { try { const j = JSON.parse(body500); return j.ok === false && j.code === "INTERNAL" && typeof j.error === "string"; } catch { return false; } })(), body500.slice(0, 90));
check("C3.5xx 不泄漏内部信息（无堆栈/路径/SQL）", !/boom-secret-internal-path|C:\\secret|\bat \w|SELECT |\.js:\d+/.test(body500), "无堆栈与路径泄漏");
check("C4.404 仍走轻量处理（不误解为 500）", (await req("/api/__nope")).statusCode === 404);
check("C5.鉴权仍 fail-closed（无令牌 401）", (await app.inject({ method: "GET", url: "/api/summary" })).statusCode === 401);
await app.close();
try { db.close(); } catch { /* 已关 */ }
try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* Windows 句柄可能未即时释放，忽略 */ }

srv.close();
console.log(`\n== T12/P2-1 冒烟：${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
