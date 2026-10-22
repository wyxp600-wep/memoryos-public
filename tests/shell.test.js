/**
 * 外壳层单元测试（Electron 壳的纯 Node 部分）
 *
 * 背景：外壳层 12 个模块中 7 个（security/ipc、security/token、app/lifecycle、window/*）硬依赖
 *   `electron`，无法脱离 Electron 单测；本文件覆盖**有注入缝的 4 个**：
 *     services/core-process.js  内核进程自愈（退避 / 计数 / 健康窗 / 额度 / 清定时器）
 *     services/scheduler.js     周期调度锁（防重入 / 陈旧锁接管 / 子进程超时）
 *     services/port.js          端口探测与顺延
 *     services/updater.js       更新包哈希校验（纯函数）
 *   这四个模块的 `spawnImpl`、`timers`、`stats()` 在源码注释里即标注「仅为可测性」。
 *
 * 运行：node --test tests/        （零依赖，用 Node 内置 node:test，无需根 package.json）
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { EventEmitter } = require("node:events");

const { createCore } = require("../services/core-process");
const { createScheduler } = require("../services/scheduler");
const { portOpen, findFreePort } = require("../services/port");
const { sha256Buf, sha256File } = require("../services/updater");

/* ============================ 测试替身 ============================ */

/** 假子进程：EventEmitter + stdout/stderr 流 + pid/kill */
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

/** 假定时器：记录排期与清除，不真的触发（由测试手动推进） */
function fakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeout: (fn, ms) => {
      const id = { fn, ms, fired: false };
      scheduled.push(id);
      return id;
    },
    clearTimeout: (id) => {
      if (id) cleared.push(id);
    },
    /** 手动推进：触发最后一个未被清除的排期 */
    fireLast() {
      const last = scheduled.filter((t) => !cleared.includes(t)).pop();
      if (last) { last.fired = true; last.fn(); }
      return last;
    },
  };
}

/** 起一个真实 TCP 监听（供 portOpen 判定「已就绪」），返回 { server, port } */
function listenEphemeral() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
}

/** 设置环境变量并在回调后还原（core-process / scheduler 在 create 时读取 env） */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = String(v);
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/** 可写 dataDir 的临时目录（discoverHealthyCore 测试用：放 core.json） */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-shell-test-"));

/** 造一个注入了替身的 core；返回句柄供断言 */
function makeCore({ port, env = {}, overrides = {} } = {}) {  return withEnv(env, () => {
    const spawned = [];
    const dialogs = [];
    const logs = [];
    const timers = fakeTimers();
    const core = createCore({
      nodeExe: () => "node",
      getKernel: () => "/kernel",
      dataDir: () => "/data",
      readConfig: () => ({}),
      getPort: () => port,
      getToken: () => "tok",
      isQuitting: () => false,
      log: (...a) => logs.push(a.map(String).join(" ")),
      dialog: { showMessageBox: (o) => dialogs.push(o) },
      spawnImpl: (exe, args, opts) => {
        const child = fakeChild(9000 + spawned.length);
        spawned.push({ exe, args, opts, child, script: path.basename(String(args[0])) });
        return child;
      },
      // 不打真 taskkill：fakeChild 的 pid 是 9000+ 的占位值，真杀可能误伤机器上的同号进程
      spawnSyncImpl: () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      timers,
      ...overrides,
    });
    return { core, spawned, dialogs, logs, timers };
  });
}

/** 从 core 句柄里按脚本名取假子进程 */
const childOf = (h, script) => h.spawned.find((s) => s.script === script).child;

/* ==================== 一、core-process：内核自愈 ==================== */

test("core: startCore 拉起 dashboard 与 daemon，且注入关键 env", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore(); // portOpen 立即为真 → 约 400ms 内返回，不会等满 60s

  const scripts = h.spawned.map((s) => s.script);
  assert.deepEqual(scripts.sort(), ["daemon.js", "dashboard.js"]);

  const dash = h.spawned.find((s) => s.script === "dashboard.js");
  assert.equal(dash.opts.env.MEMORY_PORT, String(port));
  assert.equal(dash.opts.env.MEMORY_TOKEN, "tok");
  assert.equal(dash.opts.env.MEMORY_DB, path.join("/data", "data", "memory.db"));
  assert.equal(dash.opts.env.EMBED_MODE, "local");
  // ★ 2026-10-14 发布默认收口：缺省=关（对齐 2026-09-15 用户拍板「决策 1(a)」与 README「默认关闭」；
  //   原实现无条件写 "1"，与文档相反 —— 等于把「Agent 可跑命令」随桌面版发给每个人）
  assert.equal(dash.opts.env.MEMORYOS_EXEC_ON, "0");

  // daemon 走嵌入侧车（P1-perf B6′：不再自持 560MB 模型）
  const dae = h.spawned.find((s) => s.script === "daemon.js");
  assert.equal(dae.opts.env.EMBED_MODE, "api");
  assert.match(dae.opts.env.EMBED_API_URL, /\/v1\/embeddings$/);
});

/* ★ 2026-10-14 发布默认收口：缺省=关；仅 config.json 显式 execOn=true 才开。 */
test("core: 执行面缺省关闭，config.execOn=true 才注入 MEMORYOS_EXEC_ON=1", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  // ① 缺省（readConfig 返回 {} → 无 execOn）→ 关
  const off = makeCore({ port });
  await off.core.startCore();
  assert.equal(off.spawned.find((s) => s.script === "dashboard.js").opts.env.MEMORYOS_EXEC_ON, "0");

  // ② 显式 execOn=true → 开
  const on = makeCore({ port, overrides: { readConfig: () => ({ execOn: true }) } });
  await on.core.startCore();
  assert.equal(on.spawned.find((s) => s.script === "dashboard.js").opts.env.MEMORYOS_EXEC_ON, "1");
});

test("core: 意外退出按指数退避重排 3000→6000→12000→24000→48000", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  const child = childOf(h, "dashboard.js");

  const delays = [];
  for (let i = 0; i < 5; i++) {
    child.emit("exit", 1);
    delays.push(h.timers.scheduled.at(-1).ms);
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 48000]);
  assert.equal(h.core.stats().scripts["dashboard.js"].restarts, 5);
});

test("core: 退避封顶 maxDelayMs（base 40000 → 第 2 次即封顶 60000）", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port, env: { CORE_RESTART_BASE_MS: 40000, CORE_MAX_RESTARTS: 10 } });
  await h.core.startCore();
  const child = childOf(h, "dashboard.js");

  child.emit("exit", 1);
  assert.equal(h.timers.scheduled.at(-1).ms, 40000);
  child.emit("exit", 1);
  assert.equal(h.timers.scheduled.at(-1).ms, 60000); // 80000 被 CORE_RESTART_MAX_MS 截断
});

test("core: 同一脚本同一时刻只排一次（重排前清掉旧定时器）", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  const child = childOf(h, "dashboard.js");

  child.emit("exit", 1);
  child.emit("exit", 1);
  assert.ok(h.timers.cleared.length >= 1, "第二次退出应先清掉上一个待重启定时器");
  assert.equal(h.timers.scheduled.filter((t) => !h.timers.cleared.includes(t)).length, 1);
});

test("core: 两个脚本的重启计数互不影响", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();

  childOf(h, "dashboard.js").emit("exit", 1);
  childOf(h, "dashboard.js").emit("exit", 1);
  childOf(h, "daemon.js").emit("exit", 1);

  const s = h.core.stats();
  assert.equal(s.scripts["dashboard.js"].restarts, 2);
  assert.equal(s.scripts["daemon.js"].restarts, 1);
});

test("core: 存活超过健康阈值后计数归零（HEALTHY_MS=0 时退避不累积）", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  // HEALTHY_MS=0 ⇒ uptime >= 0 恒真 ⇒ 每次退出都视为「健康存活过」→ 计数重置 → 恒为基础退避
  const h = makeCore({ port, env: { CORE_HEALTHY_MS: 0 } });
  await h.core.startCore();
  const child = childOf(h, "dashboard.js");

  const delays = [];
  for (let i = 0; i < 3; i++) {
    child.emit("exit", 1);
    delays.push(h.timers.scheduled.at(-1).ms);
  }
  assert.deepEqual(delays, [3000, 3000, 3000]);
  assert.equal(h.core.stats().scripts["dashboard.js"].restarts, 1);
});

test("core: 重启额度用尽后弹框且不再排期", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port, env: { CORE_MAX_RESTARTS: 2 } });
  await h.core.startCore();
  const child = childOf(h, "dashboard.js");

  child.emit("exit", 1); // → 1
  child.emit("exit", 1); // → 2
  const before = h.timers.scheduled.length;
  child.emit("exit", 1); // 2 >= 2 → 弹框，不排期

  assert.equal(h.timers.scheduled.length, before, "额度用尽后不应再排重启");
  assert.ok(h.dialogs.some((d) => /已停止自动重启/.test(d.message)), "应弹框告知已停止自动重启");
});

test("core: dashboard EADDRINUSE 不计入自愈额度，按封顶间隔轻量重试（#4429）", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port, env: { CORE_MAX_RESTARTS: 2 } });
  await h.core.startCore();
  const child = childOf(h, "dashboard.js");

  // 端口被孤儿实例占用 → 新 dashboard bind 失败，stderr 打出 EADDRINUSE 后秒退
  const eaddr = "Error: listen EADDRINUSE: address already in use 127.0.0.1:" + port;
  child.stderr.emit("data", eaddr);
  child.emit("exit", 1);
  child.stderr.emit("data", eaddr);
  child.emit("exit", 1);

  const s = h.core.stats().scripts["dashboard.js"];
  assert.equal(s.restarts, 0, "EADDRINUSE 秒退不应计入 MAX_RESTARTS 额度");
  assert.ok(h.logs.some((l) => /端口已被占用/.test(l)), "应记日志说明端口被占");
  assert.ok(!h.dialogs.some((d) => /已停止自动重启/.test(d.message)), "额度未消耗，不应弹停止自愈框");
  const pending = h.timers.scheduled.filter((x) => !h.timers.cleared.includes(x));
  assert.equal(pending.length, 1, "同脚本只排一次轻量重试");
  assert.equal(pending.at(-1).ms, 60000, "按封顶间隔重试而非退避递增");

  // 推进重试 → startCore 应再次补拉 dashboard（接管孤儿退出后的空档）
  h.timers.fireLast();
  // 等 startCore 首轮 portOpen 轮询（原生 400ms）落地：若测试先结束、t.after 关掉临时端口，
  // 该轮询会空转 60s 后以「内核 60s 未就绪」悬挂拒绝（async activity after test ended）
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(h.spawned.filter((x) => x.script === "dashboard.js").length, 2, "重试应再次拉起 dashboard");
});

test("core: daemon 的 EADDRINUSE 不走端口分支（daemon 无端口），仍按退避计数", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  const child = childOf(h, "daemon.js");
  child.stderr.emit("data", "Error: connect EADDRINUSE 127.0.0.1:1");
  child.emit("exit", 1);

  assert.equal(h.core.stats().scripts["daemon.js"].restarts, 1, "非 dashboard 仍走正常计数");
  assert.equal(h.timers.scheduled.at(-1).ms, 3000, "首退按基础退避 3000ms");
});

test("core: isQuitting 为真时不重启也不弹框", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port, overrides: { isQuitting: () => true } });
  await h.core.startCore();
  childOf(h, "dashboard.js").emit("exit", 0);

  assert.equal(h.timers.scheduled.length, 0);
  assert.equal(h.dialogs.length, 0);
});

test("core: CORE_SELFHEAL=0 时弹框提示自动重启已关闭", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port, env: { CORE_SELFHEAL: "0" } });
  await h.core.startCore();
  childOf(h, "dashboard.js").emit("exit", 1);

  assert.equal(h.timers.scheduled.length, 0);
  assert.ok(h.dialogs.some((d) => /意外退出/.test(d.message) && /CORE_SELFHEAL/.test(d.detail || "")));
  assert.equal(h.core.stats().selfHeal, false);
});

test("core: killAll 清掉待重启定时器并复位 pending", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  childOf(h, "dashboard.js").emit("exit", 1);
  assert.equal(h.core.stats().scripts["dashboard.js"].pending, true);

  h.core.killAll();
  assert.equal(h.core.stats().scripts["dashboard.js"].pending, false);
});

test("core: 待重启定时器触发 → 只补拉退出的脚本（幂等守卫跳过存活者）", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  const before = h.spawned.length;

  childOf(h, "dashboard.js").emit("exit", 1);
  h.timers.fireLast(); // 触发「自动重启中…」回调（它内部调 startCore，是异步的）

  // ★ 必须等这次 startCore 跑完再结束测试：它内部会轮询 portOpen，
  //   若测试先返回，t.after 会关掉监听端口 → 轮询等满 60s 才 reject（既拖慢又产生 unhandledRejection）。
  await new Promise((r) => setTimeout(r, 800));

  // ★ 2026-09-30 幂等守卫（#3328）：daemon 仍存活 → 只补拉 dashboard（改前无差别双拉 +2，
  //   生产里正是这一拉把活着的 dashboard/daemon 再开一份，酿成自愈风暴与重复实例）。
  assert.equal(h.spawned.length, before + 1, "只应补拉退出的 dashboard");
  assert.equal(h.spawned.at(-1).script, "dashboard.js");
  assert.ok(h.logs.some((l) => /daemon\.js 已在运行.*跳过重复拉起/.test(l)), "应记录 daemon 跳过重复拉起");
});

test("core: daemon 崩溃自愈只补拉 daemon，不重复拉起存活的 dashboard", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  const before = h.spawned.length; // 2

  childOf(h, "daemon.js").emit("exit", 1);
  h.timers.fireLast();
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(h.spawned.length, before + 1, "只应补拉 daemon");
  assert.equal(h.spawned.at(-1).script, "daemon.js");
  assert.ok(h.logs.some((l) => /dashboard\.js 已在运行.*跳过重复拉起/.test(l)), "应记录 dashboard 跳过重复拉起");
  assert.equal(h.core.stats().scripts["daemon.js"].pending, false, "自愈完成后不应残留待重启定时器");
});

test("core: restartCore 重启窗口内旧子进程退出不排自愈，新实例不重复", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  const h = makeCore({ port });
  await h.core.startCore();
  const oldDash = childOf(h, "dashboard.js");
  const oldDae = h.spawned.find((s) => s.script === "daemon.js").child;

  const p = h.core.restartCore(); // 同步段：杀旧 → 清册 → 拉新（随后挂起在就绪轮询）
  oldDash.emit("exit", 1);        // 旧子进程的 exit 在重启窗口内到达（spawnSync 阻塞事件循环的等价时序）
  oldDae.emit("exit", 1);
  await p;

  assert.equal(h.spawned.length, 4, "新旧各一份：旧 2 + 新 2");
  assert.equal(
    h.timers.scheduled.filter((x) => !h.timers.cleared.includes(x)).length,
    0,
    "重启窗口内的旧子进程退出不应排自愈定时器",
  );
  assert.equal(h.core.stats().scripts["dashboard.js"].restarts, 0, "重启窗口内不计数");
  assert.equal(h.core.stats().scripts["daemon.js"].restarts, 0);
  assert.ok(h.logs.some((l) => /主动重启中退出，不排自愈/.test(l)));
});

/* ★ 2026-10-15 核心发现协议（根治端口竞态/EADDRINUSE 重试 → 启动失败僵尸壳） */

/** 造一个带真实 dataDir（可写 core.json）的 core；fetchImpl 可替身（顶层传或 overrides） */
function makeCoreWithData({ port, env = {}, overrides = {}, fetchImpl } = {}) {
  return withEnv(env, () => {
    const spawned = [];
    const dialogs = [];
    const logs = [];
    const timers = fakeTimers();
    const core = createCore({
      nodeExe: () => "node",
      getKernel: () => "/kernel",
      dataDir: () => dataDir,
      readConfig: () => ({}),
      getPort: () => port,
      getToken: () => "tok",
      isQuitting: () => false,
      log: (...a) => logs.push(a.map(String).join(" ")),
      dialog: { showMessageBox: (o) => dialogs.push(o) },
      spawnImpl: (exe, args, opts) => {
        const child = fakeChild(9000 + spawned.length);
        spawned.push({ exe, args, opts, child, script: path.basename(String(args[0])) });
        return child;
      },
      spawnSyncImpl: () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      timers,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...overrides,
    });
    return { core, spawned, dialogs, logs, timers };
  });
}

test("core: discoverHealthyCore —— core.json 缺失/损坏 → null（回退 spawn 路径）", async (t) => {
  const h = makeCoreWithData({ fetchImpl: async () => ({ ok: true }) });
  assert.equal(await h.core.discoverHealthyCore(), null, "无 core.json → null");
  fs.writeFileSync(path.join(dataDir, "core.json"), "{ 坏 JSON", "utf8");
  assert.equal(await h.core.discoverHealthyCore(), null, "JSON 损坏 → null");
});

test("core: discoverHealthyCore —— pid 已退出（陈旧 core.json）→ null", async (t) => {
  const deadPid = 2147483646; // 几乎不可能存在的 pid：kill(pid,0) 必抛 ESRCH
  fs.writeFileSync(path.join(dataDir, "core.json"), JSON.stringify({ port: 8788, pid: deadPid, startedAt: "x" }), "utf8");
  const h = makeCoreWithData({ fetchImpl: async () => ({ ok: true }) });
  assert.equal(await h.core.discoverHealthyCore(), null, "pid 死 → null，不误判为可复用");
});

test("core: discoverHealthyCore —— health 非 200 / 无 token 不符 → null", async (t) => {
  fs.writeFileSync(path.join(dataDir, "core.json"), JSON.stringify({ port: 8788, pid: process.pid, startedAt: "x" }), "utf8");
  const h = makeCoreWithData({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(await h.core.discoverHealthyCore(), null, "health 非 200 → null");
  // fetch 抛异常（连接失败）→ 同样 null
  const h2 = makeCoreWithData({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await h2.core.discoverHealthyCore(), null, "连接失败 → null");
});

test("core: discoverHealthyCore —— pid 活 + health 200 → {port,pid}", async (t) => {
  fs.writeFileSync(path.join(dataDir, "core.json"), JSON.stringify({ port: 8788, pid: process.pid, startedAt: "x" }), "utf8");
  const seen = [];
  const h = makeCoreWithData({ fetchImpl: async (url, opts) => { seen.push([url, opts.headers["x-memory-token"]]); return { ok: true }; } });
  const r = await h.core.discoverHealthyCore();
  assert.deepEqual(r, { port: 8788, pid: process.pid });
  assert.equal(seen[0][0], "http://127.0.0.1:8788/api/health", "健康检查走本机 health 端点");
  assert.equal(seen[0][1], "tok", "带 token 鉴权（防 core.json 指向他人服务）");
});

test("core: startCore —— 发现健康核心则复用，不再 spawn（僵尸壳/端口竞态根治）", async (t) => {
  fs.writeFileSync(path.join(dataDir, "core.json"), JSON.stringify({ port: 8788, pid: process.pid, startedAt: "x" }), "utf8");
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());
  const h = makeCoreWithData({ port, fetchImpl: async () => ({ ok: true }) });
  await h.core.startCore();
  assert.equal(h.spawned.length, 0, "复用已有核心：不应 spawn 任何 dashboard/daemon");
  assert.ok(h.logs.some((l) => /发现已在服务的核心.*复用并跳过拉起/.test(l)), "应记录复用日志");
});

test("core: startCore —— 未发现核心时行为与改前一致（照旧 spawn）", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());
  const h = makeCoreWithData({ port, fetchImpl: async () => ({ ok: false }) }); // health 非 200 → 不复用
  await h.core.startCore();
  assert.deepEqual(h.spawned.map((s) => s.script).sort(), ["daemon.js", "dashboard.js"], "未命中发现协议 → 原 spawn 路径");
});

/* ================== 二、scheduler：调度锁与超时 ================== */

function makeSched({ env = {}, overrides = {} } = {}) {
  return withEnv(env, () => {
    const spawned = [];
    const logs = [];
    const timers = fakeTimers();
    const sched = createScheduler({
      nodeExe: () => "node",
      getKernel: () => path.resolve(__dirname, "..", "resources", "memoryos"),
      dataDir: () => "/data",
      log: (...a) => logs.push(a.map(String).join(" ")),
      getPort: () => 8787,
      getToken: () => "tok",
      spawnImpl: (exe, args, opts) => {
        const child = fakeChild(7000 + spawned.length);
        spawned.push({ exe, args, opts, child });
        return child;
      },
      timers,
      ...overrides,
    });
    return { sched, spawned, logs, timers };
  });
}

test("scheduler: 子进程运行期间重复调用被跳过（防重入）", async () => {
  const h = makeSched(); // ingest-cli.js 在真实内核目录中存在，故会真的走到 runChild

  await h.sched.runAutoIngest();
  assert.equal(h.spawned.length, 1, "首次应拉起子进程");
  assert.equal(h.sched.stats().locks["自动采集"].running, true);

  await h.sched.runAutoIngest();
  assert.equal(h.spawned.length, 1, "锁未释放时不应再拉起子进程");
  assert.ok(h.logs.some((l) => /上一轮仍在运行/.test(l)));
});

test("scheduler: 子进程退出后释放锁，可再次调度", async () => {
  const h = makeSched();

  await h.sched.runAutoIngest();
  h.spawned[0].child.emit("exit", 0);
  assert.equal(h.sched.stats().locks["自动采集"].running, false);

  await h.sched.runAutoIngest();
  assert.equal(h.spawned.length, 2);
});

test("scheduler: 锁超过 TTL 判为陈旧并接管（记录 takeovers）", async () => {
  // SCHED_LOCK_TTL_MIN 语义为分钟，此处取极小值把 TTL 压到 ~120ms，避免测试真的等 60 分钟
  const h = makeSched({ env: { SCHED_LOCK_TTL_MIN: 0.002 } });
  assert.ok(h.sched.stats().lockTtlMs < 1000, "TTL 应被压到亚秒级");

  await h.sched.runAutoIngest();
  assert.equal(h.sched.stats().locks["自动采集"].takeovers, 0);

  await new Promise((r) => setTimeout(r, 200)); // 让锁超过 TTL
  await h.sched.runAutoIngest();

  const lock = h.sched.stats().locks["自动采集"];
  assert.equal(lock.takeovers, 1, "陈旧锁应被接管");
  assert.ok(h.logs.some((l) => /判定陈旧并接管/.test(l)));
});

test("scheduler: 子进程超时 → 走杀树分支并记日志", async () => {
  const h = makeSched();

  await h.sched.runAutoIngest();
  const timeoutTimer = h.timers.scheduled.find((t) => !t.fired);
  assert.ok(timeoutTimer, "应为子进程排超时定时器");
  assert.equal(timeoutTimer.ms, h.sched.stats().childTimeoutMs);

  // 子进程 pid 用不存在的值，win32 下 killTree 的 taskkill 会静默失败、不影响测试
  timeoutTimer.fn();
  assert.ok(h.logs.some((l) => /子进程超时/.test(l)), "应记录超时并终止进程树");

  // 锁在子进程真正 exit 时释放（超时本身不直接释放）
  h.spawned[0].child.emit("exit", null);
  assert.equal(h.sched.stats().locks["自动采集"].running, false);
});

/* ======================== 三、port：端口探测 ======================== */

test("port: portOpen 对已监听端口为真、对空闲端口为假", async (t) => {
  const { server, port } = await listenEphemeral();
  t.after(() => server.close());

  assert.equal(await portOpen(port), true);

  const { server: s2, port: p2 } = await listenEphemeral();
  s2.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await portOpen(p2), false);
});

test("port: findFreePort 在 [start, start+20) 内返回空闲端口", async (t) => {
  // 基准端口必须选在 Windows 动态端口段（49152+）之外——那里 TIME_WAIT 密集，
  // 20 个连续端口可能真的全被占，会让测试变得脆弱。此处从 21000 起找一个可独占的端口。
  let server = null;
  let base = null;
  for (let b = 21000; b < 21500 && base === null; b++) {
    const s = net.createServer();
    const ok = await new Promise((r) => {
      s.once("error", () => r(false));
      s.listen(b, "127.0.0.1", () => r(true));
    });
    if (ok) { server = s; base = b; } else { try { s.close(); } catch { /* ignore */ } }
  }
  assert.ok(base, "未能在 21000-21499 找到可独占的基准端口");
  t.after(() => server.close());

  const p = await findFreePort(base);
  assert.ok(p > base && p < base + 20, `应跳过被占用的 ${base} 并落在 (${base}, ${base + 20})，实际 ${p}`);
  assert.equal(await portOpen(p), false, "返回的端口应是空闲的");
});

test("port: 连续 20 个端口全被占用时抛错", async (t) => {
  const servers = [];
  const base = 39000;
  for (let i = 0; i < 20; i++) {
    const s = net.createServer();
    s.on("error", () => { /* 该端口被系统占用则忽略，不影响断言 */ });
    s.listen(base + i, "127.0.0.1");
    servers.push(s);
  }
  t.after(() => servers.forEach((s) => { try { s.close(); } catch { /* ignore */ } }));

  await assert.rejects(() => findFreePort(base), /未找到可用端口/);
});

/* ==================== 四、updater：哈希（纯函数） ==================== */

test("updater: sha256Buf 对已知向量（abc → ba7816bf…）", () => {
  assert.equal(
    sha256Buf(Buffer.from("abc")).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("updater: sha256Buf 空输入为 e3b0c442…", () => {
  assert.equal(
    sha256Buf(Buffer.alloc(0)).toString("hex"),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("updater: sha256File 与 sha256Buf 对同一内容一致", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-shell-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const f = path.join(dir, "probe.txt");
  const content = "memoryos-shell-test-内容";
  fs.writeFileSync(f, content, "utf8");

  assert.equal(sha256File(f).toString("hex"), sha256Buf(Buffer.from(content, "utf8")).toString("hex"));
});