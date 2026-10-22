"use strict";
const { ipcMain } = require("electron");

/**
 * 注册主进程 IPC（P0§4：严格校验 event.sender，只接受来自可信窗口的调用）。
 * deps: { getWelcomeWin, onSaveConfig }
 */
function registerIpc(deps) {
  const { getWelcomeWin, onSaveConfig } = deps;

  ipcMain.on("welcome-save-config", (e, cfg) => {
    // sender 校验：仅接受 welcome 窗口自身的 webContents 发起的调用
    const w = getWelcomeWin && getWelcomeWin();
    if (!w || w.isDestroyed() || !w.webContents || e.sender.id !== w.webContents.id) {
      return; // 来源不可信，忽略
    }
    onSaveConfig(cfg || {});
  });
}

module.exports = { registerIpc };