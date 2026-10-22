/**
 * 记忆库合并（跨实例搬运）：把「源库」里目标库没有的记忆搬进「目标库」。
 *
 * 为什么需要：多实例并存时（应用库 %APPDATA%\MemoryOS\data\memory.db 与部署副本库），
 *   客户端 MCP 可能连的是另一个库，导致「仪表盘里看不到 Agent 写的记忆」。
 *   本脚本按内容精确判重后补齐差额，不改动源库、不覆盖目标库既有记忆。
 *
 * 安全性：
 *   - 默认**预演**（只报告不写）；确认无误后加 --apply
 *   - --apply 前先用 VACUUM INTO 做一份带时间戳的整库快照到 <目标库目录>/backup/
 *   - 全部写入在单个事务里（withTx），任一步失败整体回滚
 *   - 只搬 active/trial/archived（merged/rejected 是源实例的去重/裁决产物，不搬）
 *   - 跨表引用（conflict_with/superseded_by/derived_from）只在被引用记忆也一并迁移时才保留，避免悬空
 *   - 向量按 memory_id 一并搬运；FTS/gram 由 writeMemory 统一维护
 *   - 用法：
 *       node dist/merge-db.js --from <源库> --to <目标库>                     # 预演（全量）
 *       node dist/merge-db.js --from <源库> --to <目标库> --apply             # 执行（全量）
 *       node dist/merge-db.js --from <源库> --to <目标库> --project <名>      # 只搬指定 project（预演）
 *       node dist/merge-db.js --from <源库> --to <目标库> --project <名> --apply
 *   --project（★ 2026-09-30 双库分裂收口）：只想搬回某项目 stranded 记忆、
 *   不想把源库的 seed/冒烟残留（如 dev 库 global 数百条）灌进生产库时用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, writeMemory, withTx, readVector, upsertVector, lexSearch, sectorLambda, TYPE_TO_SECTOR, SECTOR_KEYS } from "./db.js";

const DEFAULT_FROM = "C:/Users/WYX/Desktop/aiagent记忆与规则/memoryos/data/memory.db";
const DEFAULT_TO = process.env.MEMORY_DB ||
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "MemoryOS", "data", "memory.db");
const MIGRATABLE = new Set(["active", "trial", "archived"]);
const norm = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

function parseArgs(argv) {
    const out = { from: DEFAULT_FROM, to: DEFAULT_TO, apply: false, sample: 15, project: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--from") out.from = argv[++i];
        else if (a === "--to") out.to = argv[++i];
        else if (a === "--apply") out.apply = true;
        else if (a === "--sample") out.sample = Number(argv[++i]) || 15;
        else if (a === "--project") out.project = argv[++i] || null;
        else if (a === "--help" || a === "-h") out.help = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    console.log("用法: node dist/merge-db.js --from <源库> --to <目标库> [--project <名>] [--apply] [--sample N]");
    process.exit(0);
}
const FROM = path.resolve(args.from);
const TO = path.resolve(args.to);
if (FROM === TO) {
    console.error("源库与目标库是同一个文件，无需合并");
    process.exit(2);
}
for (const [label, p] of [["源库", FROM], ["目标库", TO]]) {
    if (!fs.existsSync(p)) {
        console.error(`${label}不存在: ${p}`);
        process.exit(2);
    }
}

console.log(`源库  : ${FROM}`);
console.log(`目标库: ${TO}`);
if (args.project) console.log(`过滤  : 仅 project=${JSON.stringify(args.project)}`);
console.log(`模式  : ${args.apply ? "★ 执行（写入目标库，写前自动快照）" : "预演（只读，不写任何库）"}\n`);

const src = new DatabaseSync(FROM, { readOnly: true });
// ★ --project 过滤：两分支各自字面量 SQL（占位符与实参一一对应，lint:sql 静态可判）
const srcRows = args.project
    ? src.prepare(`SELECT * FROM memories WHERE project=?`).all(args.project)
    : src.prepare(`SELECT * FROM memories`).all();
// 预演阶段**只读**打开目标库（绝不在你没确认前触发任何写，包括迁移）
const target = args.apply ? openDb(TO) : new DatabaseSync(TO, { readOnly: true });
const targetContents = new Set(target.prepare(`SELECT content FROM memories`).all().map((r) => norm(r.content)));

const pending = [];
const skipped = { dup: 0, status: 0 };
for (const r of srcRows) {
    if (!MIGRATABLE.has(String(r.status))) { skipped.status++; continue; }
    if (targetContents.has(norm(r.content))) { skipped.dup++; continue; }
    pending.push(r);
}
const byAgent = {};
const byStatus = {};
for (const r of pending) {
    byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
}
console.log(`源库记忆总数      : ${srcRows.length}`);
console.log(`内容已存在（跳过）: ${skipped.dup}`);
console.log(`状态不可搬运（跳过 merged/rejected）: ${skipped.status}`);
console.log(`待搬入            : ${pending.length}`);
console.log(`   按来源: ${Object.entries(byAgent).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
console.log(`   按状态: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
if (pending.length) {
    console.log(`\n样例（最多 ${args.sample} 条）:`);
    for (const r of pending.slice(0, args.sample)) {
        console.log(`   #${String(r.id).padStart(4)} [${String(r.agent).padEnd(14)} ${String(r.sector ?? "-").padEnd(10)} ${String(r.status).padEnd(8)}] ${String(r.content).replace(/\s+/g, " ").slice(0, 70)}`);
    }
}
if (!pending.length) {
    console.log("\n没有需要搬入的记忆，目标库已包含源库全部可用记忆。");
    src.close(); target.close();
    process.exit(0);
}
if (!args.apply) {
    console.log("\n（预演结束，未写入。确认无误后加 --apply 执行）");
    src.close(); target.close();
    process.exit(0);
}

/* ---------- 执行 ---------- */
// 预演阶段用的是只读连接；真正要写之前换成可写连接（openDb 会顺带做幂等迁移）
target.close();
const rw = openDb(TO);
const bakDir = path.join(path.dirname(TO), "backup");
fs.mkdirSync(bakDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bakPath = path.join(bakDir, `memory-merge-${stamp}.db`);
rw.exec(`VACUUM INTO '${bakPath.replace(/'/g, "''")}'`);
console.log(`\n✅ 已快照目标库 → ${bakPath}（${(fs.statSync(bakPath).size / 1024 / 1024).toFixed(1)}MB）`);

const srcIds = new Set(pending.map((r) => Number(r.id)));
const map = new Map(); // 源 id → 目标 id
let vectors = 0, usages = 0, events = 0;

withTx(rw, () => {
    for (const r of pending) {
        const vec = readVector(src, Number(r.id));
        const row = writeMemory(rw, {
            content: r.content, type: r.type, agent: r.agent, agent_fpath: r.agent_fpath,
            project: r.project, status: r.status, confidence: r.confidence,
            sector: r.sector, form: r.form, salience: r.salience, decay_lambda: r.decay_lambda,
            valid_from: r.valid_from, valid_until: r.valid_until,
            trigger_cond: r.trigger_cond, trigger_kind: r.trigger_kind, trigger_action: r.trigger_action,
            valence: r.valence, arousal: r.arousal, source_ref: r.source_ref,
            sensitivity: r.sensitivity, pinned: r.pinned,
            embedding: vec ?? undefined,
        });
        if (vec) vectors++;
        map.set(Number(r.id), Number(row.id));
        // ★ sector 必须显式落库：源库若也是「列默认值遗留」（sector 停在 'episodic' 而 type 明明是
        //   decision/rule/pitfall/convention/task），搬迁后会继续错下去。这里按真源映射 TYPE_TO_SECTOR
        //   重算一遍：源库有有效 sector 就沿用，否则由 type 推导。
        const srcSector = String(r.sector ?? "").trim().toLowerCase();
        const mappedSector = TYPE_TO_SECTOR[String(r.type ?? "").toLowerCase()];
        const finalSector = SECTOR_KEYS.includes(srcSector) && !(srcSector === "episodic" && mappedSector && mappedSector !== "episodic")
            ? srcSector
            : (mappedSector || "episodic");
        rw.prepare(`UPDATE memories SET sector=?, decay_lambda=? WHERE id=?`)
            .run(finalSector, sectorLambda(finalSector), row.id);
        // writeMemory 不接管的字段：保留源库的历史（创建时间/命中次数/有效置信）
        rw.prepare(`UPDATE memories SET created_at=?, hit_count=?, last_hit_at=?, eff_confidence=?, last_seen_at=? WHERE id=?`)
            .run(r.created_at, r.hit_count, r.last_hit_at, r.eff_confidence, r.last_seen_at, row.id);
    }
    // 跨表引用：只在被引用记忆也搬过来时才保留
    for (const r of pending) {
        const nid = map.get(Number(r.id));
        const fix = (v) => (v != null && srcIds.has(Number(v)) ? map.get(Number(v)) ?? null : null);
        rw.prepare(`UPDATE memories SET conflict_with=?, superseded_by=?, derived_from=? WHERE id=?`)
            .run(fix(r.conflict_with), fix(r.superseded_by), fix(r.derived_from), nid);
    }
    // 使用埋点（价值度量）：只搬这些记忆自己的行，避免全局计数被另一实例重复计入
    for (const r of pending) {
        const nid = map.get(Number(r.id));
        const rows = src.prepare(`SELECT event, reader_agent, writer_agent, project, session_id, task_hint, created_at FROM memory_usage WHERE memory_id=?`).all(Number(r.id));
        for (const u of rows) {
            rw.prepare(`INSERT INTO memory_usage(memory_id, event, reader_agent, writer_agent, project, session_id, task_hint, created_at) VALUES (?,?,?,?,?,?,?,?)`)
                .run(nid, u.event, u.reader_agent, u.writer_agent, u.project, u.session_id, u.task_hint, u.created_at);
            usages++;
        }
    }
    // 事件留痕（仲裁/撤销）：同样只搬与这些记忆相关的
    for (const r of pending) {
        const nid = map.get(Number(r.id));
        const rows = src.prepare(`SELECT op, payload, operator, undone, created_at FROM memory_events WHERE memory_id=?`).all(Number(r.id));
        for (const e of rows) {
            rw.prepare(`INSERT INTO memory_events(memory_id, op, payload, operator, undone, created_at) VALUES (?,?,?,?,?,?)`)
                .run(nid, e.op, e.payload, e.operator, e.undone, e.created_at);
            events++;
        }
    }
});

const after = rw.prepare(`SELECT COUNT(*) c FROM memories`).get().c;
console.log(`✅ 已搬入 ${pending.length} 条记忆（向量 ${vectors} · 使用埋点 ${usages} · 事件 ${events}）`);
console.log(`   目标库记忆总数：${targetContents.size} → ${after}`);
// 抽查：新搬入的记忆能否被检索到（FTS / gram 索引是否生效）
const probe = String(pending[0].content).replace(/\s+/g, "").slice(0, 6);
const hits = lexSearch(rw, probe, pending[0].project, 5);
const found = Array.isArray(hits) ? hits.some((h) => Number(h.id) === map.get(Number(pending[0].id))) : false;
console.log(`🔎 检索自检：用「${probe}」查库，命中新记忆 = ${found ? "是" : "否（请检查索引）"}`);
src.close();
rw.close();
