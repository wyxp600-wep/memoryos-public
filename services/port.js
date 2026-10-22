"use strict";
const net = require("node:net");

/** 探测 127.0.0.1:p 是否被占用 */
function portOpen(p, timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: p }, () => {
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

/** 从 start 起顺延找空闲端口（默认 8787 起，扫 20 个） */
async function findFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    if (!(await portOpen(p))) return p;
  }
  throw new Error("未找到可用端口（8787-8806 全被占用）");
}

module.exports = { portOpen, findFreePort };