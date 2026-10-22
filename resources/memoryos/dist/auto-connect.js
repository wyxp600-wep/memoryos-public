/**
 * MemoryOS — 扫描 → 自动接入（后台定时，2026-10-06）
 *
 * 目标：工具连接页扫到的「新智能体」自动接上 MemoryOS，并把记忆规矩一并注入，
 *       用户不必手点、也不必打开页面。
 *
 * 安全边界（沿用 scan.js 既有语义，不另造一套）：
 *   - 只对 canAutoWrite=true（载体已实证）的 agent 写入；未实证载体只留手动指引，绝不猜写；
 *   - 写入走 applyConnectWrite：写前备份到 ~/_pending-delete/connect-backup、临时文件 rename 原子替换、
 *     坏 JSON 拒写、已连接且库已对齐则跳过（幂等）；
 *   - 规则注入只在落点确知（resolveAgentRuleTarget 非 null）且尚无注入段时写一次（幂等）。
 *
 * 用法：
 *   node dist/auto-connect.js              真跑一轮（接入 + 注入规矩）
 *   node dist/auto-connect.js --dry-run    只预览，不落盘
 * 关闭：env MEMORYOS_AUTO_CONNECT=0（daemon 定时器与 CLI 同时生效）
 * 调用方：dist/daemon.js 常驻态定时异步 spawn 本脚本（不在 daemon 进程内直调 scanAgents ——
 *         其 spawnSync 探测最坏数十秒，交接文档坑8 明令禁裸调）。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { openDb } from "./db.js";
import { scanAgents, connectGuideFor, applyConnectWrite } from "./scan.js";
import { syncRules, syncProjectRules, resolveAgentRuleTarget, hasRuleSegment } from "./sync-rules.js";
/** 生产库真源：与 sync-rules.js 同口径（缺 APPDATA 才回落仓内路径） */
const DB_PATH = process.env.MEMORY_DB ?? (process.env.APPDATA
    ? path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db")
    : fileURLToPath(new URL("../data/memory.db", import.meta.url)));
/** 总开关：缺省开（MEMORYOS_AUTO_CONNECT=0 关闭） */
export const AUTO_CONNECT_ENABLED = process.env.MEMORYOS_AUTO_CONNECT !== "0";
const msg = (e) => (e instanceof Error ? e.message : String(e));
/**
 * 跑一轮「扫描 → 自动接入 → 注入规矩」。
 * @param {object} db 已打开的库（规则注入取数用）
 * @param {{dryRun?:boolean, log?:Function}} [opts]
 * @returns {{enabled:boolean,dryRun:boolean,scanned:number,attempted:Array,rulesInjected:Array,skipped:Array,rulesSkipped:Array}}
 */
export function runAutoConnect(db, opts = {}) {
    const dryRun = !!opts.dryRun;
    const log = typeof opts.log === "function" ? opts.log : () => { };
    const scan = scanAgents();
    const attempted = [];
    const skipped = [];
    // ① 接入：只处理「需要动作」且「可安全写」的 agent
    for (const a of scan.agents) {
        let g;
        try {
            g = connectGuideFor(a);
        }
        catch (e) {
            skipped.push({ id: a.id, name: a.name, reason: `向导生成失败：${msg(e)}` });
            continue;
        }
        const needsWork = !g.configured || g.needsRepair === true;
        if (!needsWork) {
            skipped.push({ id: a.id, name: a.name, reason: "已连接且库已对齐" });
            continue;
        }
        if (!g.canAutoWrite) {
            skipped.push({ id: a.id, name: a.name, reason: "载体未实证，只给手动指引（不猜写）" });
            continue;
        }
        let r;
        try {
            r = applyConnectWrite(a, { dryRun, automatic: true });
        }
        catch (e) {
            r = { ok: false, error: msg(e) };
        }
        attempted.push({
            id: a.id, name: a.name, ok: !!r.ok, mode: r.mode ?? null,
            target: r.target ?? g.autoWriteFile ?? null, backupPath: r.backupPath ?? null,
            reason: r.ok ? null : (r.error ?? "未知原因"),
        });
        log(`[auto-connect] ${r.ok ? (dryRun ? "将写入" : "已接入") : "未接入"} ${a.id} ← ${r.ok ? (r.target ?? g.autoWriteFile) : r.error}`);
    }
    // ② 规则注入：对「已连接」且落点确知、尚无注入段者写一次
    //    ★ 本轮刚接入成功的 agent（scan 快照里 connected 仍是 false）也要一并处理，
    //      否则「接入」与「注入规矩」被拆成两轮（用户感知为慢一拍）。
    const justConnected = new Set(attempted.filter((x) => x.ok && !dryRun).map((x) => x.id));
    const rulesInjected = [];
    const rulesSkipped = [];
    for (const a of scan.agents) {
        let g;
        try {
            g = connectGuideFor(a);
        }
        catch {
            continue; // 上面 ① 已记过一次失败原因，此处静默跳过
        }
        if (!g.configured && !justConnected.has(a.id))
            continue; // 未连接：写规矩文件也无智能体会读
        const t = resolveAgentRuleTarget(a.id, a.configFile ?? a.configDir ?? g.autoWriteFile ?? null);
        if (!t) {
            rulesSkipped.push({ id: a.id, name: a.name, reason: "无已知且可安全写入的规则入口，未注入" });
            continue;
        }
        if (hasRuleSegment(t.file)) {
            rulesSkipped.push({ id: a.id, name: a.name, reason: "已有注入段（幂等跳过）", file: t.file });
            continue;
        }
        if (dryRun) {
            rulesInjected.push({ id: a.id, name: a.name, file: t.file, verified: t.verified, dryRun: true });
            continue;
        }
        try {
            const r = t.targetId ? syncRules(db, { target: t.targetId })[0] : syncProjectRules(db, path.dirname(t.file));
            rulesInjected.push({ id: a.id, name: a.name, file: t.file, verified: t.verified, added: r.added, backedUp: r.backedUp });
            log(`[auto-connect] 注入规矩 ${a.id} → ${t.file}（新增=${r.added} 备份=${r.backedUp}${t.verified ? "" : "·待实测"}）`);
        }
        catch (e) {
            rulesSkipped.push({ id: a.id, name: a.name, reason: `注入失败：${msg(e)}`, file: t.file });
        }
    }
    return { enabled: true, dryRun, scanned: scan.total, attempted, rulesInjected, skipped, rulesSkipped };
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    if (!AUTO_CONNECT_ENABLED) {
        console.log("[auto-connect] 已关闭（MEMORYOS_AUTO_CONNECT=0），未执行");
        process.exit(0);
    }
    const dryRun = process.argv.includes("--dry-run");
    let code = 0;
    try {
        const db = openDb(DB_PATH);
        const r = runAutoConnect(db, { dryRun, log: (s) => console.log(s) });
        console.log(`[auto-connect] 扫描 ${r.scanned} 个 / 接入动作 ${r.attempted.length} / 规矩注入 ${r.rulesInjected.length}${dryRun ? "（dry-run：未落盘）" : ""}`);
        console.log(JSON.stringify({ attempted: r.attempted, rulesInjected: r.rulesInjected, skipped: r.skipped, rulesSkipped: r.rulesSkipped }, null, 2));
    }
    catch (e) {
        console.error(`[auto-connect] 失败: ${msg(e)}`);
        code = 1;
    }
    process.exit(code);
}
