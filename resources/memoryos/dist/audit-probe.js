#!/usr/bin/env node
/**
 * MemoryOS — 执行面审计探针（补 FINAL 方案里缺失的 `audit-probe`）
 *
 * 为什么需要它：`exec_audit` 表建好了但**无人验证过它真会落行**——「写了审计代码」与
 * 「审计真的在工作」是两件事。P0 验收项之一是「执行为必须留下可查审计行」，本探针即该项的证据工具。
 *
 * 两种模式
 *   ① 默认 `--exercise`：临时库 + 临时工作区 + 真 MCP 调用 → 打印落下的审计行（**不碰生产库**）
 *   ② `--db <path>`：只读打开既有库，列最近 N 行审计（默认生产库 `data/memory.db`）
 *      `--assert-min <n>`：要求至少 n 行，否则非零退出（用于 CI/门禁）
 *
 * 用法：
 *   cd resources/memoryos && node dist/audit-probe.js
 *   node dist/audit-probe.js --db data/memory.db --limit 20
 * 退出码：0 正常 / 1 断言不满足或异常
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_DIR = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = Math.max(1, Math.min(500, Number(opt("limit", "20")) || 20));
const ASSERT_MIN = Number(opt("assert-min", "-1"));
const DB_ARG = opt("db", "");

/** 表存在性守卫：老库可能还没跑过 exec_audit 迁移 */
function tableExists(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function printRows(db, label) {
    if (!tableExists(db, "exec_audit")) {
        console.log(`【${label}】exec_audit 表不存在（该库未跑过执行面迁移）`);
        return 0;
    }
    const total = db.prepare("SELECT COUNT(*) c FROM exec_audit").get().c;
    const rows = db.prepare(`SELECT id,created_at,tool,agent,risk,approval,duration_ms,args_digest,detail
                             FROM exec_audit ORDER BY id DESC LIMIT ?`).all(LIMIT);
    console.log(`【${label}】exec_audit 共 ${total} 行，最近 ${rows.length} 行：`);
    if (!rows.length) console.log("  （空——执行面工具尚未被真实调用过）");
    for (const r of rows) {
        console.log(`  #${String(r.id).padStart(4)} ${r.created_at}  ${String(r.tool).padEnd(11)} ${r.risk} ${String(r.approval).padEnd(14)} ${String(r.duration_ms).padStart(5)}ms  ${String(r.detail ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
        console.log(`        args=${String(r.args_digest ?? "").slice(0, 90)}`);
    }
    return total;
}

/* ── 模式 ②：只读探查既有库 ───────────────────────────────── */
if (DB_ARG) {
    const p = path.resolve(KERNEL_DIR, DB_ARG);
    if (!fs.existsSync(p)) { console.log(`库不存在：${p}`); process.exit(1); }
    const db = new DatabaseSync(p, { readOnly: true });
    const total = printRows(db, p);
    db.close();
    if (ASSERT_MIN >= 0 && total < ASSERT_MIN) {
        console.log(`\n❌ 断言失败：exec_audit ${total} 行 < 要求 ${ASSERT_MIN} 行`);
        process.exit(1);
    }
    process.exit(0);
}

/* ── 模式 ①：临时库真跑一遍，验证审计链路 ──────────────────── */
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-audit-probe-"));
const DB = path.join(WS, "audit-probe.db");
const cleanup = () => { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on("exit", cleanup);

const proc = spawn(process.execPath, [path.join(HERE, "server.js")], {
    env: { ...process.env, MEMORY_DB: DB, MEMORY_AGENT: "audit-probe", MEMORY_AGENT_FPATH: path.join(WS, "fpath.txt"), MEMORYOS_WORKSPACE: WS, MEMORYOS_EXEC_ON: "1", MEMORYOS_EXEC_OFF: "" },
    windowsHide: true,
});
let buf = "", lastId = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve) => {
    const id = ++lastId;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
    }
});
const call = async (name, args) => ((await send("tools/call", { name, arguments: args }))?.result?.content ?? []).map((c) => c.text ?? "").join("\n");

let failed = 0;
try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit-probe", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    fs.writeFileSync(path.join(WS, "probe.txt"), "audit-probe\n", "utf8");
    // ★ 2026-10-14：命令成功路径改用「文件方式」——`node -e` 已被命令形态守卫拦下（execDenyReason），
    //   若仍用 -e，本探针的「命令成功」审计分支会退化为「被拒」分支，反而丢掉一半覆盖。
    fs.writeFileSync(path.join(WS, "audit-ok.js"), "console.log('audit-ok')\n", "utf8");
    console.log("→ 触发被审计的调用序列（1 成功读 / 1 成功写 / 1 越界拒 / 1 命令成功 / 1 非白名单拒）\n");
    await call("file_read", { path: "probe.txt" });
    await call("file_write", { path: "probe.txt", content: "audit-probe-v2\n" });
    await call("file_read", { path: "../../Windows/win.ini" });                  // 越界 → 失败也须留痕
    await call("exec_run", { cmd: ["node", "audit-ok.js"] });
    await call("exec_run", { cmd: ["curl", "http://127.0.0.1:9/"] });            // 非白名单 → 留痕

    // MCP 端写入是本进程外的另一个连接；等 DDL/INSERT 落盘后再读
    await new Promise((r) => setTimeout(r, 500));
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));

    const db = new DatabaseSync(DB, { readOnly: true });
    const total = printRows(db, "临时库（本轮真实调用产生）");
    const rejected = db.prepare("SELECT COUNT(*) c FROM exec_audit WHERE detail LIKE '%拒绝%' OR detail LIKE '%越界%' OR detail LIKE '%允许清单%'").get().c;
    const toolsCovered = db.prepare("SELECT COUNT(DISTINCT tool) c FROM exec_audit").get().c;
    db.close();

    console.log("");
    if (total < 3) { console.log(`❌ 审计行数 ${total} < 3（P0 验收项不满足）`); failed++; }
    else console.log(`✅ 审计行数 ${total} ≥ 3（P0 验收项满足）`);
    if (toolsCovered < 2) { console.log(`❌ 仅覆盖 ${toolsCovered} 个工具，应 ≥2`); failed++; }
    else console.log(`✅ 覆盖 ${toolsCovered} 个工具`);
    if (rejected < 1) { console.log("❌ 被拒绝的调用未留审计（拒绝路径必须可追溯）"); failed++; }
    else console.log(`✅ 拒绝路径留痕 ${rejected} 行（失败调用同样可追溯）`);
    if (ASSERT_MIN >= 0 && total < ASSERT_MIN) { console.log(`❌ --assert-min ${ASSERT_MIN} 不满足（${total}）`); failed++; }
} catch (e) {
    failed++;
    console.log(`❌ 探针异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
    if (!proc.killed) proc.kill();
}
console.log(`\n== 审计探针：${failed ? "FAIL" : "PASS"} ==`);
process.exit(failed ? 1 : 0);
