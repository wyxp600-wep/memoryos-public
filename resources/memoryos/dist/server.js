import { startClientReporting } from './connection-runtime.js';
/**
 * MemoryOS v0.2 — MCP Server（fastmcp v3 / FastMCP）
 * Tools: memory_write（embed + 去重/冲突预检） / memory_search（混合检索 RRF）
 * ★ P2-④（2026-09-22）：常驻工具按域拆分到 server-reg-memory.js / -obsidian.js / -task.js（数量以 `--list-tools` 为准，勿手抄）。
 * ★ 2026-10-14（架构重构 1a）：注册编排（addTool 覆写 + 共享层 ctx + 三域/guide/执行面注册）抽到
 *   server-tools.js::registerAllTools —— 核心（dashboard）与 MCP server 共用同一份工具面。
 *   本文件保留：内核（FastMCP 实例 + DB/身份/embed 引导）、--list-tools 与 stdio CLI 入口。
 *   注册顺序不变：memory → obsidian → task；`node dist/server.js --list-tools` 逐字节可证（数量勿手抄）。
 * ★ 2026-10-14（架构重构 1b）：模式分支 —— `direct`（默认，本文件内建内核：openDb + 嵌入模型 + 直执行）
 *   / `shim`（薄转发：工具面注册照旧，但执行改走核心的 HTTP /ops，**本进程不打开 DB、不加载模型**，
 *   见 server-shim.js）。模式来源：`data/config.json` 的 `mcpMode`（缺省 direct）；
 *   环境变量 `MEMORYOS_MCP_MODE` 仅作**测试覆盖**，优先级高于文件。
 *   两条硬口径：① 工具面（名称/schema/描述/风险前缀/注册顺序）两种模式**逐字节不变**（同一份 registerAllTools）；
 *   ② direct 分支保持原路径（openDb / 身份引导 / embed 缺省 local / 连接心跳），shim 分支一律不碰。
 * 启动：stdio（默认 transport），node dist/server.js
 */
import { FastMCP } from "fastmcp";
import { openDb, appendEvent } from "./db.js";
import { embedMode } from "./embed.js";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { registerAllTools } from "./server-tools.js";
import { createShimToolface } from "./server-shim.js"; // ★ 1b：shim 模式（薄转发；零 DB / 零模型）
// —— 运行时身份读取（R3 分工：读写自动带 agent/agent_fpath）——
const DB_PATH = process.env.MEMORY_DB ?? (process.env.APPDATA
  ? path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db") // ★ 口径收口（2026-10-02 用户拍板）：缺省只用 %APPDATA% 生产库，不再落仓内 dev 库（防止无 MEMORY_DB 的接入面悄悄写错库）
  : fileURLToPath(new URL("../data/memory.db", import.meta.url))); // APPDATA 缺失（非 Windows）兜底原路径
const AGENT = process.env.MEMORY_AGENT ?? "unknown";
const AGENT_FPATH = process.env.MEMORY_AGENT_FPATH ?? null;
const ENV_CRED = process.env.MEMORYOS_A1_CREDENTIAL ?? null; // ★ 一致性⑧：MCP 配置注入的本 agent 凭据（调用方省略 credential 入参时回退；归属仍按 who 严格校验，拿他人凭据照样拒绝）
function auditAgentIdentity() {
    if (!AGENT_FPATH) {
        console.error(`[warn] MEMORY_AGENT_FPATH 未设置，身份无法佐证（agent=${AGENT}）`);
        return;
    }
    if (!fs.existsSync(path.resolve(AGENT_FPATH))) {
        console.error(`[warn] 配置路径指纹不存在: ${path.resolve(AGENT_FPATH)}（agent=${AGENT}）`);
    }
}

/* ── ★ 1b：模式开关（direct / shim）───────────────────────────────
 *  口径：config.json(mcpMode) 为准；MEMORYOS_MCP_MODE 只作**测试覆盖**（优先级高于文件）。
 *  容忍半写：解析失败（正在被写 / 被截断）→ 按 direct 处理 + 一条 warn，**绝不崩**
 *  （崩掉的代价是 MCP 客户端整条工具面不可用，远大于"读不到一个配置项"）。
 *  config.json 目录口径与 dashboard.js::dataDirOf 一致（尊重 MEMORYOS_DATA_DIR / MEMORY_DB）。 */
const VALID_MCP_MODES = new Set(["direct", "shim"]);
function dataDirOf() {
    if (process.env.MEMORYOS_DATA_DIR)
        return process.env.MEMORYOS_DATA_DIR;
    const db = process.env.MEMORY_DB;
    return db ? path.dirname(path.dirname(db)) : "";
}
function readMcpMode() {
    const envMode = String(process.env.MEMORYOS_MCP_MODE ?? "").trim().toLowerCase();
    if (envMode) {
        if (VALID_MCP_MODES.has(envMode))
            return envMode;
        console.error(`[warn] MEMORYOS_MCP_MODE=${envMode} 不是合法模式（direct/shim）——按 direct 处理`);
        return "direct";
    }
    const dir = dataDirOf();
    const file = dir ? path.join(dir, "config.json") : "";
    if (!file || !fs.existsSync(file))
        return "direct";
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (e) {
        console.error(`[warn] data/config.json 解析失败（疑似半写/截断，按 direct 处理）: ${e instanceof Error ? e.message : String(e)}`);
        return "direct";
    }
    const mode = String(cfg?.mcpMode ?? "").trim().toLowerCase();
    if (!mode)
        return "direct";
    if (!VALID_MCP_MODES.has(mode)) {
        console.error(`[warn] data/config.json 的 mcpMode=${mode} 不是合法模式（direct/shim）——按 direct 处理`);
        return "direct";
    }
    return mode;
}
const MCP_MODE = readMcpMode();
/* ★ 灰度开关（P0/P1 · 2026-10-18）：config.json → 本进程 env 回填（direct 模式本进程执行 task_* 工具，
*   与 dashboard.js 核心侧同款同口径——config 显式 boolean 覆盖 env，未写走 env/缺省关）。
*   保证 shim/direct 两种模式下四个开关行为一致（config.json 单一开关）。 */
{
    const _dir = dataDirOf();
    const _file = _dir ? path.join(_dir, "config.json") : "";
    if (_file && fs.existsSync(_file)) {
        try {
            const _c = JSON.parse(fs.readFileSync(_file, "utf8"));
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
        catch { /* 半写/截断按无配置处理，开关走 env/缺省 */ }
    }
}

const server = new FastMCP({
    name: "memory-hub",
    version: "0.2.0",
    instructions: "共享记忆中心（语义检索）。【硬性·每条消息第一步】收到用户任何消息后，第一件事必须先调用 memory_context（可带 focus=当前任务主题）注入当前项目高价值记忆，之后才能回复或调用其他工具；随后按需 memory_search 精确检索，命中相关记忆须 memory_cite 标注来源，确无相关也须声明'已检索无相关'。若本机未安装或未连接 MemoryOS MCP，须先明确提示用户安装接入，不得跳过此步。提交修复结论/技术决策/隐藏约定/第三方坑时调用 memory_write；scope 不确定先 memory_context（自带 project 清单）。禁写：绝不写入敏感凭据。",
});

/* ── 工具注册编排（P2-④ 域拆分 + ★ 2026-10-14 架构重构 1a/1b）：全部经 server-tools.js::registerAllTools ——
 *   addTool 覆写层（注册清单记录 + riskPrefix 风险前缀 + try/catch 结构化兜底）、共享层 ctx
 *   （stateReceipt / TxAbort / runTaskTx / isCredentialValid / nowIso / plusHoursIso）、
 *   三域注册（memory → obsidian → task）+ tool_guide + 执行面（MEMORYOS_EXEC_ON=1 时才注册）。
 *   调用顺序 = 注册顺序，等价于原文件声明顺序；勿调整。
 *   ★ 1a/1b 硬约束：工具名 / schema / 描述 / 响应文案 / 注册顺序**两种模式逐字不变** —— 由
 *     `node dist/server.js --list-tools` 前后逐字节比对兜底（冒烟 smoke-agent 用它派生期望工具面）。 */
let REGISTERED_TOOLS = [];
/** ★ 1b：direct 分支才有 db（shim 分支把 db 留 null —— 不 openDb / 不读写 memory.db）。 */
let db = null;
if (MCP_MODE === "shim") {
    // shim：工具面照旧注册，执行改走核心 HTTP /ops；不 openDb、不设 EMBED_MODE、不写连接心跳
    const { tools } = createShimToolface(server, { AGENT, AGENT_FPATH, ENV_CRED, dbPath: DB_PATH });
    REGISTERED_TOOLS = [...tools.keys()];
    console.error(`[mcp] 模式=shim：工具面薄转发到核心（无 DB / 无嵌入模型）；端口取 MEMORY_PORT 或 data/core.json（须 pid 存活）`);
}
else {
    db = openDb(DB_PATH);
    auditAgentIdentity();
    // ★ 2026-09-25 P0③：IDE 里以 stdio 起的 MCP 常不注入 EMBED_MODE —— 若沿用模块默认 fake，
    //   语义检索会静默退化成纯词法召回（库内向量是 bge-m3 真向量，query 造假向量必然对不上）。
    //   故此处补缺省 local（口径对齐 agent-core.js 的 `process.env.EMBED_MODE || "local"`）；
    //   embed.js 已改惰性解析，此刻设置即生效。显式设 api/fake 仍可覆盖。
    const _embedDefaulted = !process.env.EMBED_MODE;
    if (_embedDefaulted)
        process.env.EMBED_MODE = "local";
    // P0① 启动自检：embed 模式兜底告警（存储向量已是 bge-m3 真实嵌入；检索若跑 fake 模式则 query 向量与库不匹配，召回必失效）
    const _embedMode = embedMode();
    console.error(`[embed] EMBED_MODE=${_embedMode}${_embedMode === "fake" ? "  ⚠ 无语义检索：生产使用需在客户端 MCP 配置注入 EMBED_MODE=local（见 deploy-mcp.mjs 或 dashboard 工具连接页配置示例）" : _embedDefaulted ? "（未注入 EMBED_MODE，已按缺省 local 启动；若本机无模型缓存，首次调用会加载/下载模型（约数百 MB）——可显式设 EMBED_MODE=api 或 fake 覆盖）" : ""}`);
    const { tools } = registerAllTools(server, { db, AGENT, AGENT_FPATH, ENV_CRED, dbPath: DB_PATH });
    REGISTERED_TOOLS = [...tools.keys()];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// ★ 2026-09-19 --list-tools：单一事实源查询口——打印实际注册清单后退出。
//   不启动 stdio transport、不写 connect 心跳（这不是一次客户端连接）；
//   ★ 1b 结论：**两种模式都可用** —— direct 下模块加载期的 DB 打开/迁移与正常启动一致（幂等，无额外写），
//   shim 下压根不打开 DB（更轻）。两条路径打印的都是同一份 Map 键序列（逐字节一致）。
//   stdout 走管道时 process.exit 可能截断缓冲，故用写回调解 exit；输出加 ##TOOLS## 前缀防未来 stdout 污染。
if (process.argv.includes("--list-tools")) {
    process.stdout.write("##TOOLS##" + JSON.stringify(REGISTERED_TOOLS) + "\n", () => process.exit(0));
} else if (isMain) {
    // 连接心跳：每次 server 被某个客户端 stdio 拉起时留痕（op=connect）。MEMORY_AGENT 由 MCP 配置 env 注入 → 可精确到"哪个 agent 连上了"
    // ★ 1b：shim 分支无 db（不写心跳）—— 心跳是「本进程直连库」的语义，shim 的连接事实由核心侧记录。
    if (db && process.env.MEMORYOS_CONNECTION_PROBE !== '1') {
        try {
            appendEvent(db, {
                memory_id: null,
                op: "connect",
                payload: JSON.stringify({ agent: AGENT, agent_fpath: AGENT_FPATH, ts: new Date().toISOString() }),
                operator: `agent:${AGENT}`,
            });
        }
        catch {
            /* 心跳失败不阻断启动 */
        }
    }
    startClientReporting(server,{db,agent:AGENT,agentFpath:AGENT_FPATH,dbPath:DB_PATH,mode:MCP_MODE});
    await server.start({ transportType: "stdio" });
}
