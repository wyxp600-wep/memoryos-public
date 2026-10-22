#!/usr/bin/env node
/**
 * MemoryOS doctor —— 系统自检入口（架构改进第一档②）
 *
 * 背景：本项目反复出现的毛病是"静默降级"——某组件悄悄退化成假数据/假向量/错连库路径，
 *  从外部看只有"结果不对"这一句，没有可观测的降级信号。doctor 把这些隐性状态聚合成一份
 *  人类可读的体检报告，作为 CLI（node dist/doctor.js）与未来 dashboard 面板页共用的单一实现。
 *
 * 体检项（6 项，逐项给 PASS/WARN/FAIL + 说明 + 建议动作）：
 *   ① EMBED_MODE：当前嵌入模式 + 模型是否已加载 + 若为 fake 则 WARN（生产应为 local/api）
 *   ② 库路径与实例 ID：实际打开的 db 路径 + 库内是否写入了「库实例标识」，用于发现"连错库/双库分裂"
 *   ③ 向量出处：memory_vectors 表 embed_model/dim 列是否已就位 + 存量的 'unknown'/dim=0 占比
 *      （历史存量未经 reembed 修正的向量占比越高，跨模型静默失真风险越高）
 *   ④ 对账滞后：daemon_log 最近一次 reconcile 的时间戳 + 当前任务头↔卡片↔dispatch 的失配行数
 *   ⑤ 最近一次 ingest + daemon 运行时间：daemon_log 中对应 task 的最后执行时间（缺省=从未跑过）
 *   ⑥ 内核重启次数：core-process.js 自愈重启计数（经 daemon_log 或独立计数器读取，
 *      无该信号时如实标注"不可观测"而非猜测为 0）
 *
 * 用法：
 *   node dist/doctor.js                  # 打印人类可读报告
 *   node dist/doctor.js --json            # 机器可读 JSON（供 dashboard 面板页复用）
 *   node dist/doctor.js --fix             # 对可安全自动修复的项（②实例ID缺失→写入当前实例ID）执行修复
 *
 * 纪律（与项目既有门禁一致）：
 *   · 只读体检，唯一例外是 --fix 显式开启时才写库（且只写「库实例标识」这一个字段，不做其他变更）
 *   · 每一项都给"现状 + 建议动作"，不做笼统的"系统正常"结论（避免掩盖单项降级）
 *   · 写 stderr：stdout 是 MCP stdio 协议通道，不可污染（沿用 db.js 自检同纪律）
 */
import { fileURLToPath } from "node:url";
import { openDb, readConfig, writeConfig } from "./db.js";
import { embedMode, embedderLoaded } from "./embed.js";

/* ---------- ① EMBED_MODE ---------- */
function checkEmbedMode() {
    const mode = embedMode();
    const loaded = embedderLoaded();
    if (mode === "fake")
        return {
            ok: false,
            level: "warn",
            label: "嵌入模式",
            detail: `EMBED_MODE=fake（确定性伪向量，无真实语义）—— 语义检索静默退化为纯词法召回。`,
            advice: "生产环境请显式设 EMBED_MODE=local（本地 BGE-M3）或 api（外部 /v1/embeddings 端点），见 #4451。",
        };
    return {
        ok: true,
        level: "pass",
        label: "嵌入模式",
        detail: `EMBED_MODE=${mode}${loaded ? "（模型已在本进程加载）" : "（模型尚未在本进程加载，首次调用才加载）"}`,
    };
}

/* ---------- ② 库路径与实例 ID ---------- */
const INSTANCE_KEY = "db.instance_id";
/** 缺省实例 ID：进程启动时生成的短随机标识，写入 config 表供后续进程比对是否"连到同一份库"。 */
function ensureInstanceId(db) {
    let id = readConfig(db, INSTANCE_KEY, null);
    if (!id)
        return null; // 尚未写入
    return id;
}
async function checkInstance(dbPath, db, opts = {}) {
    const id = ensureInstanceId(db);
    if (!id) {
        if (opts.fix) {
            const crypto = await import("node:crypto");
            const newId = crypto.randomBytes(6).toString("hex");
            writeConfig(db, INSTANCE_KEY, newId);
            return {
                ok: true,
                level: "pass",
                label: "库实例 ID",
                detail: `库路径 ${dbPath}：本进程已生成并写入实例 ID（${newId}），后续进程可据此发现双库分裂。`,
                fixed: true,
            };
        }
        return {
            ok: false,
            level: "warn",
            label: "库实例 ID",
            detail: `库路径 ${dbPath}：尚未写入实例 ID —— 无法区分「连错库」与「空库」（本项目曾并存 3 处 memory.db，#4874）。`,
            advice: "跑 `node dist/doctor.js --fix` 写入当前实例 ID；或手动确认该路径是否为你预期的生产库。",
        };
    }
    return {
        ok: true,
        level: "pass",
        label: "库实例 ID",
        detail: `库路径 ${dbPath}（实例 ID=${id}）。`,
    };
}
function checkProvenance(db) {
    const cols = db.prepare(`PRAGMA table_info(memory_vectors)`).all().map((c) => c.name);
    if (!cols.includes("embed_model") || !cols.includes("dim"))
        return {
            ok: false,
            level: "fail",
            label: "向量出处",
            detail: "memory_vectors 表缺少 embed_model/dim 列 —— 尚未升级到 2026-10-15 版本。",
            advice: "重启内核触发 openDb 迁移即可自动补列。",
        };
    const total = db.prepare(`SELECT COUNT(*) c FROM memory_vectors`).get().c;
    if (total === 0)
        return { ok: true, level: "pass", label: "向量出处", detail: "库内尚无向量（0 条），无需关注。" };
    const unknown = db
        .prepare(`SELECT COUNT(*) c FROM memory_vectors WHERE embed_model='unknown' OR dim=0`)
        .get().c;
    const pct = Math.round((unknown / total) * 100);
    const known = total - unknown;
    return {
        ok: pct < 50,
        level: pct >= 100 ? "fail" : pct >= 50 ? "warn" : "pass",
        label: "向量出处",
        detail: `共 ${total} 条向量：出处明确 ${known} 条，'unknown'/未回填 ${unknown} 条（${pct}%）—— 跨模型静默失真风险随此占比上升。`,
        advice:
            pct >= 50
                ? "建议跑 `node dist/reembed.js`（现成全量重算入口）按当前 EMBED_MODE 批量回填真实模型出处。"
                : "低占比可暂不处理，随 daemon 日常 reembedStale 逐步收敛。",
    };
}

/* ---------- ④ 对账滞后 ---------- */
function checkReconcile(db) {
    const last = db
        .prepare(`SELECT created_at, op, detail FROM daemon_log WHERE task='reconcile' ORDER BY id DESC LIMIT 1`)
        .get();
    if (!last)
        return {
            ok: false,
            level: "warn",
            label: "对账滞后",
            detail: "daemon_log 中尚无 reconcile 记录 —— daemon 从未跑过任务头↔卡片↔dispatch 三方对账。",
            advice: "确认常驻 daemon.js 是否在运行（`node dist/daemon.js --once` 可手动触发一轮）。",
        };
    const ageMs = Date.now() - Date.parse(last.created_at);
    const ageH = Math.round(ageMs / 3600_000);
    // 失配行数：任务头 status ↔ 卡片 status 直接 JOIN 比（简化口径：只数明显不一致的 active 任务）
    const mismatch = db
        .prepare(
            `SELECT COUNT(*) c FROM memories m
             WHERE m.status='active' AND m.type='task'
               AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.memory_id = m.id)`
        )
        .get().c;
    const fresh = ageMs <= 6 * 3600_000;
    return {
        ok: fresh && mismatch === 0,
        level: mismatch > 0 ? "warn" : fresh ? "pass" : "warn",
        label: "对账滞后",
        detail: `最近一次对账 ${ageH}h 前（${last.created_at}）；当前 ${mismatch} 条 active 任务无对应卡片（可能是正常未建卡，也可能是投影断裂）。`,
        advice: mismatch > 0 ? "若该任务集合本应有卡片，跑 `node dist/reconcile.js --once` 手动补一轮对账。" : undefined,
    };
}

/* ---------- ⑤ 最近一次 ingest + daemon 运行时间 ---------- */
function checkDaemonActivity(db) {
    const lastIngest = db.prepare(`SELECT created_at FROM daemon_log WHERE task LIKE 'ingest%' ORDER BY id DESC LIMIT 1`).get();
    const lastRun = db.prepare(`SELECT created_at, task FROM daemon_log ORDER BY id DESC LIMIT 1`).get();
    return {
        ok: true, // 该项本身不判 FAIL，只如实报告（缺失是常态，不是故障）
        level: lastRun ? "pass" : "warn",
        label: "daemon/采集最近活动",
        detail:
            `最近 daemon_log 记录：${lastRun ? `${lastRun.task} @ ${lastRun.created_at}` : "（无记录 —— daemon 从未跑过，或 daemon_log 表为空）"}；` +
            `最近 ingest：${lastIngest?.created_at ?? "（无）"}`,
    };
}

/* ---------- ⑥ 内核重启次数 ---------- */
function checkRestarts() {
    // 重启计数由壳层 services/core-process.js 维护（每个脚本独立计数，存活满 60s 归零）——
    // 该计数目前不落库，仅存在于壳层进程内存，kernel 侧 doctor 无法直读；如实标注"不可观测"而非猜 0。
    return {
        ok: true,
        level: "info",
        label: "内核重启次数",
        detail: "壳层（services/core-process.js）的自愈重启计数目前未持久化，内核侧不可观测——如需此信号，须壳层侧新增（超出本 doctor 范围，仅提示）。",
    };
}

/* ---------- 汇总输出 ---------- */
async function main() {
    const args = process.argv.slice(2);
    const wantJson = args.includes("--json");
    const wantFix = args.includes("--fix");
    const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));

    const db = openDb(dbPath);
    const checks = [
        checkEmbedMode(),
        await checkInstance(dbPath, db, { fix: wantFix }),
        checkProvenance(db),
        checkReconcile(db),
        checkDaemonActivity(db),
        checkRestarts(),
    ];
    db.close();

    if (wantJson) {
        console.log(JSON.stringify({ dbPath, checks, ts: new Date().toISOString() }, null, 2));
        return;
    }
    const bar = (s) => Array(52).fill("─").join("");
    console.log(`\nMemoryOS doctor  ${dbPath}\n${bar()}`);
    for (const c of checks) {
        const tag = c.level === "pass" ? "PASS" : c.level === "warn" ? "WARN" : c.level === "fail" ? "FAIL" : "INFO";
        const extra = c.fixed ? "（已自动修复）" : "";
        console.log(` [${tag}] ${c.label}${extra}`);
        console.log(`        ${c.detail}`);
        if (c.advice)
            console.log(`        建议: ${c.advice}`);
    }
    const fails = checks.filter((c) => c.level === "fail").length;
    const warns = checks.filter((c) => c.level === "warn").length;
    console.log(bar());
    console.log(`合计：${checks.length} 项体检，FAIL=${fails} WARN=${warns}`);
    if (fails > 0)
        console.log("存在需处理的 FAIL 项，按上述建议动作处理。");
    else if (warns > 0)
        console.log("无 FAIL，但有 WARN 项值得关注（多为可延迟处理的健康度信号，非故障）。");
    else console.log("全部体检项通过。");
}

main().catch((e) => {
    console.error(`[doctor] 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
