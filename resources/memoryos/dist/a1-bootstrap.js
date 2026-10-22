#!/usr/bin/env node
/** ★ 一致性⑧（2026-09-19）：A1 凭据一键签发 —— 把「谁有权改任务」从纯审计升级为可随时开启的门禁。
 *
 *  用法：node dist/a1-bootstrap.js <agent名...> [--days 30] [--rotate]
 *    --days N   凭据有效期天数（默认 30；MCP memory_credential 工具上限 24h，本脚本直写库支持长有效期）
 *    --rotate   签发前先撤销该 agent 现有全部未撤销凭据（轮换）
 *
 *  输出每个 agent 的 MCP env 注入行（MEMORYOS_A1_CREDENTIAL=...），粘进各客户端 MCP 配置即可；
 *  开启硬门禁：各配置再加 MEMORYOS_A1_ENFORCE=1（先发凭据、后开门禁，平滑切换不断旧会话）。
 *
 *  纪律：凭据只打印一次、只存 agent_credentials 表（与 memory_credential 工具同表），
 *  绝不写入任何日志文件；agent 名白名单校验与 server.js assertAssignee 同口径。
 */
import { openDb } from "./db.js";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));
const db = openDb(dbPath);
const argv = process.argv.slice(2);
const di = argv.indexOf("--days");
const days = di >= 0 ? Math.max(1, Number(argv[di + 1]) || 30) : 30;
const rotate = argv.includes("--rotate");
const skip = new Set(["--days", "--rotate"]);
if (di >= 0)
    skip.add(argv[di + 1]);
const agents = argv.filter((a) => !skip.has(a) && !a.startsWith("--"));
if (!agents.length) {
    console.error("用法：node dist/a1-bootstrap.js <agent名...> [--days 30] [--rotate]");
    console.error("示例：node dist/a1-bootstrap.js codex trae zcode workbuddy claude --days 30 --rotate");
    process.exit(1);
}
const now = new Date().toISOString();
const expires = new Date(Date.now() + days * 86400000).toISOString();
let issued = 0;
for (const agent of agents) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) {
        console.error(`跳过 ${agent}：agent 名须为小写字母开头的 kebab 标识（[a-z][a-z0-9_-]{0,31}）`);
        continue;
    }
    if (rotate) {
        const rv = db.prepare(`UPDATE agent_credentials SET revoked_at=? WHERE agent=? AND revoked_at IS NULL`).run(now, agent);
        if (Number(rv.changes) > 0)
            console.error(`  ${agent}：已撤销 ${rv.changes} 张旧凭据（轮换）`);
    }
    const credential = randomBytes(24).toString("hex");
    db.prepare(`INSERT INTO agent_credentials(agent, credential, scope, expires_at) VALUES (?,?,?,?)`).run(agent, credential, "write", expires);
    issued++;
    console.log(`MEMORYOS_A1_CREDENTIAL=${credential}  # agent=${agent} scope=write 有效期至 ${expires}${rotate ? "（旧凭据已撤销）" : ""}`);
}
console.error(`\n完成：签发 ${issued}/${agents.length} 张（库：${dbPath}）`);
console.error(`下一步：把上方各行粘进对应 agent 的 MCP 配置 env；确认全部就绪后加 MEMORYOS_A1_ENFORCE=1 开启硬门禁。`);
console.error(`查看水位：GET /api/health → a1 字段（enforce / envCredential / activeCredentials）。`);
