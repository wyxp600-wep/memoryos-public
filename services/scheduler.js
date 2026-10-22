"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

/**
 * 周期调度服务：共享记忆同步 + 自动增量采集。
 * deps: { nodeExe, getKernel, dataDir, log }
 *       可选注入（仅为可测性，生产不传）：spawnImpl、timers { setTimeout, clearTimeout }
 *
 * ★ P2-1（T12）调度锁超时：原实现用 `__syncing` / `__ingesting` 两个布尔量防重入，
 *   **只在下游子进程 exit 时复位** —— 一旦子进程 hang（LLM 无响应 / SQLite 锁等待 / 网络挂起），
 *   布尔量永不释放，该调度从此静默停摆（现象＝"同步不再跑"但日志无异常），属难排查的静默失效。
 *   本实现两点补强：
 *   ① **陈旧锁自动接管**：锁超 TTL（默认 60min）视为陈旧，记 warn 后接管继续跑（宁可重复一次也不永久停摆）；
 *   ② **子进程超时杀树**：超时（默认 45min）用 taskkill /T /F（Windows）或 SIGKILL 组（POSIX）终止，
 *      并在 finally 语义路径上释放锁 —— 保证"任何分支都会解锁"。
 * 关闭/调参：SCHED_LOCK_TTL_MIN、SCHED_CHILD_TIMEOUT_MIN。
 */
function createScheduler(deps) {
  const { nodeExe, getKernel, dataDir, log, getPort, getToken, spawnImpl = spawn, timers = { setTimeout, clearTimeout } } = deps;

  const envInt = (k, d) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const LOCK_TTL_MS = envInt("SCHED_LOCK_TTL_MIN", 60) * 60 * 1000;
  const CHILD_TIMEOUT_MS = envInt("SCHED_CHILD_TIMEOUT_MIN", 45) * 60 * 1000;

  /** 带 TTL 的防重入锁；返回 true = 拿到（含陈旧锁接管），false = 本轮跳过 */
  const locks = new Map();
  function acquire(key) {
    const l = locks.get(key) ?? { running: false, since: 0, takeovers: 0 };
    locks.set(key, l);
    const now = Date.now();
    if (!l.running) { l.running = true; l.since = now; return true; }
    const held = now - l.since;
    if (held > LOCK_TTL_MS) {
      l.takeovers += 1;
      log(`⚠ ${key} 锁已持有 ${Math.round(held / 1000)}s（>TTL ${Math.round(LOCK_TTL_MS / 1000)}s）——判定陈旧并接管（第 ${l.takeovers} 次）`);
      l.since = now;
      return true;
    }
    log(`${key} 上一轮仍在运行（已 ${Math.round(held / 1000)}s），本轮跳过`);
    return false;
  }
  const release = (key) => { const l = locks.get(key); if (l) l.running = false; };

  /** 杀整棵进程树（与 services/core-process.js 既有模式一致） */
  function killTree(child) {
    try {
      if (process.platform === "win32") {
        if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    } catch { /* 已退出 */ }
  }

  /** 统一跑一个子进程：采集输出 + 超时杀树 + 保证释放锁 */
  function runChild({ key, script, args, cwd, env, onDone }) {
    let child;
    let timer = null;
    let settled = false;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      if (timer) timers.clearTimeout(timer);
      release(key);
      try { onDone(code, timedOut); } catch (e) { log(`${key} 收尾异常:`, String(e.message || e)); }
    };
    try {
      child = spawnImpl(nodeExe(), [script, ...(args ?? [])], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      release(key);
      log(`${key} 启动失败:`, String(e.message || e));
      return null;
    }
    let out = "";
    let timedOutFlag = false;
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("error", (e) => { log(`${key} 启动失败:`, e.message); finish(null, false); });
    timer = timers.setTimeout(() => {
      log(`⚠ ${key} 子进程超时（>${Math.round(CHILD_TIMEOUT_MS / 1000)}s）——终止进程树并释放锁`);
      timedOutFlag = true;
      killTree(child);
    }, CHILD_TIMEOUT_MS);
    child.on("exit", (code) => finish(code, timedOutFlag));
    return { child, output: () => out };
  }

  /* ---------- 自动增量采集 ---------- */
  async function runAutoIngest() {
    if (!acquire("自动采集")) return;
    let holder = null;
    try {
      const KERNEL = getKernel();
      const script = path.join(KERNEL, "dist", "ingest-cli.js");
      if (!fs.existsSync(script)) { log("自动采集：ingest-cli.js 不存在，跳过"); release("自动采集"); return; }
      holder = runChild({
        key: "自动采集", script, args: ["--incremental"], cwd: KERNEL,
        env: { ...process.env, MEMORY_DB: path.join(dataDir(), "data", "memory.db"), EMBED_MODE: "api", EMBED_API_URL: `http://127.0.0.1:${getPort()}/v1/embeddings`, EMBED_API_KEY: getToken() },
        onDone: (code, timedOut) => {
          const out = holder?.output() ?? "";
          const brief = out.trimEnd().split("\n").filter((l) => l.includes("[ingest")).pop() || "";
          log("自动采集", timedOut ? "超时终止" : code === 0 ? "完成" : `退出码 ${code}`, brief);
        },
      });
      if (!holder) release("自动采集");
    } catch (e) {
      log("自动采集异常:", String(e.message || e));
      release("自动采集");
    }
  }
  function scheduleAutoIngest() {
    const min = Math.max(1, Number(process.env.INGEST_INTERVAL_MIN ?? 5) || 5);
    setTimeout(runAutoIngest, 90 * 1000);
    setInterval(runAutoIngest, min * 60 * 1000);
    log(`自动采集已调度：每 ${min} 分钟增量一次（INGEST_INTERVAL_MIN 可调）`);
  }

  /** 观测/测试用 */
  function stats() {
    const out = {};
    for (const [k, v] of locks.entries()) out[k] = { running: v.running, heldMs: v.running ? Date.now() - v.since : 0, takeovers: v.takeovers };
    return { lockTtlMs: LOCK_TTL_MS, childTimeoutMs: CHILD_TIMEOUT_MS, locks: out };
  }

  return { scheduleAutoIngest, runAutoIngest, stats };
}

module.exports = { createScheduler };
