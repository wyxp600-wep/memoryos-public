#!/usr/bin/env node
/**
 * MemoryOS — 路由响应快照（P2-3 / T8 拆分 buildApp 的**验收前置**）
 *
 * 为什么先做这个：T8 要把 dashboard.js 里 2246 行的 buildApp() 拆成模块，硬要求是
 * 「96 条路由的路径与响应体**逐字节不变**」（报告 §2.A 潜在风险 2）。没有基线就无法证明"没改行为"，
 * 靠人工点测必然漏。本工具把"拆分前"的行为固化成可比对快照，拆分后 `--check` 一条命令判定。
 *
 * 用法（cwd = resources/memoryos）：
 *   node dist/snapshot-routes.js                # 生成快照 → outputs/route-snapshot.json（不碰生产库）
 *   node dist/snapshot-routes.js --check        # 与 outputs/route-snapshot.json 比对，差异即非零退出
 *   node dist/snapshot-routes.js --out <path>   # 指定快照路径
 *
 * 隔离：临时库 + 固定夹具 + 固定令牌；**不使用生产库**。
 * 归一化：剥离易变字段（时间戳/uptime/pid/duration 等）与绝对路径，保证同代码两次运行快照一致。
 * 覆盖：自动发现全部**无参数 GET 路由**（`:` 动态段路由需构造参数据，另行补；见输出清单）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, writeMemory } from "./db.js";
import { buildApp } from "./dashboard.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const CHECK = argv.includes("--check");
const STRICT = argv.includes("--strict");
const OUT = path.resolve(ROOT, opt("out", path.join("..", "..", "outputs", "route-snapshot.json")));
const TOKEN = "snapshot-token-fixed";

/**
 * ★ 环境依赖路由（2026-09-16 补）：这些端点的响应**随机器/磁盘/外部程序状态变化**，与代码行为无关。
 *   实测三例：/api/scan-agents 上报外部 CLI 自身版本（Claude Code 2.1.227→2.1.273 即变）；
 *   /api/ingest/sources 上报 83 个来源文件的**实时 size**；/api/agent/status 含当前工具面与连接数。
 *   若把它们当硬失败，基线会快速腐烂 → 噪声吃掉告警力（与「验证器防空转」同源的教训）。
 *   故单独列 WARN：默认不影响退出码，`--strict` 时升级为失败（用于发布前对齐环境）。
 */
const ENV_DRIFT_ROUTES = new Set([
    "/api/scan-agents",                 // 上报外部 CLI 自身版本（实测 Claude Code 2.1.227→2.1.273 即变）
    "/api/ingest/sources",              // 上报 83 个来源文件的**实时 size**
    "/api/agent/status",                // 含当前工具面（随 MCP 注册数变化）与连接数
    "/api/rules/project-candidates",    // 扫 ~/Desktop|~/WorkBuddy|~/Documents 目录 + hasAgents(AGENTS.md 是否存在)
    "/api/skills/status",               // 上报宿主机 skill 文件目录（~60 条 *__skillhub，随 DSH/会话更新 skill 文件而变；2026-09-16 实测 +40B）
    "/api/worktrees",                   // 上报磁盘真实 worktree 列表（建/删即变，与代码行为无关；2026-10-03 workbench 域新增）
    "/api/github/status",               // 上报 workspace git remote + GitHub API 仓库状态（配置/网络依赖；2026-10-03 github 域新增）
    "/api/github/issues",               // GitHub REST 列表（未配置时 400 确定性；配置后随网络变化）
    "/api/github/pulls",                 // 同上（PR 列表）
    "/api/design/status",                // 上报设计会话状态（起/关即变，随运行态漂移；2026-10-03 design 域新增）
    "/api/design/picks",                 // 上报拾取结果 FIFO + 截图（会话态，无会话时恒空；2026-10-03 design 域新增）
    // ★ 2026-10-05 批4（git 分工地基）：以下三条响应体含**本机绝对路径/本机配置**，
    //   主树跑没问题，但任何 `git worktree` 分支或新克隆里 WORKSPACE/dataDir/文件清单都不同 → 必报假硬差异，
    //   直接堵死「每 agent 一 worktree」的作业方式。实测（同一 commit 384d986，主树 vs worktree）：
    //   /api/config 359B→456B、/api/agent-models 73B→115B、/api/plans 1418B→1554B。
    //   降级为 WARN 只放开「响应体字节」这一层：routeTable 增删与结构契约（键集合）仍无条件硬失败。
    "/api/config",                      // 上报 dataDir / dbPath / port（绝对路径与端口，随实例与工作区变）
    "/api/agent-models",                // 上报设置页 llmUrl/llmModel + 本机 Ollama /api/tags + 档案用过的模型（本机态）
    "/api/plans",                       // 读 PLANS_DIR 磁盘文件清单（路径与内容随工作区变）
]);

/* ── 固定夹具（全部确定性：显式给 created_at，避免"同秒并列"以外的抖动） ── */
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-snap-"));
const DB = path.join(WS, "snapshot.db");

const normalize = (v) => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            // 易变键：时间类 + 计时统计（T14 查询可观测的 max/p50/p95 每次运行天然抖动）
            if (/^(ts|time|timestamp|uptime|uptimeMs|now|pid|duration|durationMs|elapsed|startedAt|lastRun|max|min|avg|p50|p95|p99|hoursSince)$/i.test(k)) { out[k] = "«volatile»"; continue; }
            out[k] = normalize(val);
        }
        return out;
    }
    if (typeof v === "string") {
        // 时间戳（ISO 与 SQLite `YYYY-MM-DD HH:MM:SS` 两种格式）→ 占位；绝对路径 → 占位
        return v
            .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "«ts»")
            .replace(/\d{4}-\d{2}-\d{2}/g, "«date»")
            .replace(/[A-Za-z]:\\\\?[^\s"']+/g, "«path»")
            .replace(/\/[\w./-]{8,}/g, "«path»");
    }
    return v;
};
const maskVolatile = (obj) => normalize(obj);

const db = openDb(DB);
// 夹具：3 条 active（含 1 条 secret）+ 1 条 archived + 1 条 decision + 1 条任务
const w = (content, extra = {}) => writeMemory(db, {
    content, type: extra.type ?? "experience", agent: extra.agent ?? "snapshot",
    agent_fpath: null, project: extra.project ?? "global", embedding: null, ...extra,
});
const m1 = w("快照夹具 A：端口 80 被 IIS 占用时先查 W3SVC 服务状态");
const m2 = w("快照夹具 B：微信回调时间戳容差需设 5 分钟");
const m3 = w("快照夹具 C:secret 敏感样本（内容不应出现在任何响应里）", { sensitivity: "secret" });
const m4 = w("快照夹具 D：已归档样本", { type: "decision" });
w("[task][assignee:snapshot][status:pending] 快照夹具任务：验证路由快照稳定", { type: "task" });
db.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(m4.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-2 days') WHERE id=?`).run(m2.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-5 days') WHERE id=?`).run(m3.id);
void m1;

const app = buildApp(db, { token: TOKEN });
await app.ready();

/* ── 路由发现：解析 printRoutes({ commonPrefix:false }) 的树形文本 ──
 * 真实格式（Fastify v5 实测）：
 *   └── / (GET, HEAD)
 *       ├── api/summary (GET, HEAD)
 *       ├── api/cards (GET, HEAD, POST)
 *       │   └── /archive (GET, HEAD, POST)      ← 子段自带前导 /
 *       ├── api/task (POST)
 *       │   └── s (GET, HEAD)                   ← ★ 公共前缀被上提到父节点：真实路径是 /api/tasks
 *       ├── api/rules/sync (POST)
 *       │   └── -targets (GET, HEAD)            ← ★ 真实 /api/rules/sync-targets
 * 两种子段形态都会出现，因此拼接规则是**纯字符串相接**（不插 `/`）：
 *   full = parent === "/" ? "/" + seg去前导斜杠 : parent + seg
 * ★ 此处原实现无条件插 `/`，导致 4 条路由误拼（其中 2 条以 404 幻影计入覆盖）——
 *   该缺陷由独立会话复核发现（见 T8-验收门禁独立验证-20260915.md §三），已修正。
 * 每层缩进 4 字符（`│   ` / `    `），据缩进还原层级。 */
function parseRouteTree(tree) {
    const out = [];
    const stack = [];                       // depth → 完整路径
    for (const line of tree.split("\n")) {
        const m = line.match(/^([│├└─\s]*)(\S.*?)\s*\(([A-Z, ]+)\)\s*$/);
        if (!m) continue;
        const depth = Math.floor(m[1].length / 4);
        const seg = m[2].trim();
        const methods = m[3].split(",").map((s) => s.trim()).filter(Boolean);
        let full;
        if (seg === "/") full = "/";
        else {
            const parent = stack[depth - 1] ?? "/";
            full = parent === "/" ? `/${seg.replace(/^\/+/, "")}` : `${parent}${seg}`;
        }
        stack[depth] = full;
        stack.length = depth + 1;
        for (const method of methods) out.push({ method, path: full });
    }
    return out;
}
const tree = app.printRoutes({ commonPrefix: false });
const routeTable = parseRouteTree(tree);                 // 全部 method+path（结构契约）
const routes = routeTable;
/* ★ SSE 流式路由（2026-09-18 补）：无限连接 + 增量推送，inject 会永久挂起、响应体无法逐字节快照。
 *   从「无参 GET 快照」中剔除（结构契约仍覆盖其注册——漏注册/改名可被 routeTable 捕获）。 */
const STREAM_ROUTES = new Set(["/api/cards/stream"]);
const gettable = routes.filter((r) => r.method === "GET" && !r.path.includes(":") && !STREAM_ROUTES.has(r.path));
const dynamic = routes.filter((r) => r.method === "GET" && r.path.includes(":"));
const nonGet = routes.filter((r) => r.method !== "GET");
/* ★ 覆盖口径（独立复核后补强）：
 *  ① routes   —— 无参 GET：记录 status/contentType/sha256/body（逐字节可比）；
 *  ② probes   —— 动态段 GET：把 `:xxx` 用真实夹具 id 代入后请求，记录 status+body 摘要
 *                （不代入则无从触发，等于零覆盖）；
 *  ③ routeTable —— **全部** method+path 的结构契约（含 100 条非 GET）：T8 拆分最常见的事故是
 *                路由漏注册/改名，结构契约可直接判定，且**不对非 GET 发起真实请求**（避免副作用，
 *                如 POST /api/skills/sync 会真的写盘）。这一条是本门禁对"仅 GET 覆盖"缺口的补齐。
 *  明确不做的：非 GET 的**响应体**比对（需要构造合法 payload，且副作用不可控）——见输出提示。 */
/* ★ 防空转守卫：解析失败会让快照"0 条全一致"从而假绿 —— 低于下限一律判失败 */
const MIN_EXPECTED_GET = 20;
if (gettable.length < MIN_EXPECTED_GET) {
    console.error(`❌ 路由发现异常：仅解析到 ${gettable.length} 条无参 GET 路由（下限 ${MIN_EXPECTED_GET}）—— printRoutes 格式可能变化，勿把空结果当作"一致"。`);
    await app.close();
    try { db.close(); } catch { /* 已关 */ }
    process.exit(1);
}

const snapshot = {
    token: TOKEN,
    // ★ meta：基线必须能自证"对应哪个代码版本"，否则重定基线会变成掩盖变更的手段
    meta: {
        generatedAt: new Date().toISOString(),
        node: process.version,
        gitRev: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "unknown"; } })(),
        gitDirty: (() => { try { return execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean).length > 0; } catch { return null; } })(),
        envDriftRoutes: [...ENV_DRIFT_ROUTES],
    },
    routeTable: routes.map((r) => `${r.method} ${r.path}`).sort(),
    routes: [],
    probes: [],
    skipped: { nonGetPaths: nonGet.map((r) => `${r.method} ${r.path}`), streamRoutes: [...STREAM_ROUTES] },
};
for (const r of gettable) {
    const res = await app.inject({ method: "GET", url: r.path, headers: { "x-memory-token": TOKEN } });
    const ct = String(res.headers["content-type"] ?? "");
    let payload = res.body;
    let kind = "text";
    try { payload = maskVolatile(JSON.parse(res.body)); kind = "json"; } catch { /* 非 JSON */ }
    const bodyStr = kind === "json" ? JSON.stringify(payload) : String(payload);
    snapshot.routes.push({
        path: r.path,
        status: res.statusCode,
        contentType: ct.split(";")[0],
        contentLength: Buffer.byteLength(res.body, "utf8"),
        sha256: crypto.createHash("sha256").update(bodyStr).digest("hex").slice(0, 16),
        body: bodyStr.length <= 4000 ? bodyStr : bodyStr.slice(0, 4000) + "«truncated»",
    });
}
// ② 动态段 GET：以真实夹具 id 代入（保证至少一条是 200，其余为确定性的 404）
for (const r of dynamic) {
    const url = r.path.replace(/:[A-Za-z_][\w]*/g, String(m1.id));
    const res = await app.inject({ method: "GET", url, headers: { "x-memory-token": TOKEN } });
    let payload = res.body;
    try { payload = JSON.stringify(maskVolatile(JSON.parse(res.body))); } catch { /* 非 JSON */ }
    snapshot.probes.push({
        path: r.path,
        probedUrl: url,
        status: res.statusCode,
        sha256: crypto.createHash("sha256").update(String(payload)).digest("hex").slice(0, 16),
        body: String(payload).length <= 2000 ? String(payload) : String(payload).slice(0, 2000) + "«truncated»",
    });
}
// 鉴权面：无令牌应 401（fail-closed 也是行为契约的一部分，纳入快照）
const noTok = await app.inject({ method: "GET", url: "/api/summary" });
snapshot.auth = { noTokenStatus: noTok.statusCode };
await app.close();
try { db.close(); } catch { /* 已关 */ }
try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* Windows 句柄未即时释放 */ }

console.log(`发现路由 ${routes.length} 条：无参 GET 快照 ${gettable.length} 条｜动态段 GET 探针 ${dynamic.length} 条｜结构契约覆盖全部 ${routes.length} 条（含非 GET ${nonGet.length} 条，不发起请求）`);
console.log(`鉴权契约：无令牌 /api/summary → ${snapshot.auth.noTokenStatus}`);

if (!CHECK) {
    // ★ 2026-10-05 批4：在脏树上生成的基线会把「未提交的响应体」固化成真相，之后任何干净检出
    //   （worktree 分支 / 新克隆 / CI）都读成硬回归。实测：并行会话在 app.js/index.html 未提交时
    //   重定基线 → 本批变基后 `snapshot:check` 平白多出 `/` 与 `/app.js` 两处 ❌（A/B 证明与本批无关）。
    //   故生成侧先喊话（不改退出码，避免阻断他人），检查侧再复核一次。
    if (snapshot.meta?.gitDirty)
        console.warn("\n⚠⚠ 基线是在**有未提交改动的工作树**上生成的：基线固化了未提交版本的响应体，"
            + "\n   之后任何干净检出（worktree 分支 / 新克隆 / CI）都会被判成硬回归。"
            + "\n   规程要求：先提交（或 stash 干净）再跑 `npm run snapshot`。本次仍已写入，不阻断。\n");
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`✅ 快照已写入：${OUT}`);
    process.exit(0);
}

/* ── --check：结构契约 + 无参 GET 响应体 + 动态段探针 + 鉴权，逐条比对 ── */
if (!fs.existsSync(OUT)) { console.log(`❌ 找不到基线快照：${OUT}（先不带 --check 跑一次生成）`); process.exit(1); }
const base = JSON.parse(fs.readFileSync(OUT, "utf8"));
let diff = 0, drift = 0;
if (base.meta) console.log(`基线版本：git ${base.meta.gitRev}${base.meta.gitDirty ? "（含未提交改动）" : ""} @ ${base.meta.generatedAt}（node ${base.meta.node}）\n`);
if (base.meta?.gitDirty)
    console.warn("⚠ 本基线生成时工作树有未提交改动 → 下面的「响应体硬差异」可能只是基线本身脏，不是代码回归；"
        + "先提交再 `npm run snapshot` 重定，再判定红绿。\n");

// ① 结构契约：路由漏注册/改名/新增（含 100 条非 GET）
const baseTable = new Set(base.routeTable ?? []);
const curTable = new Set(snapshot.routeTable);
for (const k of baseTable) if (!curTable.has(k)) { console.log(`❌ 路由消失：${k}`); diff++; }
for (const k of curTable) if (!baseTable.has(k)) { console.log(`❌ 新增路由（需确认是否有意为之）：${k}`); diff++; }

// ② 无参 GET 响应体
const baseMap = new Map(base.routes.map((r) => [r.path, r]));
const curMap = new Map(snapshot.routes.map((r) => [r.path, r]));
for (const [p, b] of baseMap) {
    const c = curMap.get(p);
    if (!c) { console.log(`❌ GET 路由消失：${p}`); diff++; continue; }
    const changed = c.status !== b.status || c.sha256 !== b.sha256;
    if (!changed) continue;
    if (ENV_DRIFT_ROUTES.has(p)) {
        drift++;
        console.log(`⚠ 环境漂移（非代码回归）：${p} ${b.status}/${b.contentLength}B → ${c.status}/${c.contentLength}B`);
        continue;
    }
    if (c.status !== b.status) { console.log(`❌ ${p} status ${b.status} → ${c.status}`); diff++; }
    else { console.log(`❌ ${p} 响应体变化（${b.contentLength}B/${b.sha256} → ${c.contentLength}B/${c.sha256}）`); diff++; }
}

// ③ 动态段 GET 探针
const baseProbe = new Map((base.probes ?? []).map((r) => [r.path, r]));
for (const r of snapshot.probes) {
    const b = baseProbe.get(r.path);
    if (!b) { console.log(`❌ 新增动态段 GET：${r.path}`); diff++; continue; }
    if (r.status !== b.status || r.sha256 !== b.sha256) {
        if (ENV_DRIFT_ROUTES.has(r.path)) { drift++; console.log(`⚠ 环境漂移（非代码回归）：${r.path}`); continue; }
        console.log(`❌ ${r.path} 探针变化（${b.status}/${b.sha256} → ${r.status}/${r.sha256}）`); diff++;
    }
}

// ④ 鉴权契约
if (snapshot.auth.noTokenStatus !== base.auth.noTokenStatus) { console.log(`❌ 鉴权契约变化：无令牌 ${base.auth.noTokenStatus} → ${snapshot.auth.noTokenStatus}`); diff++; }

const strictFail = STRICT && drift > 0;
console.log(diff
    ? `\n== 快照比对：${diff} 处硬差异（T8 类重构必须 0）${drift ? ` + ${drift} 处环境漂移` : ""} ==`
    : `\n== 快照比对：结构契约 ${baseTable.size} 条 + 无参 GET ${baseMap.size} 条 + 动态段探针 ${snapshot.probes.length} 条 + 鉴权 逐项一致 ✅${drift ? `（另有 ${drift} 处环境漂移，已单列不计入失败）` : ""} ==`);
console.log("提示：非 GET 仅做结构契约（不比对响应体）—— 其响应需构造合法 payload 且部分端点有副作用（如 skills/sync 写盘），故不纳入自动比对。");
if (drift) console.log(`环境漂移路由：${[...ENV_DRIFT_ROUTES].join(", ")}（--strict 时按失败处理）`);
process.exit(diff || strictFail ? 1 : 0);
