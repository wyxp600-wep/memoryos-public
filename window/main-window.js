"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { BrowserWindow, session, ipcMain, nativeTheme, app } = require("electron");

/** 主窗口管理（自持 mainWin 与一次性配置） */
let mainWin = null;
let cfg = { port: 0, TOKEN: "", shell: null };

/* P0-4 黑屏根治：内核 startCore 就绪前 loadURL 会连接失败（8787 未监听），
   且原实现无任何重试 → 窗口永久停在 backgroundColor 底漆色（纯黑屏）。
   这里加失败自动重试 + 内核就绪即时加载 + 兜底错误页。 */
let loadAttempts = 0;
let loadTimer = null;
let pageLoaded = false;
let attemptFailed = false; // 本轮加载是否已报过失败（Chromium 报错页也会触发 did-finish-load，不能当成功）
const MAX_LOAD_RETRY = 30;   // 最多重试 30 次
const LOAD_RETRY_MS = 2000;  // 每 2 秒一次（覆盖慢启动）
const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8">' +
    '<body style="background:#0b1020;color:#e6edf7;font:14px/1.9 system-ui;padding:48px">' +
    "<h2>MemoryOS 服务暂时没起来</h2>" +
    "<p>已等待 60 秒仍未连上本地记忆内核。请退出后重新打开软件。</p>" +
    "<p>如反复出现，可把日志发给维护者：%APPDATA%\\MemoryOS\\logs\\desktop.log</p></body>"
  );

function log(...a) {
  const line = `[MainWindow] ${new Date().toLocaleString("zh-CN")} ` +
    a.map((x) => (x instanceof Error ? (x.stack || x.message) : (typeof x === "string" ? x : JSON.stringify(x)))).join(" ");
  console.log(line);
  // P0-4：窗口侧日志同样落盘（与 main.js 同一文件），黑屏排查可看完整时序
  try {
    const dir = path.join(app.getPath("appData"), "MemoryOS", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "desktop.log"), line + "\n", "utf8");
  } catch { /* 日志落盘失败不影响主流程 */ }
}

/** 加载主页面：令牌经 session cookie 注入后再加载裸 URL（失败由 did-fail-load 重试兜底） */
function loadMainURL() {
  if (!mainWin || mainWin.isDestroyed()) return;
  attemptFailed = false;
  const base = `http://127.0.0.1:${cfg.port}/`;
  if (!cfg.TOKEN) {
    mainWin.loadURL(base);
  } else {
    session.defaultSession.cookies
      .set({ url: base, name: "memoryos_token", value: cfg.TOKEN, httpOnly: true, sameSite: "strict" })
      .then(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(base); })
      .catch(() => { if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(`${base}?token=${encodeURIComponent(cfg.TOKEN)}`); });
  }
}

/** 2 秒后重试（去重：已有排期则不重复排） */
function scheduleLoadRetry() {
  if (loadTimer) return;
  loadTimer = setTimeout(() => { loadTimer = null; loadMainURL(); }, LOAD_RETRY_MS);
}

/** 内核就绪通知：立即补一次加载，不必等下一轮重试 */
function notifyCoreReady() {
  if (!mainWin || mainWin.isDestroyed() || pageLoaded) return;
  if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
  log("内核就绪，立即加载主页面");
  loadMainURL();
}

ipcMain.on("main-window:set-theme", (event, theme) => {
  if (!mainWin || mainWin.isDestroyed() || event.sender.id !== mainWin.webContents.id) return;
  if (theme !== "dark" && theme !== "light") return;
  nativeTheme.themeSource = theme;
});

/** 启动时注入端口/令牌（showMain 可能先于 createMainWindow 被触发，需要兜底配置） */
function prepareMainWindow(o) {
  if (o) cfg = { ...cfg, ...o };
  return cfg;
}

function createMainWindow() {
  loadAttempts = 0;
  pageLoaded = false;
  mainWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 680,
    autoHideMenuBar: true, backgroundColor: "#0b1020", title: "MemoryOS", show: false,
    /* P0 加固：显式声明安全基线（与 Electron 20+ 默认一致，防未来默认漂移；对齐 welcome-window 风格） */
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWin.once("ready-to-show", () => { log("ready-to-show：显示窗口"); mainWin.show(); });
  // 兜底：15 秒仍未显示（ready-to-show 未触发）则强制显示，避免窗口静默隐身
  setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
      log("15s 未显示，强制显示窗口");
      mainWin.show();
    }
  }, 15000);
  mainWin.on("close", (e) => { if (!(cfg.isQuitting && cfg.isQuitting())) { e.preventDefault(); mainWin.hide(); } });
  mainWin.on("closed", () => (mainWin = null));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) cfg.shell.openExternal(url);
    return { action: "deny" };
  });
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${cfg.port}/`)) e.preventDefault();
  });

  /* P0-3：令牌经 session cookie 注入后再加载裸 URL —— 令牌不出现在地址栏 / 会话历史 / 请求 URL，
     消除内核 302 剥离之前的窗口期。内核已原生支持 cookie 鉴权（dashboard.js installAccessControl，
     与前端 app.js 依赖同源 cookie 的现状一致）。种 cookie 失败则回退旧的 ?token= 方式。
     P0-4：加载失败自动重试（内核未就绪时连不上 8787），重试耗尽显示兜底错误页。 */
  mainWin.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = 被新加载中断，不算失败
    attemptFailed = true;
    if (loadAttempts++ < MAX_LOAD_RETRY) {
      log(`主页面加载失败（${code} ${desc}），2 秒后重试（${loadAttempts}/${MAX_LOAD_RETRY}）`);
      scheduleLoadRetry();
    } else {
      log("主页面重试耗尽，显示兜底错误页");
      if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(ERROR_PAGE);
    }
  });
  mainWin.webContents.on("did-finish-load", () => {
    if (attemptFailed) return; // 报错页的"加载完成"不算成功，等重试
    if (!mainWin.webContents.getURL().startsWith(`http://127.0.0.1:${cfg.port}`)) return; // 只认本机页面
    pageLoaded = true;
    loadAttempts = 0;
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    log("主页面加载完成 URL=" + mainWin.webContents.getURL() + " 标题=" + mainWin.getTitle());
  });
  mainWin.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) log("页面报错:", String(message).slice(0, 300));
  });
  loadMainURL();
}

function showMain() {
  if (!mainWin) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function getMainWindow() {
  return mainWin;
}

module.exports = { prepareMainWindow, createMainWindow, showMain, getMainWindow, notifyCoreReady };