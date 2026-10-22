"use strict";
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { portOpen } = require("./port");

/**
 * 内核进程生命周期服务。
 * deps: { nodeExe, getKernel, dataDir, readConfig, getPort, getToken, isQuitting, log, dialog }
 *       可选注入（仅为可测性，生产不传）：spawnImpl、spawnSyncImpl、timers { setTimeout, clearTimeout }
 * 内部持有 coreChildren，暴露 startCore / restartCore / killAll（+ stats 供自愈观测/测试断言）。
 *
 * ★ P2-1（T12）内核自愈：原实现子进程意外退出**只弹框、不重启**（`exit` 回调里仅 dialog），
 *   内核一旦崩就静默变砖，用户必须手动退出应用再启动。本实现补自动重启：
 *   ① 指数退避（base × 2^(n-1)，封顶 maxDelayMs）避免崩溃风暴把 CPU 打满；
 *   ② 每个脚本独立计数 + 独立待重启定时器（同一脚本同一时刻只排一次）；
 *   ③ 健康度过阈值（默认存活 ≥60s）后计数归零——偶发崩溃不累积成"用光重启额度"；
 *   ④ 用尽额度仍失败则弹框告知（保留原有人工介入路径，不无限重启）；
 *   ⑤ 退出流程（isQuitting）不重启；restartCore/killAll 会清掉待重启定时器；
 *   ⑥ 幂等守卫（★ 2026-09-30，#3328 回归）：startCore 按脚本查自家存活子进程，活着就跳过——
 *      原实现在自愈定时器里无差别双拉（daemon 崩 → 把活着的 dashboard 也再拉一份 →
 *      EADDRINUSE 秒退 → 计数再+1 → 自愈风暴；daemon 无端口保护则直接常驻双开）；
 *      另设 restarting 重启窗口：主动重启（restartCore）杀出的旧子进程 exit 不再排自愈。
 * 关闭自愈：CORE_SELFHEAL=0（调试期避免反复拉起）。
 */
function createCore(deps) {
  const {
    nodeExe, getKernel, dataDir, readConfig, getPort, getToken, isQuitting, log, dialog,
    spawnImpl = spawn,
    spawnSyncImpl = spawnSync,
    timers = { setTimeout, clearTimeout },
  } = deps;

  const envInt = (k, d) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const SELFHEAL = process.env.CORE_SELFHEAL !== "0";
  const MAX_RESTARTS = envInt("CORE_MAX_RESTARTS", 5);         // 每个脚本的最大自动重启次数
  const BASE_DELAY_MS = envInt("CORE_RESTART_BASE_MS", 3000);  // 首次退避
  const MAX_DELAY_MS = envInt("CORE_RESTART_MAX_MS", 60000);   // 退避封顶
  const HEALTHY_MS = envInt("CORE_HEALTHY_MS", 60000);         // 存活超过此时长视为健康 → 计数归零

  let coreChildren = [];
  /** ★ 主动重启窗口（restartCore 同步段 → startCore 就绪）：期间被杀旧子进程的 exit 只做清理，不排自愈 */
  let restarting = false;
  /** script → { count, timer, startedAt, stopped } */
  const book = new Map();
  const entryOf = (script) => {
    if (!book.has(script)) book.set(script, { count: 0, timer: null, startedAt: 0 });
    return book.get(script);
  };
  const backoffOf = (n) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.max(0, n - 1)));

  function spawnCore(script, extraEnv) {
    const KERNEL = getKernel();
    const child = spawnImpl(nodeExe(), [path.join(KERNEL, "dist", script)], {
      cwd: KERNEL,
      env: {
        ...process.env,
        MEMORY_DB: path.join(dataDir(), "data", "memory.db"),
        MEMORY_PORT: String(getPort()),
        EMBED_MODE: "local",
        EMBED_CACHE_DIR: path.join(KERNEL, "models"),
        MEMORYOS_SERVER: path.join(KERNEL, "dist", "server.js"),
        MEMORY_TOKEN: getToken(),
        ...(extraEnv || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const e = entryOf(script);
    e.startedAt = Date.now();
    e.stopped = false;
    child.stdout.on("data", (d) => log(`[${script}]`, String(d).trimEnd()));
    // ★ #4429：缓冲 stderr 尾部供 exit 判定 EADDRINUSE（截 8KB 防长日志累积）
    let errTail = "";
    child.stderr.on("data", (d) => {
      const s = String(d);
      log(`[${script}][err]`, s.trimEnd());
      errTail = (errTail + s).slice(-8192);
    });
    child.__script = script; // 幂等守卫查找用（startCore 自愈路径按脚本判定存活）
    child.on("exit", (code) => {
      const uptime = Date.now() - e.startedAt;
      log(`${script} 退出（code=${code}，存活 ${Math.round(uptime / 1000)}s）`);
      coreChildren = coreChildren.filter((c) => c !== child);
      if (isQuitting()) return;                       // 正常退出流程：不重启、不弹框
      if (restarting) {                               // ★ 主动重启窗口：新实例已由 restartCore 拉起，旧子进程退出不排自愈
        log(`${script} 主动重启中退出，不排自愈`);
        return;
      }
      // ★ #4429 EADDRINUSE 隔离：dashboard 抢端口失败 = 已有实例在服务，非自身故障 →
      //   不计入 MAX_RESTARTS 额度（防『占端口 → 秒退 → 计数 → 重拉』反馈循环把额度打光）；
      //   按封顶间隔做轻量重试：每次仅一个秒退进程（零风暴），且占端口的孤儿退出后能自动接管。
      if (SELFHEAL && script === "dashboard.js" && /EADDRINUSE/.test(errTail)) {
        log(`${script} 端口已被占用（EADDRINUSE，已有实例在服务）：不计入自愈额度，按 ${MAX_DELAY_MS}ms 间隔轻量重试`);
        if (e.timer) timers.clearTimeout(e.timer);       // 同脚本只排一次
        e.timer = timers.setTimeout(() => {
          e.timer = null;
          if (isQuitting()) return;
          log(`${script} 端口占用重试中…`);
          try { startCore(); } catch (err) { log(`${script} 端口占用重试失败: ${err.message || err}`); }
        }, MAX_DELAY_MS);
        return;
      }
      if (uptime >= HEALTHY_MS) e.count = 0;          // 健康存活过 → 额度重置
      if (!SELFHEAL || !isRestorable(script)) {
        dialog.showMessageBox({
          type: "error", title: "MemoryOS",
          message: `核心服务（${script}）意外退出（code=${code}）。`,
          detail: SELFHEAL ? "该服务不参与自动拉起，请重启应用。" : "自动重启已关闭（CORE_SELFHEAL=0），请手动重启应用。",
        });
        return;
      }
      if (e.count >= MAX_RESTARTS) {
        dialog.showMessageBox({
          type: "error", title: "MemoryOS",
          message: `核心服务（${script}）连续失败 ${e.count} 次，已停止自动重启。`,
          detail: "请查看日志定位原因后重启应用（避免无限重启刷屏）。",
        });
        return;
      }
      e.count += 1;
      const delay = backoffOf(e.count);
      log(`${script} 将在 ${delay}ms 后自动重启（第 ${e.count}/${MAX_RESTARTS} 次）`);
      if (e.timer) timers.clearTimeout(e.timer);       // 同脚本只排一次
      e.timer = timers.setTimeout(() => {
        e.timer = null;
        if (isQuitting()) return;
        log(`${script} 自动重启中…`);
        try { startCore(); } catch (err) { log(`${script} 自动重启失败: ${err.message || err}`); }
      }, delay);
    });
    coreChildren.push(child);
    return child;
  }

  /** 参与自愈的脚本：dashboard 是 HTTP 服务面（崩了必须拉）；daemon 是治理任务（崩了也拉）。 */
  function isRestorable(script) {
    return script === "dashboard.js" || script === "daemon.js";
  }

  function clearTimers() {
    for (const e of book.values()) {
      if (e.timer) { timers.clearTimeout(e.timer); e.timer = null; }
    }
  }

  /**
   * ★ ⑥ 幂等守卫（#3328）：该脚本已有存活的自家子进程则跳过重复拉起。
   * coreChildren 在子进程 exit 时即被剔除 → 数组里存在即活着。
   * 这是自愈路径（exit → 定时器 → startCore）与重启路径的共用闸门：
   * daemon 崩时不再把活着的 dashboard 也拉一份（EADDRINUSE 秒退 → 自愈风暴），
   * 反之 daemon 因无端口保护也不会被二次拉起常驻双开。
   */
  function spawnUnlessAlive(script, extraEnv) {
    const alive = coreChildren.find((c) => c.__script === script);
    if (alive) {
      log(`${script} 已在运行（pid=${alive.pid}），跳过重复拉起`);
      return false;
    }
    spawnCore(script, extraEnv);
    return true;
  }

  /**
   * ★ 2026-10-15 核心发现协议（根治端口竞态 + 重复拉起 → 僵尸壳）：
   *   dashboard 1a 批已在 listen 成功后写 `core.json {port,pid,startedAt}`。
   *   落点口径：内核 writeCoreJson 的 dataDirOf() 对 MEMORY_DB（…/MemoryOS/data/memory.db）
   *   去两层 = `…/MemoryOS`（与壳层 dataDir 同根，config.json 同目录）——故本函数读
   *   `dataDir()/core.json`。
   *   三项校验：① 文件可解析且 port/pid 齐全；② pid 存活（kill 0）；③ 该端口
   *   `/api/health` 带 `x-memory-token` 返回 200（防 pid 撞号/陈旧 core.json 指向他人
   *   服务——token 不对即非本机核心）。三项全过 → 复用该核心，跳过 spawn。
   *   任一项失败 → 返回 null，调用方回退原 spawn 路径（行为不劣于改前）。
   *   注入缝：fetchImpl（测试替身；生产缺省 globalThis.fetch）。
   */
  async function discoverHealthyCore() {
    try {
      const raw = fs.readFileSync(path.join(dataDir(), "core.json"), "utf8");
      const j = JSON.parse(raw);
      if (!j || !Number(j.port) || !Number(j.pid))
        return null;
      try {
        process.kill(Number(j.pid), 0); // 存活探针（不真杀）
      }
      catch {
        return null; // pid 已退出 → 陈旧 core.json
      }
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      const res = await fetchImpl(`http://127.0.0.1:${Number(j.port)}/api/health`, {
        headers: { "x-memory-token": getToken() },
        signal: AbortSignal.timeout(2000),
      });
      if (!res || res.ok !== true)
        return null;
      return { port: Number(j.port), pid: Number(j.pid) };
    }
    catch {
      return null; // 文件不存在/JSON 坏/网络失败 → 一律回退 spawn
    }
  }

  async function startCore() {
    const cfg = readConfig() || {};
    log(`启动内核（端口 ${getPort()}）…`);
    // ★ 2026-10-15：核心发现协议——已有健康核心在服务则复用（不再 spawn 自己那份）。
    //   根治：多壳/桌面工具重复拉起时 findFreePort 探测空窗 → 各自 spawn →
    //   EADDRINUSE 秒退 → 60s 重试循环 → 极端下 startCore 超时 → quit 挂起僵尸壳。
    const healthy = await discoverHealthyCore();
    if (healthy) {
      log(`发现已在服务的核心（pid=${healthy.pid} port=${healthy.port}），复用并跳过拉起`);
      return;
    }
    const llmEnv = {};
    if (cfg.llmUrl) {
      llmEnv.MIMOS_URL = cfg.llmUrl;
      if (cfg.llmModel) llmEnv.INGEST_MODEL = cfg.llmModel;
      if (cfg.llmKey) llmEnv.INGEST_KEY = cfg.llmKey;
    }
    // 受限模式：桌面版默认关闭（MEMORY_RESTRICTED=0）——用户可在「笔记」页自建笔记、
    // 在任务看板建卡。若 config.json 显式写 "restricted": true，则恢复「仅系统采集」。
    llmEnv.MEMORY_RESTRICTED = cfg.restricted === true ? "1" : "0";
    // 执行工具面（P0）：开启后 server.js 向 agent 暴露 file_read/file_write/exec_run（工具面 22→25）。
    // 安全双保险：① file_write/exec_run 带 ⟨risk:L1|gate:required⟩ 前缀，agent-core writeGate 拦截
    //   （受限模式下 allowWrites=false ⇒ 写门禁一律拒绝，agent 只能调只读 file_read）；
    //   ② 无头 --work 模式执行类 L1 不在 HEADLESS_PREAUTHORIZED 白名单（方案 c），仍需审批。
    // 兜底熔断：进程环境置 MEMORYOS_EXEC_OFF=1 可全局禁用（优先级最高）。
    // 遗留（P1）：执行工具未纳入 B3 受限能力位（RESTRICTED 下按能力位隐藏 exec）。
    // ★ 2026-10-14（发布默认收口）：原实现**无条件**写 "1"，与本仓既定决策相反 ——
    //   server.js:157、README:76、docs/P1-实施与验证记录-20260915.md（提交 7b167e7）均明写
    //   「P0-2 用户拍板决策 1(a)：**默认关闭执行面**，显式 MEMORYOS_EXEC_ON=1 才启用」。
    //   改为 **缺省=关**：对齐该决策与全局 fail-closed 惯例，也让新成员开箱不带执行能力。
    //   仅 config.json 显式 `execOn: true` 才注入 "1"；用户可在「设置 → 安全 → Agent 执行能力」
    //   即时切换（该开关持久化，dashboard 启动时按同一 config 值回填 MCP 子进程 env）。
    llmEnv.MEMORYOS_EXEC_ON = cfg.execOn === true ? "1" : "0";
    spawnUnlessAlive("dashboard.js", llmEnv);
    // ★ P1-perf（B6′）嵌入侧车收敛：daemon 不再进程内驻留 560MB BGE-M3，改经 dashboard
    //   常驻的 /v1/embeddings（OpenAI 兼容，Bearer=MEMORY_TOKEN）复用同一份模型；
    //   dashboard 不可用时 reembed 失败仅记日志（daemon 小时级自愈重跑），零功能改动。
    spawnUnlessAlive("daemon.js", {
      ...llmEnv,
      EMBED_MODE: "api",
      EMBED_API_URL: `http://127.0.0.1:${getPort()}/v1/embeddings`,
      EMBED_API_KEY: getToken(),
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 400));
      if (await portOpen(getPort())) return;          // ← 注意：portOpen(port)，先取值再传（曾误传函数导致 ERR_INVALID_ARG_TYPE）
      if (isQuitting()) throw new Error("启动过程中应用已退出");
    }
    throw new Error("内核 60s 未就绪，请查看日志");
  }

  function restartCore() {
    clearTimers();                                  // 主动重启时作废待执行的自愈
    restarting = true;                              // ★ 窗口开启：随后杀出的旧子进程 exit 不排自愈（否则新实例就绪后旧定时器复活 → 重复拉起）
    for (const c of coreChildren) {
      try {
        if (process.platform === "win32") spawnSyncImpl("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* 已退出 */ }
    }
    coreChildren = [];
    for (const e of book.values()) e.count = 0;      // 主动重启视为人工复位
    return startCore()
      .then(() => log("内核已重启（热更新生效）"))
      .finally(() => { restarting = false; });
  }

  function killAll() {
    clearTimers();
    for (const c of coreChildren) {
      try {
        if (process.platform === "win32") spawnSyncImpl("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* 已退出 */ }
    }
    coreChildren = [];
  }

  /** 观测/测试用：当前各脚本的重启计数与是否有待重启定时器 */
  function stats() {
    const out = {};
    for (const [k, v] of book.entries()) out[k] = { restarts: v.count, pending: !!v.timer };
    return { selfHeal: SELFHEAL, maxRestarts: MAX_RESTARTS, baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS, scripts: out };
  }

  return { startCore, restartCore, killAll, discoverHealthyCore, stats };
}

module.exports = { createCore };
