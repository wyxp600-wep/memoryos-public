/**
 * WYSIWYG 影响面巡检（只读）：用真实库统计「用户看到的记忆」与「AI 收到的记忆」的差异规模。
 *
 * 用法（resources/memoryos 目录）：
 *   node dist/inspect-wysiwyg.js [limit]
 *
 * 只做 SELECT，不写库、不改数据。输出：
 *   ① 总量 / active 量
 *   ② 会被 memory_search(220) / memory_context(120) 裁剪的条数与占比
 *   ③ AI 检索不可见（status≠active 或 eff≤0.15）的条数
 *   ④ 抽样打印若干条记忆的 AI 侧原文（= 用户在详情弹窗看到的内容）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { aiViews, aiVisible, normContent, CLIP_SEARCH, CLIP_CONTEXT, EFF_FLOOR } from "./format.js";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DB_PATH = process.env.MEMORY_DB ?? path.resolve(HERE, "..", "data", "memory.db");
if (!fs.existsSync(DB_PATH)) {
    console.log(`未找到记忆库：${DB_PATH}`);
    process.exit(1);
}
const db = openDb(DB_PATH);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const total = one(`SELECT COUNT(*) c FROM memories`).c;
const active = one(`SELECT COUNT(*) c FROM memories WHERE status='active'`).c;
const rows = db
    .prepare(`SELECT id, content, type, agent, project, status, confidence, eff_confidence, hit_count, created_at,
                 (SELECT COUNT(*) FROM memory_usage u WHERE u.memory_id=memories.id AND u.event='cited' AND u.project=memories.project) cited
          FROM memories ORDER BY id DESC LIMIT ?`)
    .all(Number(process.argv[2] ?? 500));
let clippedSearch = 0, clippedContext = 0, invisible = 0, hiddenSearch = 0, hiddenContext = 0;
const reasons = new Map();
const worst = [];
for (const r of rows) {
    const v = aiViews({ ...r, eff: r.eff_confidence ?? r.confidence });
    const vis = aiVisible({ ...r, eff: r.eff_confidence ?? r.confidence });
    if (v.searchClipped) {
        clippedSearch++;
        hiddenSearch += v.searchHidden;
        worst.push({ id: r.id, normLen: v.normLen, hidden: v.searchHidden });
    }
    if (v.contextClipped)
        clippedContext++;
    hiddenContext += v.contextHidden;
    if (!vis.searchable) {
        invisible++;
        const key = vis.reason.replace(/eff=[\d.]+/, "eff≤").replace(/status=\w+/, (m) => m);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
}
const n = rows.length || 1;
const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
const out = [];
out.push(`【WYSIWYG 影响面巡检 · ${DB_PATH}】`);
out.push(`扫描 ${rows.length} 条（库内共 ${total} 条，active ${active} 条）`);
out.push(``);
out.push(`① 裁剪（AI 侧收到的正文比用户看到的短）`);
out.push(`   memory_search 上限 ${CLIP_SEARCH} 字：${clippedSearch} 条被裁剪（${pct(clippedSearch)}），累计隐藏 ${hiddenSearch} 字`);
out.push(`   memory_context 上限 ${CLIP_CONTEXT} 字：${clippedContext} 条被裁剪（${pct(clippedContext)}），累计隐藏 ${hiddenContext} 字`);
out.push(`   说明：裁剪规则为「空白折叠后取前 N 字」，UI 详情弹窗已按同一规则呈现并标 ✂`);
out.push(``);
out.push(`② AI 检索不可见：${invisible} 条（${pct(invisible)}）—— 用户在列表能看到，但 AI 检索不会命中`);
for (const [k, c] of [...reasons.entries()].sort((a, b) => b[1] - a[1]))
    out.push(`   - ${k}：${c} 条`);
out.push(`   门槛：status='active' 且 eff>${EFF_FLOOR}（search.js / report.topMemories 同规则）`);
out.push(``);
out.push(`③ 被裁剪最多的记忆 Top5（建议把结论前置到前 ${CLIP_SEARCH} 字内）`);
for (const w of worst.sort((a, b) => b.hidden - a.hidden).slice(0, 5))
    out.push(`   #${w.id}  折叠后 ${w.normLen} 字 → AI 只收到 ${CLIP_SEARCH} 字，隐藏 ${w.hidden} 字`);
out.push(``);
out.push(`④ 抽样：AI 侧 memory_search 原文（与详情弹窗「AI 实际收到的内容」逐字一致）`);
for (const r of rows.slice(0, 3)) {
    const v = aiViews({ ...r, eff: r.eff_confidence ?? r.confidence });
    const s = v.search.length > 200 ? v.search.slice(0, 200) + "…" : v.search;
    out.push(`   ${s}`);
    out.push(`   （折叠后 ${v.normLen} 字${v.searchClipped ? `，已裁剪 ${v.searchHidden} 字` : "，未裁剪"}）`);
}
out.push(``);
out.push(`注：本脚本只读，不写库；AI 侧输出由 dist/format.js 统一生成，与本巡检同源。`);
const text = out.join("\n");
console.log(text);
fs.writeFileSync(path.resolve(HERE, "..", "data", "wysiwyg-inspect.log"), text, "utf8");
