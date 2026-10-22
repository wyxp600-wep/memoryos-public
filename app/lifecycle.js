"use strict";
const { app, dialog } = require("electron");
const fs = require("node:fs");

/**
 * 应用生命周期（单实例锁 / ready / before-quit / window-all-closed / uncaughtException）。
 * ctx: { kernelDir, nodeExe, findFreePort, readConfig, finalizeStartup, createWelcome,
 *        showMain, setKernel, setPort, setQuitting, killChildren, log }
 * 注：核心发现协议（discoverHealthyCore）**不在本层调用**——它带 MEMORY_TOKEN 做 health
 * 校验，而 TOKEN 在 finalizeStartup 内才 ensureToken；本层调用会拿到空 token → 401
 * 误判 null → 端口走 findFreePort 与复用核心不一致（2026-10-15 实测事故，端口 8789
 * vs 8788 → 窗口连接错误 60s）。discover 由 finalizeStartup 在 TOKEN 就绪后执行。
 */
function createLifecycle(ctx) {
  const {
    kernelDir, nodeExe, findFreePort, readConfig, finalizeStartup, createWelcome,
    showMain, setKernel, setPort, setQuitting, killChildren, log,
  } = ctx;

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.exit(1); // ★ 2026-10-15：quit() 在托盘常驻语义（window-all-closed 空实现）下会挂起残留僵尸壳，改 exit 强清
    return;
  }

  app.on("second-instance", () => showMain());

  app.whenReady().then(async () => {
    // ★ 2026-10-10 诊断：同 main.js，AUMID 暂撤做 A/B（托盘注册被 Win11 吞，getBounds 恒 0）
    // if (process.platform === "win32") app.setAppUserModelId("com.memoryos.desktop");
    setKernel(kernelDir());
    if (!fs.existsSync(nodeExe())) {
      dialog.showMessageBox({
        type: "error", title: "MemoryOS",
        message: "程序不完整：未找到内核运行时。",
        detail: `缺少 ${nodeExe()}，请重新安装。`,
      });
      app.exit(1); // 同上：失败路径必须干净退出，不留无窗口僵尸壳
      return;
    }
    const cfg = readConfig();
    if (cfg) {
      const port = await findFreePort(8787);
      setPort(port);
      finalizeStartup(cfg);
    } else {
      createWelcome();
    }
  }).catch((e) => {
    log("启动时发生未处理的异常:", e instanceof Error ? e.message : String(e));
    dialog.showMessageBox({ type: "error", title: "MemoryOS", message: "启动失败：\n" + (e instanceof Error ? e.message : String(e)) });
    app.exit(1); // 同上：异常路径 exit 强清，防僵尸
  });

  app.on("before-quit", () => {
    setQuitting(true);
    killChildren();
  });

  app.on("window-all-closed", () => { /* 托盘驻留，不退出 */ });

  process.on("uncaughtException", (e) => log("未捕获异常:", e));
  process.on("unhandledRejection", (reason) => log("未处理的 Promise 拒绝:", reason instanceof Error ? reason.message : String(reason)));
}

module.exports = { createLifecycle };