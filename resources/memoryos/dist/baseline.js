/**
 * MemoryOS · 效果指标基线提取（首期运行）
 *
 * 从 sqlite memory_usage + daemon_log + session jsonl + threads.md 聚合：
 *   - 漏斗（write/returned/cited/inferred）
 *   - CONFLICT 标记数（扫描 session jsonl + threads.md）
 *   - MEMHIT 标记数（扫描 threads.md）
 *   - 仲裁事件数（daemon_log + memory_events）
 *   - 僵尸记忆数（active+hit_count=0+超30天）
 *   - 回写合规估算（write 事件 vs 疑似结论未回写会话数）
 *
 * 输出：Markdown 报告，可落盘至 archive/health/baseline-<date>.md
 *
 * 用法：
 *   node dist/baseline.js                          （默认 DB + 默认路径）
 *   node dist/baseline.js --db <path>              （指定 DB）
 *   node dist/baseline.js --out <path>             （指定输出文件）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, pendingConflicts } from "./db.js";
import { funnel, zombies } from "./report.js";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEMORY_ROOT = process.env.MEMORY_ROOT ?? "c:/Users/WYX/.trae-cn/memory";
const DEFAULT_DB = path.join(ROOT, "data/memory.db");
const PROJECT_DIR = path.join(MEMORY_ROOT, "projects");
function scanSessionJsonl(dir) {
    let conflicts = 0;
    let memhits = 0;
    if (!fs.existsSync(dir))
        return { conflicts, memhits };
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
        if (typeof entry !== "string")
            continue;
        const full = entry;
        if (!fs.statSync(full).isFile())
            continue;
        if (!full.endsWith(".jsonl"))
            continue;
        const lines = fs.readFileSync(full, "utf8").split("\n");
        for (const line of lines) {
            const t = line.trim();
            if (!t)
                continue;
            if (t.includes("CONFLICT:"))
                conflicts++;
            if (t.includes("MEMHIT:"))
                memhits++;
        }
    }
    return { conflicts, memhits };
}
function scanThreadsMd(dir) {
    let conflicts = 0;
    let memhits = 0;
    const threadsPath = path.join(dir, "threads.md");
    if (!fs.existsSync(threadsPath))
        return { conflicts, memhits };
    const text = fs.readFileSync(threadsPath, "utf8");
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t)
            continue;
        if (t.startsWith("<!--"))
            continue; // 跳过注释行（防假阳性）
        if (t.includes("CONFLICT:"))
            conflicts++;
        if (t.includes("MEMHIT:"))
            memhits++;
    }
    return { conflicts, memhits };
}
function gatherAllMetrics(db) {
    const now = new Date().toISOString().slice(0, 10);
    const f = funnel(db, {});
    const z = zombies(db, { days: 30 });
    const pc = pendingConflicts(db);
    const totalMem = db.prepare("SELECT COUNT(*) c FROM memories").get().c;
    const activeMem = db.prepare("SELECT COUNT(*) c FROM memories WHERE status='active'").get().c;
    const eventCounts = db.prepare("SELECT event, COUNT(*) c FROM memory_usage GROUP BY event").all();
    const eventMap = {};
    for (const e of eventCounts)
        eventMap[e.event] = e.c;
    // 扫描明文侧标记
    const projectNames = fs.existsSync(PROJECT_DIR)
        ? fs.readdirSync(PROJECT_DIR).filter((d) => fs.statSync(path.join(PROJECT_DIR, d)).isDirectory())
        : [];
    let totalConflicts = 0;
    let totalMemhits = 0;
    for (const pn of projectNames) {
        const projPath = path.join(PROJECT_DIR, pn);
        const s = scanSessionJsonl(projPath);
        const t = scanThreadsMd(projPath);
        totalConflicts += s.conflicts + t.conflicts;
        totalMemhits += s.memhits + t.memhits;
    }
    // 仲裁事件统计
    const arbCounts = db.prepare("SELECT op, COUNT(*) c FROM memory_events GROUP BY op").all();
    const arbMap = {};
    for (const a of arbCounts)
        arbMap[a.op] = a.c;
    return {
        reportDate: now,
        total_memories: totalMem,
        active_memories: activeMem,
        funnel: Object.fromEntries(f.map((r) => [r.name, r.value])),
        zombie_count_30d: z.length,
        pending_conflicts: pc.length,
        conflict_markers_plaintext: totalConflicts,
        memhit_markers_plaintext: totalMemhits,
        arbitration_events: arbMap,
        usage_event_counts: eventMap,
    };
}
function renderMarkdown(m) {
    const date = m.reportDate;
    const funnel = m.funnel;
    const arb = m.arbitration_events;
    const usage = m.usage_event_counts;
    const lines = [
        `# MemoryOS 效果指标基线`,
        ``,
        `> 生成时间：${date}｜这是首期基线，后续月跑对比此项以判断趋势。`,
        ``,
        `## 记忆库规模`,
        `- 总记忆：${m.total_memories} 条`,
        `- 活跃（active）：${m.active_memories} 条`,
        `- 待仲裁冲突：${m.pending_conflicts} 条`,
        `- 僵尸（active 且超 30 天 0 命中）：${m.zombie_count_30d} 条`,
        ``,
        `## 使用漏斗（全量，无时间窗）`,
        `- write：${funnel.write ?? 0}`,
        `- returned（去重 memory）：${funnel["returned(去重memory)"] ?? 0}`,
        `- raw_cited：${funnel.raw_cited ?? 0}`,
        `- inferred_cited：${funnel.inferred_cited ?? 0}`,
        `- adopted(≈采用)：${funnel["adopted(≈采用,raw+inferred)"] ?? 0}`,
        `- x（未采用）：${funnel["x(未被采用,write-adopted)"] ?? 0}`,
        ``,
        `## 明文侧标记统计`,
        `- CONFLICT 标记总数：${m.conflict_markers_plaintext}（session jsonl + threads.md，注释行已跳过）`,
        `- MEMHIT 标记总数：${m.memhit_markers_plaintext}`,
        ``,
        `## 仲裁事件分布`,
        Object.entries(arb).map(([op, c]) => `- ${op}：${c}`).join("\n"),
        ``,
        `## 验收口径（D+30 判据初稿）`,
        `| 指标 | 目标 | 当前值 | 状态 |`,
        `|---|---|---|---|`,
        `| 纠错率（月度 CONFLICT 下降） | 持续下降 | N/A 首期 | ⏳ 待对比 |`,
        `| 记忆命中率（MEMHIT / returned） | ≥60% | ${m.memhit_markers_plaintext}/${(funnel["returned(去重memory)"] ?? 1) ?? "?"} | ⏳ 首期 |`,
        `| 闭环时延 | ≤1 会话 | 待 session 溯源 | ⏳ |`,
        `| 回写/格式合规率 | ≥90% | 待复盘审计 | ⏳ |`,
        `| 僵尸率 | 下降 | ${m.zombie_count_30d} 条 | ${Number(m.zombie_count_30d) > 10 ? "⚠" : "✅"} |`,
        ``,
        `> 注：首期无历史基线，所有指标状态为"待对比"。首月月跑时以此报告为基准。`,
    ];
    return lines.filter(Boolean).join("\n");
}
async function main() {
    const args = process.argv.slice(2);
    const dbPath = args.find((a) => a.startsWith("--db="))?.split("=")[1] ?? DEFAULT_DB;
    const outPath = args.find((a) => a.startsWith("--out="))?.split("=")[1]
        ?? path.join(ROOT, "..", "archive", "health", `baseline-${new Date().toISOString().slice(0, 10)}.md`);
    const db = openDb(dbPath);
    const m = gatherAllMetrics(db);
    const md = renderMarkdown(m);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md, "utf8");
    console.log(`[baseline] 报告已落盘: ${outPath}`);
    console.log("");
    console.log(md);
}
const mainFile = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (mainFile === "baseline.js" || mainFile === "baseline.ts") {
    main().catch((e) => {
        console.error(e);
        process.exit(2);
    });
}
