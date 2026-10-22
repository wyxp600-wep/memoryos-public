/**
 * MemoryOS v0.3 — Dashboard（M-2.3）
 * Fastify + 内嵌零构建前端（单 HTML 字符串，无静态资源/无构建）。
 * 监听 127.0.0.1:8787；复用 report.js 五查询 + db.js 治理原语。
 * 人工归档走 daemon_log 同一审计通道，operator=`human:dashboard`（14章 v0.3 [3]）。
 * 用法：
 *   node dist/dashboard.js                （默认 8787，MEMORY_DB 指定库）
 *   MEMORY_PORT=9000 node dist/dashboard.js
 * 冒烟：buildApp(db) 交给 smoke-dashboard.js 用 app.inject() 端到端测试。
 */
import Fastify from "fastify";
import { FastMCP } from "fastmcp";                            // ★ 2026-10-14（1a）：核心侧工具面容器（只注册，不 listen）
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { openDb, archiveMemory, logUsage, logDaemon, withTx, writeMemory, updateMemory, queryByType, rejectMemory, pendingConflicts, applyArbitration, markMerged, listWorkingMemory, setWorkingMemory, clearWorkingMemory, readMemory, queryStats } from "./db.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { funnel, trend, topMemories, zombies, crossTool } from "./report.js";
import { buildPlan, loadHygieneConfig, reembedStale } from "./daemon.js";
import { readConfig, writeConfig } from "./db.js";
import { scanAgents, connectGuideFor, applyConnectWrite, primeScanAgentsInWorker } from "./scan.js";
import { getSources, ingestAll, loadCustomSpecs, saveCustomSpecs, validateCustomSource, customSourcesPath } from "./ingest.js";
import { syncRules, syncProjectRules, getSyncTargets } from "./sync-rules.js";
import { detectVaults, importVault, exportMemories, vaultStatus, syncNotesIndex, demoteNoteLinks, writeNoteToVault } from "./obsidian-sync.js";
import { getEmbedder, cosine, bufToVec } from "./embed.js";
import { computeStatus, syncSkills, detectSkillTargets } from "./skill-sync.js";
import { createMcpClient, resolveLlm, runAgent, buildSystemPrompt } from "./agent-core.js";
import { protectSecret, unprotectSecret, forgetSecret } from "./secret-store.js";
import { probeEndpoint, normalizeLlmEndpoint, llmConf } from "./llm.js";
import { maybeRunRuleReflection } from "./rule-reflection.js"; // ★ 批次⑧：每日规则反思生产线（与 daemon 双钩子，认领门禁防双跑）
import { SECTORS, SECTOR_KEYS } from "./db.js";
import { registerCore } from "./dashboard-reg-core.js";
import { registerMemory } from "./dashboard-reg-memory.js";
import { registerPlans } from "./dashboard-reg-plans.js";
import { registerIngest } from "./dashboard-reg-ingest.js";
import { registerDesktop } from "./dashboard-reg-desktop.js";
import { registerStatic } from "./dashboard-reg-static.js";
import { registerCards } from "./dashboard-reg-cards.js";
import { registerKnowledge } from "./dashboard-reg-knowledge.js";
import { registerWorkbench } from "./dashboard-reg-workbench.js";
import { registerTerm } from "./dashboard-reg-term.js";       // Orca 融合 P2：准终端（exec_run 流式版 SSE）
import { registerGithub } from "./dashboard-reg-github.js";   // Orca 融合 P2：GitHub 读侧全功能/写侧降级
import { registerDesign } from "./dashboard-reg-design.js";   // Orca 融合 P3：Design Mode（CDP 元素拾取，零新依赖）
import { registerCliExec } from "./dashboard-reg-cliexec.js"; // 节点画布 P2：CLI 直控执行器（headless 智能体 + SSE 终端）
import { registerCdpExec } from "./dashboard-reg-cdpexec.js"; // 节点画布 P3：CDP 驾驶执行器（桌面智能体拉起 + screencast 直播）
import { registerExecApproval } from "./dashboard-reg-exec-approval.js"; // ★ 方案 B：exec_run 高危命令待批审批
import { registerAllTools } from "./server-tools.js";        // ★ 2026-10-14（1a）：与 MCP server 共用同一份工具注册编排
import { registerOps } from "./dashboard-reg-ops.js";        // ★ 2026-10-14（1a）：核心侧工具面接口（/ops/:tool · /ops/catalog · /health）
const DEFAULT_PORT = 8787;
/** 人工/编辑/新建允许的 type（含规则页 rule） */
const ALLOWED_TYPES = ["decision", "experience", "pitfall", "convention", "rule"];
/* ── 受限模式（终端用户能力收敛）────────────────────────────────
 * 目标：任务由系统计划统一派发、采集地址由系统统一分配，用户不可自行创建/导入/指定。
 * ★ 2026-09-25 缺省对齐壳层：默认关闭（env 未设 → 非受限，与 core-process.js / launcher.cjs 的缺省 "0" 一致），显式 MEMORY_RESTRICTED=1 才打开。
 * 前端据 /api/summary 下发的 restricted 能力位仅隐藏入口；此处为真拦截（防绕过 UI 直调 API）。 */
const RESTRICTED = process.env.MEMORY_RESTRICTED === "1";
const RESTRICTED_MSG = {
    taskCreate: "任务由系统计划统一派发，不支持手动创建",
    planImport: "计划导入已关闭，请使用系统提供的计划",
    customSource: "采集地址由系统统一分配，不支持手动指定",
    cardCreate: "卡片由系统计划统一派发，不支持手动创建",
    cardDispatch: "派发由系统调度，不支持手动触发",
    cardLink: "卡片连线由系统管理，不支持手动建立",
    noteCreate: "笔记创建已关闭，仅系统采集",
    cardToMemory: "卡片转记忆已关闭",
};
function restricted(reply, key) {
    return reply.code(403).send({ ok: false, code: "RESTRICTED", error: RESTRICTED_MSG[key] });
}
/** 新版重设计 UI 目录（含 index.html + echarts.min.js），/ 路由即 serve 此目录。
 *  基于 import.meta.url 两级回退解析，避免硬编码用户路径：
 *    1) dist 上一级 memoryos-dashboard-redesign —— 便携包布局（UI 放包根，与热更新同名合并）
 *    2) dist 上两级 memoryos-dashboard-redesign —— 开发布局（dist 在 memoryos/ 下，UI 在项目根） */
function resolveUiDir() {
    for (const rel of ["../memoryos-dashboard-redesign", "../../memoryos-dashboard-redesign"]) {
        const dir = fileURLToPath(new URL(rel, import.meta.url));
        if (fs.existsSync(path.join(dir, "index.html")))
            return dir;
    }
    return fileURLToPath(new URL("../../memoryos-dashboard-redesign", import.meta.url));
}
const UI_DIR = resolveUiDir();
/* ★ P1-1 / T7：静态资源内存驻留缓存（key = mtimeMs:size，文件变则失效）。
 *   原实现每请求 fs.readFileSync（index.html 172KB + app.js 272KB + echarts 1.0MB）
 *   且 Cache-Control: no-store → 每次刷新全量重传 + 阻塞单线程事件循环。 */
const _staticCache = new Map();
/* ★ P1-2 / T13：limit 统一钳制。原实现散落裸 Number(req.query.limit)，limit=1e9 / abc(NaN)
 *   / ?limit=1&limit=2(数组) 均可直达 SQL LIMIT → 单请求可触发全表扫（本机 DoS）。 */
function clampLimit(raw, def = 100, max = 500) {
    const n = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
    if (!Number.isFinite(n) || n <= 0)
        return def;
    return Math.min(Math.floor(n), max);
}
/** 计划文件目录（plan.schema.json + plan-*.json）。与 UI 同源解析：dist 上一级 plans */
function resolvePlansDir() {
    for (const rel of ["../plans", "../../plans"]) {
        const dir = fileURLToPath(new URL(rel, import.meta.url));
        if (fs.existsSync(path.join(dir, "plan.schema.json")))
            return dir;
    }
    return fileURLToPath(new URL("../plans", import.meta.url));
}
const PLANS_DIR = resolvePlansDir();
/** loopback 主机白名单（比对时去掉端口）：防 DNS rebinding 把外部域名解析到 127.0.0.1 后直连本机 API */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** ★ 2026-10-02 手机版配对：MEMORY_ALLOW_LAN=1 时放行私网 Host（RFC1918 IPv4 / 单标签机器名 / .local）。
 *  仅放行 Host 头，令牌门禁（②）照旧逐请求强制；缺省（无该 env）行为与之前完全一致（fail-closed）。 */
const PRIVATE_HOST_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+(\.local)?)$/i;
function lanHostAllowed(host) {
    return process.env.MEMORY_ALLOW_LAN === "1" && PRIVATE_HOST_RE.test(host);
}
const TOKEN_COOKIE = "memoryos_token";
/** 令牌文件名（与库同目录）：CLI 启动时自动生成/读取 */
export const TOKEN_FILE = "token";
/** 安全响应头（P1-2）：脚本仅同源（页面无内联脚本）；样式放行内联与现有字体域；禁止 object/base 劫持与 iframe 嵌套 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://miaoda.feishu.cn; " +
    "font-src 'self' data: https://miaoda.feishu.cn; img-src 'self' data: blob:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
/**
 * 访问控制（P1-2）三段：
 *  ① Host 白名单 —— Host 去端口后必须属于 loopback（防 DNS rebinding）
 *  ② 令牌校验 —— ?token= / x-memory-token / cookie 三者任一命中即放行；首次带 ?token= 访问自动种 cookie，
 *     前端无需改动即可让后续同源请求带凭据
 *  ③ 安全响应头 —— CSP + nosniff + no-referrer
 */
function installAccessControl(app, token) {
    /** ★ 2026-09-15（P-4171）：常数时间令牌比较。原 `===` 有长度/早期退出侧信道；
     *  先 sha256 摘要再 timingSafeEqual —— 摘要恒定 32B，消除长度侧信道。 */
    const safeEqual = (a, b) => {
        const ha = createHash("sha256").update(String(a ?? "")).digest();
        const hb = createHash("sha256").update(String(b ?? "")).digest();
        return timingSafeEqual(ha, hb);
    };
    app.addHook("onRequest", async (req, reply) => {
        const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
        if (!LOOPBACK_HOSTS.has(host) && !lanHostAllowed(host)) {
            return reply.code(403).send({ ok: false, error: "forbidden-host" });
        }
        // fail-closed（P0-2.2）：无令牌配置时拒绝，而非放行。
        // 原实现 `if (!token) return;` 会在 token 为空时让全部 13 个写路由裸奔——
        // startDashboard 虽有自举生成，但 buildApp 被其他入口调用时无此保证。
        if (!token) {
            return reply
                .code(503)
                .send({ ok: false, error: "token-not-configured", hint: "设置 MEMORY_TOKEN 或确保 data/token 存在后重启" });
        }
        const url = String(req.url ?? "");
        const fromQuery = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "").get("token");
        const cookie = String(req.headers.cookie ?? "");
        const fromCookie = cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith(TOKEN_COOKIE + "="))
            ?.slice(TOKEN_COOKIE.length + 1);
        const bearer = String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, ""); // ★ 一致性⑥：兼容 OpenAI 风格 Bearer（/v1/embeddings 共享端点用，同一令牌）
        const ok = safeEqual(fromQuery, token) || safeEqual(String(req.headers["x-memory-token"] ?? ""), token) || safeEqual(fromCookie, token) || safeEqual(bearer, token);
        if (!ok) {
            return reply.code(401).send({ ok: false, error: "unauthorized", hint: "需带 ?token=<令牌> 访问；令牌见 data/token" });
        }
        if (safeEqual(fromQuery, token)) {
            reply.header("set-cookie", `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly; Max-Age=31536000`);
            // ★ P1-6 / T3 收尾：首次带 ?token= 的「浏览器导航」→ 302 到去掉 token 的同一 URL，
            //   使令牌不再停留在地址栏（可经历史、截图、浏览器扩展泄漏）。
            //   仅对 GET/HEAD 且 Accept 含 text/html 的导航生效：API 调用（curl / 冒烟脚本 /
            //   带 x-memory-token 的调用）行为逐字节不变，不会被重定向。
            const isNav = (req.method === "GET" || req.method === "HEAD") && String(req.headers.accept ?? "").includes("text/html");
            if (isNav) {
                const qs = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
                qs.delete("token");
                const rest = qs.toString();
                const base = url.split("?")[0] || "/";
                return reply.code(302).header("location", rest ? `${base}?${rest}` : base).send();
            }
        }
    });
    app.addHook("onSend", async (_req, reply, payload) => {
        reply.header("Content-Security-Policy", CSP);
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "no-referrer");
        return payload;
    });
}
/* ── 设置面板：config.json（userData）读写 ─────────────────────────────
 * 与 desktop 壳 core-process 共用同一配置文件（AppData/Roaming/MemoryOS/config.json）。
 * 数据目录：优先 MEMORYOS_DATA_DIR，否则由 MEMORY_DB "…/data/memory.db" 反推。 */
function dataDirOf() {
    if (process.env.MEMORYOS_DATA_DIR)
        return process.env.MEMORYOS_DATA_DIR;
    const db = process.env.MEMORY_DB;
    return db ? path.dirname(path.dirname(db)) : "";
}
function configFilePath() {
    return dataDirOf() ? path.join(dataDirOf(), "config.json") : "";
}
/** ★ 2026-10-14（架构重构 1a）：核心实例信息落盘 —— 临时文件 + rename **原子写**（绝不直接覆盖，
 *  读取方永远看不到半截 JSON）。目录走 dataDirOf()（尊重 MEMORYOS_DATA_DIR / MEMORY_DB）。
 *  MCP shim（1b）等进程据此发现核心端口。失败只告警，不阻断监听。 */
function writeCoreJson(o) {
    const dir = dataDirOf();
    if (!dir)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `core.json.tmp-${process.pid}`);
        fs.writeFileSync(tmp, JSON.stringify(o), "utf8");
        fs.renameSync(tmp, path.join(dir, "core.json"));
    }
    catch (e) {
        console.warn(`[dashboard] core.json 落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
}
/* ★ 2026-10-14（架构重构 1a）：核心侧工具面 —— dashboard 与 MCP server 共用同一份注册编排
 *  （server-tools.js::registerAllTools）。FastMCP 实例在此**只当注册容器**（不 listen）。
 *  模块级惰性单例：buildApp 被 smoke 等多次调用时只构建一次。 */
let _opsTools = null;
function opsToolface(db) {
    if (!_opsTools) {
        const container = new FastMCP({ name: "memory-hub", version: "0.2.0" });
        // ★ 口径对齐 server.js:19 / 本文件 CLI:361 —— dbPath 必须是**真实库路径**：
        //   server-tools.js 用 `path.dirname(dbPath)` 推 `_DATA_DIR`，进而决定执行面 artifact 落点。
        //   原写法以 dataDirOf()+"memory.db" 反推，在生产布局（…/MemoryOS/data/memory.db）下会得出
        //   …/MemoryOS/memory.db，_DATA_DIR 随之错一层（直连路径不受影响——那边传的是真实 DB_PATH）。
        const dbPath = process.env.MEMORY_DB ?? (process.env.APPDATA
            ? path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db")
            : fileURLToPath(new URL("../data/memory.db", import.meta.url)));
        _opsTools = registerAllTools(container, {
            db,
            AGENT: process.env.MEMORY_AGENT ?? "unknown",
            AGENT_FPATH: process.env.MEMORY_AGENT_FPATH ?? null,
            ENV_CRED: process.env.MEMORYOS_A1_CREDENTIAL ?? null,
            dbPath,
        });
    }
    return _opsTools;
}
function readDiskConfig() {
    const f = configFilePath();
    if (!f)
        return {};
    try {
        return JSON.parse(fs.readFileSync(f, "utf8"));
    }
    catch {
        return {};
    }
}
function writeDiskConfig(cfg) {
    const f = configFilePath();
    if (!f)
        return;
    fs.mkdirSync(dataDirOf(), { recursive: true });
    // ★ 2026-09-15（P-4171 落地补齐）：明文 llmKey 绝不落盘，改为落 DPAPI 密文 llmKeyEnc
    // （secret-store.js，用户作用域加密，只有同一 Windows 用户能解）。原实现只是把 llmKey 剥掉，
    // 却没有替代存储 → 密钥保存即丢失、云端 LLM 在设置页根本配不起来。
    const { llmKey, ...safe } = cfg;
    fs.writeFileSync(f, JSON.stringify(safe, null, 2), "utf8");
}
/* ── Agent 的 MCP 客户端（模块级单例：一个 dashboard 进程 = 一个 MCP 子进程）──
 * 惰性拉起：首次用到 agent 端点时才 spawn，避免拖慢 dashboard 启动。
 * smoke-dashboard 等会多次调用 buildApp —— 放模块级可避免重复 spawn 与 exit 监听堆积。 */
let _agentMcp = null;
/* ★ 驾驶舱「执行工具开关」：MCP 子进程的 env 覆盖（默认 {} = 继承 shell 注入的 MEMORYOS_EXEC_ON）。
 *  setAgentMcpEnv({MEMORYOS_EXEC_ON:"0"}) 后须 resetAgentMcp() 再 getAgentMcp() 才按新 env 重 spawn。 */
let _agentMcpEnv = {};
async function getAgentMcp() {
    if (!_agentMcp) {
        _agentMcp = await createMcpClient({
            agentName: "dashboard-agent",
            agentFpath: fileURLToPath(new URL("./dashboard.js", import.meta.url)),
            env: _agentMcpEnv,   // 覆盖项（MEMORYOS_EXEC_ON 等）；createMcpClient 内部与 process.env 合并
        });
    }
    return _agentMcp;
}
/* ★ 驾驶舱「日志级别」：内核诊断输出（统一错误处理器的 5xx stderr）按级别门控。
 *  级别 debug<info<warn<error；默认 info（保留 5xx 诊断行）。audit 表（daemon_log/exec_audit）
 *  不受此级别影响（审计纪律 B2：治理留痕永不降级静默）。 */
const _LOG_ORDER = ["debug", "info", "warn", "error"];
let _logLevel = _LOG_ORDER.includes(process.env.MEMORY_LOG_LEVEL) ? process.env.MEMORY_LOG_LEVEL : "info";
export function getLogLevel() { return _logLevel; }
export function setLogLevel(lv) {
    if (_LOG_ORDER.includes(lv)) { _logLevel = lv; return true; }
    return false;
}
export function logLevelShouldDiagnose() { return _LOG_ORDER.indexOf(_logLevel) <= _LOG_ORDER.indexOf("info"); }
// dashboard 退出时收掉 MCP 子进程（stdio 子进程随父进程 stdin EOF 退出，这里是显式兜底）
process.once("exit", () => { try { _agentMcp?.close(); } catch { /* 已断 */ } _agentMcp = null; });
export function buildApp(db, opts = {}) {
    const app = Fastify({ logger: false });
    installAccessControl(app, opts.token ?? process.env.MEMORY_TOKEN ?? null);
    /* ★ Orca 融合 P0（2026-10-03）：JSON content-type 容错 —— 客户端对无体请求（典型：DELETE /api/worktrees/:name）
     *  常仍带 `content-type: application/json`（axios / 部分 SDK / 封装 fetch 的默认行为），fastify 默认解析器在
     *  **路由前**直接 400（FST_ERR_CTP_EMPTY_JSON），路由层收不到请求。替换为：空体 → {}（交各 handler 做业务校验，
     *  报更精确的 400 文案）；非法 JSON → 维持 400（statusCode=400，code=FST_ERR_CTP_INVALID_JSON 同义）。
     *  grep 全仓无测试依赖旧「空体 400」语义（FST_ERR_CTP_EMPTY_JSON 零命中），故为纯增益容错。 */
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        const s = typeof body === "string" ? body.trim() : "";
        if (!s)
            return done(null, {});
        try {
            done(null, JSON.parse(s));
        }
        catch (e) {
            e.statusCode = 400;
            done(e);
        }
    });
    // 本机 Dashboard，仅 loopback，禁用默认错误体（避免泄漏路径）
    app.setNotFoundHandler((_req, reply) => reply.type("text/html; charset=utf-8").code(404).send("Not Found"));
    /* ★ P2-1（T12）：统一错误处理器。
     * 缺口：原实现只有 setNotFoundHandler，**未注册 setErrorHandler** —— Fastify 默认错误体在
     *   非生产模式下带 message，且未捕获异常会以原始堆栈形式回给客户端（内部路径/SQL 细节外泄）。
     * 本处理器：① 一律结构化 JSON {ok:false,error,code}，不回堆栈；② 5xx 才写 stderr（4xx 属客户端问题，不刷日志）；
     *   ③ 保留 Fastify 自带的 statusCode（如 401/403/404 仍按原码返回，避免把鉴权失败改成 500）。
     * 说明：非法 JSON 体由 Fastify 抛 statusCode=400，此处只做脱敏不改码。 */
    app.setErrorHandler((err, req, reply) => {
        const status = Number(err?.statusCode ?? err?.status ?? 500) || 500;
        const code = status >= 500 ? "INTERNAL" : (err?.code ?? "BAD_REQUEST");
        if (status >= 500) {
            // ★ 驾驶舱「日志级别」门控：level=warn/error 时静默 5xx 诊断行（默认 info 保留）
            if (logLevelShouldDiagnose()) {
                const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
                console.error(`[err] ${req?.method ?? "?"} ${req?.url ?? "?"} → ${status}\n${msg}`);
            }
        }
        // 5xx 只回通用文案（不泄漏内部信息）；4xx 回自身 message（Fastify 校验错误对调用方有用）
        const message = status >= 500 ? "内部错误（详见服务端日志）" : String(err?.message ?? "请求无效");
        return reply.code(status).type("application/json; charset=utf-8").send({ ok: false, error: message, code });
    });
    /* ★ 2026-10-14（设置页执行面开关 · 修「重启不生效」）：把 config.json 里持久化的 execOn
     *   在**启动时**回填到 MCP 子进程 env。原实现只写不读 —— exec-toggle 把 execOn 落了盘，
     *   但启动时无人读它，MCP 子进程重启后仍继承壳层注入的 MEMORYOS_EXEC_ON=1
     *   ⇒ 用户关掉执行面，重启后又自己开回来（多人分发场景下等于「以为锁了，其实没锁」）。
     *   仅在显式 boolean 时回填；null（未设置）维持原行为=继承壳层，向后兼容零回归。 */
    {
        const _c = readDiskConfig();
        if (typeof _c.execOn === "boolean")
            _agentMcpEnv = { ..._agentMcpEnv, MEMORYOS_EXEC_ON: _c.execOn ? "1" : "0" };
    }
    /* ★ 灰度开关（P0/P1 · 2026-10-18）：config.json → 本进程 env 回填。
    *   口径（沿用 execOn「重启不生效」事故的教训）：config **显式** boolean 时覆盖 env——
      持久态即真相，防「shell 里残留旧值 silently 覆盖用户设置」；config 未写则该开关走 env/缺省（关）。
    *   必须早于 opsToolface（registerAllTools 在注册期读 MEMORYOS_TASK_SETTLE）；
    *   其余三个调用时解析，本段仅为 core 进程（含 shim 代执行）统一来源。direct MCP 进程在
    *   server.js 有同款回填（config.json 单一开关，两种模式行为一致）。 */
    {
        const _c = readDiskConfig();
        const _flagMap = {
            depValidate: "MEMORYOS_DEP_VALIDATE",
            taskSettle: "MEMORYOS_TASK_SETTLE",
            atomicClaim: "MEMORYOS_ATOMIC_CLAIM",
            doneAutoreview: "MEMORYOS_DONE_AUTOREVIEW",
            gateBreaker: "MEMORYOS_GATE_BREAKER", // ★ B3（P2）：门控连续失败熔断
            prioViaDispatch: "MEMORYOS_PRIO_VIA_DISPATCH", // ★ P15：直派任务 priority 回退 dispatch 链接取数
            reviewGuard: "MEMORYOS_REVIEW_GUARD", // ★ B1（P2）：agent 收口不得覆盖人工 review 卡
        };
        for (const [_k, _env] of Object.entries(_flagMap)) {
            if (typeof _c[_k] === "boolean")
                process.env[_env] = _c[_k] ? "1" : "0";
        }
    }
    // ★ 2026-10-14（1a）：核心侧工具面（与 MCP server 同一份注册编排；模块级惰性单例）
    const _ops = opsToolface(db);
    // T8（P2-3）：路由域拆分 —— 8 个 dashboard-reg-*.js；handler 逐字搬移，注册顺序不变；共享顶层名经 ctx 注入
    const ctx = { db, app, restricted, RESTRICTED, RESTRICTED_MSG, UI_DIR, _staticCache, clampLimit, PLANS_DIR, LOOPBACK_HOSTS, TOKEN_COOKIE, CSP, dataDirOf, configFilePath, readDiskConfig, writeDiskConfig, getAgentMcp, ALLOWED_TYPES, DEFAULT_PORT, opsTools: _ops.tools, opsExecEnabled: _ops.execEnabled, resetAgentMcp: () => { _agentMcp = null; }, setAgentMcpEnv: (env) => { _agentMcpEnv = env || {}; }, getLogLevel: () => _logLevel, setLogLevel, };
    registerCore(app, ctx);
    registerMemory(app, ctx);
    registerPlans(app, ctx);
    registerIngest(app, ctx);
    registerDesktop(app, ctx);
    registerStatic(app, ctx);
    registerCards(app, ctx);
    registerKnowledge(app, ctx);
    registerWorkbench(app, ctx); // Orca 融合 P0+P1：worktree 编排 / diff / 行级批注 / 拖拽上传（2026-10-03 CLAIM §5）
    registerTerm(app, ctx);      // Orca 融合 P2：准终端分屏（SSE 流式执行，exec_run 同安全口径）
    registerGithub(app, ctx);    // Orca 融合 P2：GitHub 集成（读侧全功能 + 写侧 no-remote 降级）
    registerDesign(app, ctx);    // Orca 融合 P3：Design Mode（真实 Chromium 点选元素 → HTML/CSS/裁剪截图进 prompt）
    registerCliExec(app, ctx);   // 节点画布 P2：CLI 直控执行器（channel='cli' 的智能体卡走本机 CLI）
    registerCdpExec(app, ctx);   // 节点画布 P3：CDP 驾驶执行器（channel='cdp' 拉起桌面 App + 直播 + 尽力注入）
    registerExecApproval(app, ctx); // ★ 方案 B：exec_run 高危命令待批审批（看板点同意/拒绝）
    registerOps(app, ctx);          // ★ 2026-10-14（1a）：核心侧工具面接口（走既有全局令牌门禁，零新增暴露面）

    return app;
}
// —— CLI：严格比对入口文件（pathToFileURL 全等），避免被 smoke-dashboard 等 import 时误触发真实监听 ——
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dbPath = process.env.MEMORY_DB ?? (process.env.APPDATA
    ? path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db") // ★ 口径收口（2026-10-02 用户拍板）：缺省只用 %APPDATA% 生产库，不再落仓内 dev 库（原 ../data/memory.db 会让无 env 的裸拉复活双库分裂）
    : fileURLToPath(new URL("../data/memory.db", import.meta.url))); // APPDATA 缺失（非 Windows）兜底原路径
    const db = openDb(dbPath);
    // 访问令牌：env MEMORY_TOKEN 优先；否则读 data/token，仍无则生成并落盘（首启自举，保证 CLI 启动同样受控）
    const tokenFile = path.join(path.dirname(dbPath), TOKEN_FILE);
    let token = process.env.MEMORY_TOKEN ?? "";
    if (!token) {
        try {
            token = fs.readFileSync(tokenFile, "utf8").trim();
        }
        catch { /* 文件不存在 → 下面生成 */ }
    }
    if (!token) {
        token = randomBytes(24).toString("hex");
        try {
            fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
            fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
        }
        catch (e) {
            console.warn(`[dashboard] 令牌落盘失败（鉴权仍生效）：${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const app = buildApp(db, { token });
    // ★ 2026-10-02 手机版配对：缺省仍只绑 127.0.0.1（行为不变）；MEMORY_HOST=0.0.0.0 时才对局域网监听
    //   （须搭配 MEMORY_ALLOW_LAN=1 放行私网 Host；令牌门禁两种情况下都强制）。
    const host = process.env.MEMORY_HOST ?? "127.0.0.1";
    const port = Number(process.env.MEMORY_PORT ?? DEFAULT_PORT);
    app
        .listen({ host, port })
        .then(() => {
        console.log(`MemoryOS Dashboard: http://${host}:${port}/  （访问令牌不在 URL/日志中打印；令牌见 ${tokenFile}）`);
        // ★ 2026-10-14（1a）：监听成功 → 原子写 data/core.json（{port,pid,startedAt}），供 MCP shim 等进程发现核心端口
        writeCoreJson({ port, pid: process.pid, startedAt: new Date().toISOString() });
        // ★ 批次⑧：规则反思生产线 —— 启动即水位初始化（LLM-free），此后每小时窗口检查；
        //   常驻 daemon 进程另有同款钩子，config 当日认领门禁保证只跑一次；失败仅记日志。
        maybeRunRuleReflection(db).catch((e) => console.error(`[reflect] 启动检查失败: ${e instanceof Error ? e.message : String(e)}`));
        setInterval(() => maybeRunRuleReflection(db).catch((e) => console.error(`[reflect] 运行失败: ${e instanceof Error ? e.message : String(e)}`)), 60 * 60 * 1000);
        // ★ 2026-10-15（第三批）：scanAgents 探测 worker 预热发车 —— spawnSync 从主线程挪走，
        //   首屏 /api/cards/graph、/api/scan-agents 等到达时命中共享缓存（或在途合并），不再阻塞 load。
        primeScanAgentsInWorker();
    });
}
