"use strict";
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");

/** 访问令牌文件（与内核库同目录，壳与内核共用一个令牌） */
function tokenFilePath() {
  return path.join(app.getPath("appData"), "MemoryOS", "data", "token");
}

function _log(...a) {
  console.log(`[MemoryOS-Desktop] ${new Date().toLocaleString("zh-CN")}`, ...a);
}

/**
 * 读/生成本机访问令牌（P1-2 / P0 硬化：改走 safeStorage 见路线图 §4）。
 * 已存在则复用，否则生成 48 位十六进制随机串并落盘。
 */
function ensureToken() {
  const f = tokenFilePath();
  try {
    const t = fs.readFileSync(f, "utf8").trim();
    if (t) return t;
  } catch { /* 首次运行：下面生成 */ }
  const t = randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, t, "utf8");
  } catch (e) {
    _log("令牌落盘失败（鉴权仍生效）:", e && e.message ? e.message : String(e));
  }
  return t;
}

module.exports = { tokenFilePath, ensureToken };