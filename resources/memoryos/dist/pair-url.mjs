#!/usr/bin/env node
/** ★ 2026-10-02 手机版配对：打印手机 App 配对所需完整 URL（局域网 IP + 端口 + 令牌）。
 *  口径与 dashboard.js CLI 一致：库 = MEMORY_DB ?? %APPDATA%\MemoryOS\data\memory.db，令牌在其同目录 token 文件。
 *  用法：node dist/pair-url.mjs [端口，默认 8787]
 *  安全提示：URL 含明文令牌，只在本机终端展示；手机 App 填入后请勿转发。 */
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";

const port = process.argv[2] ?? process.env.MEMORY_PORT ?? "8787";
const dbPath = process.env.MEMORY_DB ?? path.join(process.env.APPDATA ?? "", "MemoryOS", "data", "memory.db");
const tokenFile = path.join(path.dirname(dbPath), "token");
let token = process.env.MEMORY_TOKEN ?? "";
if (!token) {
    try { token = readFileSync(tokenFile, "utf8").trim(); } catch { /* 首启尚未生成 */ }
}

const ips = [];
for (const list of Object.values(networkInterfaces()))
    for (const ni of list ?? [])
        if (ni.family === "IPv4" && !ni.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address))
            ips.push(ni.address);

console.log("── MemoryOS 手机配对 ──");
if (!ips.length) {
    console.log("⚠ 未发现局域网 IPv4（WiFi/网线未连？）");
} else if (!token) {
    console.log(`⚠ 未找到令牌（${tokenFile}）——先启动一次内核生成后再跑本脚本`);
} else {
    for (const ip of ips) console.log(`配对地址：http://${ip}:${port}/?token=${token}`);
    console.log("手机 App 首页填入上面任一地址即可（同一 WiFi）；PC 防火墙放行 node.exe（专用网络）。");
}
