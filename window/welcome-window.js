"use strict";
const path = require("node:path");
const { BrowserWindow } = require("electron");

/** 首次配置（welcome）窗口，自持 welcomeWin。 */
let welcomeWin = null;
let h = { readConfig: () => null, finalizeStartup: () => {}, preloadPath: "" };

function createWelcomeWindow(opts) {
  if (opts) h = { ...h, ...opts };
  welcomeWin = new BrowserWindow({
    width: 560, height: 640, resizable: false, autoHideMenuBar: true,
    backgroundColor: "#0b1020", title: "MemoryOS 首次配置",
    webPreferences: {
      preload: h.preloadPath || path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  welcomeWin.loadFile(path.join(__dirname, "..", "welcome.html"));
  welcomeWin.on("closed", () => {
    welcomeWin = null;
    if (!h.readConfig()) h.finalizeStartup({});
  });
  return welcomeWin;
}

function getWelcomeWindow() {
  return welcomeWin;
}

function closeWelcomeWindow() {
  if (welcomeWin) welcomeWin.close();
}

module.exports = { createWelcomeWindow, getWelcomeWindow, closeWelcomeWindow };