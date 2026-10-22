/**
 * 内核重启（dashboard）一条命令完成：杀旧进程 → 用正确 env 重新拉起 → 等待就绪 → 自检新功能字段。
 * env 与 main.js spawnCore() 完全一致（MEMORY_DB / MEMORY_PORT / EMBED_MODE / EMBED_CACHE_DIR / MEMORYOS_SERVER / MEMORY_TOKEN）。
 *
 * 用法：node dist/restart-core.js [port]
 *
 * 注意：在受管沙箱（如 AI 助手终端）里执行时，命令结束会连带清理本命令启动的进程树，
 *      服务不会常驻 —— 请在普通 PowerShell / 终端窗口执行，或由 MemoryOS.exe 壳拉起。
 */
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const KERNEL = path.resolve(HERE, "..");
const DATA = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "MemoryOS");
const port = Number(process.argv[2] ?? process.env.MEMORY_PORT ?? 8787);
const tokenFile = path.join(DATA, "data", "token");
const TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
function listeningPid(p) {
    try {
        const out = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort ${p} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`, { encoding: "utf8", windowsHide: true });
        const n = Number(String(out).trim());
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    catch {
        return null;
    }
}
const old = listeningPid(port);
if (old) {
    try {
        execSync(`taskkill /PID ${old} /T /F`, { stdio: "ignore", windowsHide: true });
        console.log(`已停止旧内核 pid=${old}`);
    }
    catch {
        console.log(`停止旧内核失败 pid=${old}（可能已退出）`);
    }
    await new Promise((r) => setTimeout(r, 1500));
}
else {
    console.log("当前无内核在监听 " + port);
}
const child = spawn(path.join(KERNEL, "runtime", "node.exe"), [path.join(KERNEL, "dist", "dashboard.js")], {
    cwd: KERNEL,
    env: {
        ...process.env,
        MEMORY_DB: path.join(DATA, "data", "memory.db"),
        MEMORY_PORT: String(port),
        EMBED_MODE: "local",
        EMBED_CACHE_DIR: path.join(KERNEL, "models"),
        MEMORYOS_SERVER: path.join(KERNEL, "dist", "server.js"),
        MEMORY_TOKEN: TOKEN,
        MEMORY_RESTRICTED: process.env.MEMORY_RESTRICTED ?? "0",
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
});
child.unref();
console.log(`新内核已启动 pid=${child.pid}`);
// 等待就绪
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 800));
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/summary`, { headers: { "x-memory-token": TOKEN } });
        if (res.ok) {
            const j = await res.json();
            console.log(`内核就绪（${Date.now() - t0}ms）：记忆 ${j.total} 条`);
            ok = true;
            break;
        }
    }
    catch { /* 继续等 */ }
}
if (!ok) {
    console.log("❌ 内核 60s 未就绪");
    process.exit(1);
}
// 自检：新字段是否生效
const all = await (await fetch(`http://127.0.0.1:${port}/api/all?limit=1`, { headers: { "x-memory-token": TOKEN } })).json();
const r0 = all.rows?.[0];
const hasAi = !!(r0 && r0.ai && r0.ai.search && r0.ai.read);
const hasVis = !!(r0 && r0.ai_visible);
const appjs = await (await fetch(`http://127.0.0.1:${port}/app.js`, { headers: { "x-memory-token": TOKEN } })).text();
console.log(`自检：/api/all 含 ai.* = ${hasAi}；含 ai_visible = ${hasVis}；前端含 WYSIWYG = ${appjs.includes("aiWysiwygBlock")}`);
process.exit(hasAi && hasVis && appjs.includes("aiWysiwygBlock") ? 0 : 2);
