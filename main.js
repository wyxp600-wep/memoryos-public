/**
 * MemoryOS 桌面版 — Electron 主进程（编排层，main < 150 行目标达成）
 *
 * 只做编排；细粒度逻辑已下沉：
 *   services/port.js         — findFreePort(8787-8806)
 *   services/updater.js      — 自研增量热更新（sha256 + 备份覆盖 + 重启内核）
 *   services/scheduler.js    — 共享记忆同步 + 自动采集 周期调度
 *   services/core-process.js — 内核进程 spawn/restart/kill
 *   security/token.js        — 本机访问令牌生成/存储/轮换
 *   security/ipc.js          — IPC 注册 + event.sender 校验
 *   window/*.js              — 主窗口 / 首次配置窗 / 托盘
 *   app/lifecycle.js         — 单实例 / 生命周期 / 未捕获异常
 */
"use strict";
const { app, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Windows 11 托盘图标注册：setAppUserModelId 必须在 app.ready 之前调用
// ★ 2026-10-10 诊断：自定义 AUMID 无开始菜单快捷方式背书时，Win11 会吞掉托盘注册与通知（getBounds 恒 0 实证）。
//   暂时撤掉做 A/B 验证；若图标恢复，改走「快捷方式+AUMID」正解或保持默认。
// if (process.platform === "win32") app.setAppUserModelId("com.memoryos.desktop");

const { findFreePort } = require("./services/port");
const token = require("./security/token");
const { makeUpdater } = require("./services/updater");
const { createScheduler } = require("./services/scheduler");
const { createCore } = require("./services/core-process");
const { registerIpc } = require("./security/ipc");
const win = require("./window/main-window");
const welcome = require("./window/welcome-window");
const traySvc = require("./window/tray");
const { createLifecycle } = require("./app/lifecycle");

/* ---------- 路径 ---------- */
function kernelDir() {
  const dev = path.resolve(__dirname, "release", "memoryos");
  if (fs.existsSync(path.join(dev, "runtime", "node.exe"))) return dev;
  return path.join(process.resourcesPath, "memoryos");
}
let KERNEL = null;
function nodeExe() {
  return path.join(KERNEL, "runtime", "node.exe");
}
function dataDir() {
  if (process.env.MEMORYOS_DATA_DIR) return process.env.MEMORYOS_DATA_DIR;
  return path.join(app.getPath("appData"), "MemoryOS");
}
function configFile() {
  return path.join(dataDir(), "config.json");
}
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return null;
  }
}
function readReleaseSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "release-settings.json"), "utf8"));
  } catch {
    return {};
  }
}

/* 托盘图标：app.asar 内路径不能被 nativeImage.createFromPath 直接读取，
   首次启动先拷贝到数据目录真实路径，返回真实文件路径 */
function ensureTrayIconPath() {
  const src = path.join(__dirname, "assets", "tray.png");
  const dir = path.join(dataDir(), "assets");
  const target = path.join(dir, "tray.png");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, target);
  } catch (e) {
    log("托盘图标落盘失败，回退 asar 内路径:", e.message || String(e));
    return src;
  }
  return target;
}

/* ---------- 状态 ---------- */
let quitting = false;
let port = 0;
let TOKEN = "";

function log(...a) {
  const line = `[MemoryOS-Desktop] ${new Date().toLocaleString("zh-CN")} ` +
    a.map((x) => (x instanceof Error ? (x.stack || x.message) : (typeof x === "string" ? x : JSON.stringify(x)))).join(" ");
  console.log(line);
  // P0-4：日志落盘（%APPDATA%\MemoryOS\logs\desktop.log），黑屏/托盘异常时可回查启动时序
  try {
    const dir = path.join(dataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "desktop.log"), line + "\n", "utf8");
  } catch { /* 日志落盘失败不影响主流程 */ }
}

async function restartMcp() {
  // ★ 2026-09-25 P0⑥：原用 execFileSync **同步**等待子进程 —— 点「重启 MCP」时 Electron 主进程被堵住，
  //   UI 冻结；且 taskkill 未带 /T，node 子进程树里的孤儿会残留。改异步 execFile（事件循环不被堵）
  //   + /T 杀整树。调用方（托盘菜单）不 await，保持点击即返回。
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout: out } = await execFileAsync("wmic",
      ["process", "where", "name='node.exe' and commandline like '%dist%server.js%'", "get", "processid"],
      { encoding: "utf8", windowsHide: true });
    const pids = (out.match(/\d+/g) || []).filter((n) => n !== String(process.pid));
    if (!pids.length) {
      log("重启 MCP：当前无运行中的 MCP server 进程");
      dialog.showMessageBox({ type: "info", title: "MemoryOS",
        message: "当前没有运行中的 MCP server 进程，无需重启。" });
      return;
    }
    for (const pid of pids) {
      try { await execFileAsync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* 已退出 */ } // /T：连子进程树一起杀，避免孤儿残留
    }
    log("重启 MCP：已终止 " + pids.length + " 个 server 进程（" + pids.join(",") + "）");
    dialog.showMessageBox({ type: "info", title: "MemoryOS",
      message: "已重启 MCP server（" + pids.length + " 个）。请在 IDE 的 MCP 面板点击重连以重新加载。" });
  } catch (e) {
    const msg = e && (e.message || String(e));
    log("重启 MCP 失败:", msg);
    dialog.showMessageBox({ type: "error", title: "MemoryOS", message: "重启 MCP 失败：\n" + msg });
  }
}

/* ---------- 服务装配 ---------- */
const core = createCore({
  nodeExe, getKernel: () => KERNEL, dataDir, readConfig,
  getPort: () => port, getToken: () => TOKEN, isQuitting: () => quitting, log, dialog,
});
const updater = makeUpdater({
  readConfig, readReleaseSettings,
  readVersion: () => {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(KERNEL, "version.json"), "utf8"));
      return String(v.version || "0.1.0");
    } catch { return "0.1.0"; }
  },
  getKernel: () => KERNEL, dataDir, restartCore: () => core.restartCore(), log,
});
const sched = createScheduler({ nodeExe, getKernel: () => KERNEL, dataDir, log, getPort: () => port, getToken: () => TOKEN });

async function runUpdateCheck() {
  const r = await updater.applyKernelUpdate();
  let opts;
  if (r.status === "disabled") {
    opts = { message: "更新未配置", detail: `当前版本 ${r.current}。未设置更新源，由管理员在发布配置中预置后成员端零配置生效。`, buttons: ["确定"] };
  } else if (r.status === "none") {
    opts = { message: "已是最新版本", detail: `当前版本 ${r.current}。`, buttons: ["确定"] };
  } else if (r.status === "applied") {
    let restarted = true;
    if (r.applied > 0 || r.restartPending) restarted = await updater.restartAfterUpdate(r);
    opts = { message: `已更新到 ${r.latest}`, detail: `当前版本 ${r.current} → ${r.latest}，${r.applied} 个文件。${restarted ? "" : "\n⚠ 内核重启失败：版本号未落，下次检查更新将自动补重启。"}`, buttons: ["确定"] };
  } else {
    opts = { message: "检查更新失败", detail: `当前版本 ${r.current}\n原因：${r.error || "未知"}`, buttons: ["确定"] };
  }
  dialog.showMessageBox({ title: "MemoryOS 更新", type: "question", noLink: true, ...opts });
}

/* ---------- 启动编排 ---------- */
async function finalizeStartup(cfg) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(path.join(dataDir(), "data"), { recursive: true });

  // readVersion 供 updater 用
  TOKEN = token.ensureToken();
  log(`访问令牌就绪（${TOKEN.slice(0, 6)}…，见 data/token）`);
  log(`运行时版本: electron=${process.versions.electron} chrome=${process.versions.chrome}`);
  // ★ 2026-10-15 核心发现协议（必须在 TOKEN 就绪**之后**）：health 校验带 MEMORY_TOKEN，
  //   TOKEN 未初始化时必然 401 误判 null——lifecycle 层 discover 曾因此在 TOKEN 前调用，
  //   端口走了 findFreePort（8789）而复用核心在 8788 → 窗口 ERR_CONNECTION_REFUSED 60s
  //   直至兜底错误页（c5a27c9 的实测事故）。故 discover 归位到此，命中即覆盖端口。
  {
    const discovered = await core.discoverHealthyCore();
    if (discovered) {
      port = discovered.port;
      log(`复用已在服务的核心（pid=${discovered.pid} port=${discovered.port}），端口已指向它`);
    }
  }
  if (!readConfig()) {
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), "utf8");
    log("已写入配置:", cfg.llmUrl ? `LLM=${cfg.llmUrl}` : "LLM 提炼：未配置（跳过）");
  }
  // ★ 托盘提前：先建托盘/窗口让 Windows 及时注册图标，再 await startCore()。
  //   原来的顺序（startCore → createMainWindow → createTray）在 gram 回填等启动耗时超过约 3s 时，
  //   Windows 11 会把来不及注册的托盘图标静默丢弃，导致托盘图标始终不出现。
  win.prepareMainWindow({ port, TOKEN, shell, isQuitting: () => quitting });
  win.createMainWindow();
  const trayOpts = {
    shell, port, TOKEN, log, trayIconPath: ensureTrayIconPath(),
    onShowMain: () => win.showMain(),
    onUpdateCheck: () => runUpdateCheck(),
    onRestartCore: () => { core.restartCore().catch((e) => log("重启内核失败", e.message || String(e))); },
    onRestartMcp: () => { restartMcp().catch((e) => log("重启 MCP 失败", (e && (e.message || String(e))) || "unknown")); },
    onQuit: () => { quitting = true; app.quit(); },
  };
  // P0-4 托盘兜底：创建失败不再静默吞掉，记录日志并延迟重试一次
  try {
    traySvc.createTray(trayOpts);
    log("托盘图标已注册");
  } catch (e) {
    log("托盘创建失败，5 秒后重试一次:", e instanceof Error ? e.message : String(e));
    setTimeout(() => {
      try {
        traySvc.createTray(trayOpts);
        log("托盘重试创建成功");
      } catch (e2) {
        log("托盘重试仍失败:", e2 instanceof Error ? e2.message : String(e2));
      }
    }, 5000);
  }
  try {
    await core.startCore();
  } catch (e) {
    // ★ 2026-10-15：失败路径必须**干净退出**——原 app.quit() 在托盘常驻语义
    //   （window-all-closed 空实现）下会挂起，残留无窗口/1MB 僵尸壳（19:21 实例实证）。
    //   改 app.exit(1)：先弹框告知，再强清整个进程（含所有子进程）。
    dialog.showMessageBox({ type: "error", title: "MemoryOS", message: String(e.message || e) });
    app.exit(1);
    return;
  }
  log("内核启动完成，通知主窗口加载页面");
  win.notifyCoreReady();
  sched.scheduleAutoIngest();
  updater.auto();
}

/* ---------- IPC（sender 校验在 security/ipc.js） ---------- */
registerIpc({
  getWelcomeWin: () => welcome.getWelcomeWindow(),
  onSaveConfig: (cfg) => {
    welcome.closeWelcomeWindow();
    finalizeStartup(cfg);
  },
});

/* ---------- 应用生命周期 ---------- */
const createWelcome = () =>
  welcome.createWelcomeWindow({ readConfig, finalizeStartup, preloadPath: path.join(__dirname, "preload.js") });

createLifecycle({
  kernelDir, nodeExe, findFreePort, readConfig, finalizeStartup, createWelcome,
  showMain: () => win.showMain(),
  setKernel: (k) => { KERNEL = k; },
  setPort: (p) => { port = p; },
  setQuitting: (v) => { quitting = v; },
  killChildren: () => core.killAll(),
  log,
});