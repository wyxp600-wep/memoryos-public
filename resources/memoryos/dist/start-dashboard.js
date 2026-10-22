/**
 * 以「与 MemoryOS.exe 内核完全一致」的环境变量启动 dashboard，并脱离父进程常驻。
 * 用途：改完 dist/*.js 后重启内核使改动生效（等价 main.js 的 startCore，但不依赖 Electron 壳）。
 *
 * 用法：node dist/start-dashboard.js [port]
 * 说明：env 复刻自 main.js spawnCore()：MEMORY_DB / MEMORY_PORT / EMBED_MODE / EMBED_CACHE_DIR / MEMORYOS_SERVER / MEMORY_TOKEN
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const KERNEL = path.resolve(HERE, "..");
const DATA = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "MemoryOS");
const port = process.argv[2] ?? process.env.MEMORY_PORT ?? "8787";
const tokenFile = path.join(DATA, "data", "token");
const TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
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
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
});
child.unref();
console.log(`dashboard 已启动 pid=${child.pid} port=${port} db=${path.join(DATA, "data", "memory.db")}`);
