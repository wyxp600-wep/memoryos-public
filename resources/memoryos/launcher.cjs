#!/usr/bin/env node
/**
 * MemoryOS 启动器 — 便携包入口（单文件 exe 目标，SEA 打包；CJS 版兼容 SEA 入口）
 *
 * 功能：
 *   1. 端口检测：8787 已在运行 → 仅打开浏览器
 *   2. 热更新：检测 update/new/ 目录（新版应用），合并覆盖到包根并备份旧版
 *   3. 启动 Dashboard：spawn runtime/node.exe dist/dashboard.js（注入 MEMORY_DB / EMBED_MODE / EMBED_CACHE_DIR）
 *   4. 打开浏览器 + 常驻 console（关闭窗口 = 停止服务）
 *   5. --stop：停止运行中的服务
 */
"use strict";
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");

// ROOT = 本文件所在目录（SEA 打包后与 exe 同目录 = 包根）
const ROOT = __dirname;
const PORT = Number(process.env.MEMORY_PORT || 8787);
const URL = "http://127.0.0.1:" + PORT;
const NODE = path.join(ROOT, "runtime", "node.exe");
const VERSION_FILE = path.join(ROOT, "version.json");

function log(...a) {
  console.log("[MemoryOS] " + new Date().toLocaleString("zh-CN"), ...a);
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  } catch {
    return { version: "0.1.0", built: "unknown" };
  }
}

/** 端口是否已监听 */
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.setTimeout(timeout);
  });
}

/** 打开默认浏览器 */
function openBrowser() {
  const cmd = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", URL] : [URL];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** 热更新：update/new/ 存在则合并覆盖包根，旧 dist/ui 备份到 data/backup/update-<ts>/ */
function applyUpdate() {
  const upd = path.join(ROOT, "update", "new");
  if (!fs.existsSync(upd)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bakRoot = path.join(ROOT, "data", "backup", "update-" + ts);
  log("检测到 update/new/，开始应用更新…");
  const moved = [];
  for (const name of ["dist", "memoryos-dashboard-redesign", "node_modules", "package.json"]) {
    const s = path.join(upd, name);
    const d = path.join(ROOT, name);
    if (!fs.existsSync(s)) continue;
    if (fs.existsSync(d)) {
      fs.mkdirSync(bakRoot, { recursive: true });
      fs.renameSync(d, path.join(bakRoot, name)); // 备份旧版（避免半覆盖）
      moved.push("备份 " + name + " → data/backup/update-" + ts + "/");
    }
    fs.cpSync(s, d, { recursive: true });
  }
  const v = readVersion();
  v.built = new Date().toISOString();
  v.applied = ts;
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2), "utf8");
  fs.rmSync(upd, { recursive: true, force: true });
  return moved.length ? moved : "已应用（update/new 内容与当前一致）";
}

/** 停止服务 */
function stopService() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ' + PORT + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess"',
      { encoding: "utf8" },
    ).trim();
    const pids = out.split(/\s+/).filter((p) => /^\d+$/.test(p));
    for (const pid of pids) {
      execSync("taskkill /PID " + pid + " /F /T", { stdio: "ignore" });
      log("已停止 PID " + pid);
    }
    if (!pids.length) log("未发现运行中的服务");
  } catch (e) {
    log("停止失败:", e.message);
  }
}

async function main() {
  if (process.argv.includes("--stop")) {
    stopService();
    return;
  }

  log("版本 " + readVersion().version + "，根目录 " + ROOT);

  // ① 端口检测
  if (await portOpen(PORT)) {
    log("服务已在运行（" + URL + "），直接打开浏览器。如需停止：" + path.basename(process.execPath) + " --stop");
    openBrowser();
    return;
  }

  // ② 热更新
  const updRes = applyUpdate();
  if (updRes) log(Array.isArray(updRes) ? updRes.join("\n") : updRes);

  // ③ 启动 Dashboard
  if (!fs.existsSync(NODE)) {
    log("未找到 runtime/node.exe，无法启动服务。请确认便携包完整。");
    return;
  }
  log("启动 Dashboard 服务…");
  const child = spawn(NODE, ["dist/dashboard.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MEMORY_DB: path.join(ROOT, "data", "memory.db"),
      MEMORY_PORT: String(PORT),
      EMBED_MODE: "local",
      EMBED_CACHE_DIR: path.join(ROOT, "models"),
      MEMORY_RESTRICTED: process.env.MEMORY_RESTRICTED ?? "0",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  child.stdout.on("data", (d) => process.stdout.write("[dashboard] " + d));
  child.stderr.on("data", (d) => process.stdout.write("[dashboard] " + d));
  child.on("exit", (code) => {
    log("Dashboard 服务已退出（code=" + code + "）。");
    process.exit(0);
  });

  // ④ 等待就绪后开浏览器
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 400));
    if (await portOpen(PORT)) {
      log("就绪 " + URL + "，打开浏览器。关闭本窗口即停止服务。");
      openBrowser();
      break;
    }
  }
}

main().catch((e) => {
  console.error("[MemoryOS] 启动失败:", e);
  process.exit(1);
});
