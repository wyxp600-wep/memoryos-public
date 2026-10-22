/**
 * MemoryOS — MCP stdio 薄 shim（★ 2026-10-14 架构重构 1b）
 *
 * 定位：**薄 shim（thin forwarder）** —— 只做一件事：把 stdio MCP 的 `tools/call` 转发到核心
 *   （dashboard 的 `POST /ops/:tool`，见 dashboard-reg-ops.js），拿回**裸值**后交还 fastmcp 协议层包装。
 *   入口仍是 `node dist/server.js`（模式分支在 server.js：`mcpMode==='shim'` 时 import 本文件）。
 *
 * 三条硬边界（本文件存在的全部意义：让 MCP 客户端进程不再持有第二份重量级状态）：
 *   ① 零 DB —— 绝不 openDb / 绝不读写 memory.db（ctx.db 全程为 null，db 只存在于核心进程）；
 *   ② 零模型 —— 绝不调用 getEmbedder（embed.js 的 transformers 本是**动态 import**：不调用即不加载模型）；
 *   ③ 零业务状态 —— 不缓存记忆/任务/审计任何业务数据；只缓存「连接参数」（端口 / 令牌），见下方缓存说明。
 *
 * 口径对齐（★ 逐字节一致的关键）：本 shim 的 def.execute 把核心回的 **result 裸值**原样返回，
 *   由 fastmcp 协议层按它自己的规则包装（字符串 → `{content:[{type:"text",text}]}`；对象含 `type` → 单条；
 *   其余 → `ContentResultZodSchema.parse`，见 fastmcp dist/chunk-UVX47AE5.js:1141-1155）。
 *   核心侧 `/ops` 因此改为「裸值 + 信封（{ok,result}）」；两侧合起来，客户端可见输出与 direct 模式逐字节一致。
 *
 * ── 端口发现（缓存，避免每次调用都重读）─────────────────────────────
 *   顺序：`MEMORY_PORT` → `<dataDir>/core.json`（**必须校验 pid 未陈旧**：进程已消失 ⇒ 视为陈旧，继续往下）
 *   → 都拿不到就**报错**（不猜端口：猜错会静默打到别的服务上）。dataDir 口径与 dashboard.js::dataDirOf 一致。
 *   —— 一旦成功解析即缓存；仅在「连接被拒」重试时失效重解析（核心可能正在重启并换了端口）。
 *
 * ── 令牌（绝不写日志/文件）────────────────────────────────────────
 *   顺序：`MEMORY_TOKEN` → `data/token`（先 `<MEMORY_DB 同目录>/token`，再 `<dataDir>/token`）。
 *   一律只放在 HTTP 头 `x-memory-token` 里；**绝不打印、绝不落盘**。遇 401 重读一次令牌文件再试一次（应对轮换）。
 *
 * ── 身份头（可缺省）──────────────────────────────────────────────
 *   `x-memory-agent` ← MEMORY_AGENT、`x-memory-agent-fpath` ← MEMORY_AGENT_FPATH、
 *   `x-memory-a1-cred` ← MEMORYOS_A1_CREDENTIAL；三者只作身份标识，不参与鉴权（鉴权仍由核心的全局令牌门禁负责）。
 *   `x-memory-cwd` ← process.cwd()：核心侧 /ops/:tool **现已消费**（缺口 B）—— 执行面在调用方
 *   未显式给 cwd/路径基准时，用该值（clientCwd）替代 `process.cwd()` 解析相对路径/cwd。
 *   口径差异：direct = 服务进程工作区（workspaceRoot 由进程 env 派生）；shim = 调用方 cwd 透传
 *   （**保持与 direct 语义等价**，非新语义）。与卡片 worktree 的 resolveRunCwd 对齐留待后续批次，本批不发明第二套。
 *
 * ── 取消与超时 ──────────────────────────────────────────────────
 *   · 每个 HTTP 请求带 AbortController：按工具设超时（长耗时工具宽松值，见 TOOL_TIMEOUT_MS 表）；
 *   · ★ 2026-10-14（本批）：**按 JSON-RPC id 精准取消** —— 见下方「stdin 只读透听」长注释：shim 自持一个
 *     只读旁路监听器，逐行解析客户端消息，为每条 `tools/call` 建 Controller 并按「工具名 + 参数稳定哈希」
 *     入待认领表；收到 `notifications/cancelled`（`params.requestId` = 该请求的 JSON-RPC id）即**精确 abort**
 *     对应 Controller（→ 转发中断 → 核心随之中断/杀掉对应子进程树），**不依赖** `_meta.requestId`。
 *   · 传输关闭（stdin end/close）时 abort 全部在途请求 —— 既有能力保留。
 *
 *   ★ 为什么不直接用 SDK 给的 `extra.signal`（这是本方案存在的理由，勿删）：
 *     SDK 的 `Protocol._onrequest`（protocol.js:314-319）本就为每个请求建 AbortController、按 `request.id`
 *     注册，且 `_oncancel`（protocol.js:169-176）会 abort 它、把 `extra.signal` 交给 handler —— 精确 id 关联
 *     这一层 SDK **已经具备**。但 **fastmcp 3.35 把它丢了**：其 `CallToolRequestSchema` handler 签名只取
 *     `(request)`（chunk-UVX47AE5.js:1002-1026），不接第二个 `extra` 参数，`extra.signal` 根本到不了工具执行层
 *     （其 Context 的 `requestId` 取自 `request.params._meta.requestId`，**不是** JSON-RPC id）。
 *     另：SDK 对**已取消**请求会「丢弃响应」（protocol.js:368-372 `if (abortController.signal.aborted) return`）——
 *     故取消后客户端通常**收不到**该次 tools/call 的响应行（见 smoke-shim ⑩ 的如实记录），属 SDK 语义而非本 shim 缺陷。
 *
 *   ★ 为什么不换传输层（不改成直连 SDK Server）：
 *     shim 复用 fastmcp 的注册编排（registerAllTools）就为「工具面/描述/schema/响应包装口径与 direct 逐字节一致」
 *     （冒烟 ④ 逐字节比对即此项证据）。换成裸 SDK Server 会改掉 fastmcp 的响应包装（ContentResult 归一化等），
 *     逐字节一致立刻失守，风险远大于本批要补的「按 id 取消」。故只在旁路加一层**只读**监听，绝不碰读取路径。
 *
 * ── 失败语义 ────────────────────────────────────────────────────
 *   对「连接级失败」重试：ECONNREFUSED / ECONNRESET / EPIPE / EPROTO 等（见 isConnFailure ——
 *   核心刚被杀时复用连接先报 ECONNRESET，只认 ECONNREFUSED 会把裸 fetch failed 抛给客户端）；
 *   ≤3 次、指数退避、总计 ≤8s；最终失败回**结构化 isError**，
 *   文案含「核心未运行或正在重启；不要重复调用」的可行动提示。**不做自动回退直连**（回退会让客户端
 *   以为一切正常，反而掩盖「核心没起来」这一运维事实）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { registerAllTools } from "./server-tools.js";

const TOKEN_FILE = "token";
const CORE_FILE = "core.json";
/** 默认（较短）：多数工具有明确的小时延上限；命中下表的长耗时工具另给宽松值。 */
const DEFAULT_TIMEOUT_MS = 60_000;
/* 按工具设超时的依据（每个值都必须「≥ 该工具在内核里可能的最长耗时」）：
 *   · exec_run   620s —— schema 允许 timeout_ms 上限 600000ms，HTTP 必须比它更长，否则「命令还在跑、shim 已超时」；
 *   · task_done  900s —— 可能跑 [gate] 验收子进程（execFile 上限 180s）+ 高风险命令人审挂起（最长 600s，见 exec-approval.js）；
 *   · task_admin 300s / obsidian 300s / memory_ask 300s —— 库写、vault 扫描、上游 LLM 往返都可能数十秒级；
 *   · memory_write / memory_search / memory_context 180s —— 首次可能触发核心侧嵌入模型加载 / 大 project 检索；
 *   · file_read/file_write 60~120s —— 单文件 IO；
 *   · 其余（task_next/task_claim/…）60s 默认值。 */
const TOOL_TIMEOUT_MS = new Map([
    ["exec_run", 620_000],
    ["task_done", 900_000],
    ["task_admin", 300_000],   // ★ 2026-10-19 整合：原 task_verify 300s（admin 门内 block/reopen 快操作被上界覆盖，无碍）
    ["obsidian", 300_000],     // ★ 2026-10-19 整合：原 obsidian_import/export 300s
    ["memory_ask", 300_000],
    ["memory_write", 180_000],
    ["memory_search", 180_000],
    ["memory_context", 180_000],
    ["file_read", 60_000],
    ["file_write", 120_000],
]);
function timeoutOf(name) {
    return TOOL_TIMEOUT_MS.get(name) ?? DEFAULT_TIMEOUT_MS;
}
/** 仅写类幂等工具自动补 request_id —— 依据：server-reg-task.js 的 IDEMPOTENT_TASK_TOOLS
 *  （这批工具的参数表经 `.extend({request_id})` **确实声明**了 request_id，内核 request_receipts 才是有效底座）。
 *  其余写类工具（memory_write / obsidian_* / file_write）的 schema **未声明** request_id，
 *  而 zod 的 object 默认剥离未知键 ⇒ 注入会被静默丢弃（无效果）——故不注入，避免制造"看起来幂等其实不是"的假象。
 *  漂移纪律：若 server-reg-task.js 的 IDEMPOTENT_TASK_TOOLS 增删成员，此集合须同步。 */
const IDEMPOTENT_WRITE_TOOLS = new Set([
    "task_assign", "task_delegate", "task_claim", "task_heartbeat", "task_release",
    "task_admin", "task_done", "task_supersede",
]);
const REFUSED_MAX_ATTEMPTS = 3;
const REFUSED_MAX_TOTAL_MS = 8_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── dataDir（与 dashboard.js::dataDirOf 同口径；core.json / token 都在这里）── */
function dataDirOf() {
    if (process.env.MEMORYOS_DATA_DIR)
        return process.env.MEMORYOS_DATA_DIR;
    const db = process.env.MEMORY_DB;
    return db ? path.dirname(path.dirname(db)) : "";
}
/** 与 server.js 的 DB_PATH 同口径：只用来定位 `data/token`，**绝不打开库**。 */
function kernelDbPath() {
    if (process.env.MEMORY_DB)
        return process.env.MEMORY_DB;
    if (process.env.APPDATA)
        return path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db");
    return fileURLToPath(new URL("../data/memory.db", import.meta.url));
}

/* ── 端口发现（缓存）────────────────────────────────────────── */
let _port = 0;
/** pid 存活探测：signal 0 不发信号只做权限/存在性检查。EPERM = 存在但无权限探测 ⇒ 视为存活。 */
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e?.code === "EPERM";
    }
}
/** 读 core.json（含 pid 陈旧校验）。拿不到有效端口 → 0。 */
function readCoreJsonPort() {
    const dir = dataDirOf();
    if (!dir)
        return 0;
    let o;
    try {
        o = JSON.parse(fs.readFileSync(path.join(dir, CORE_FILE), "utf8"));
    }
    catch {
        return 0; // 不存在 / 半写（核心原子 rename 落盘，故半写只会发生在手改场景）→ 视为不可用
    }
    const port = Number(o?.port);
    const pid = Number(o?.pid);
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
        return 0;
    if (!Number.isInteger(pid) || pid <= 0)
        return 0;
    if (!isPidAlive(pid))
        return 0; // ★ 陈旧：上一代核心留下的 core.json（pid 已消失）⇒ 不采信，绝不猜端口
    return port;
}
/** 解析端口（缓存）。force=true 时失效重解析（连接被拒后判定核心可能已重启并换端口）。 */
function resolvePort(force = false) {
    if (_port && !force)
        return _port;
    const envPort = Number(process.env.MEMORY_PORT ?? 0);
    _port = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : readCoreJsonPort();
    return _port;
}

/* ── 令牌（只进 HTTP 头；绝不打印/落盘）────────────────────── */
let _token = "";
function tokenCandidates() {
    const out = [path.join(path.dirname(kernelDbPath()), TOKEN_FILE)];
    const dd = dataDirOf();
    if (dd)
        out.push(path.join(dd, TOKEN_FILE));
    return [...new Set(out)];
}
function loadToken(force = false) {
    if (process.env.MEMORY_TOKEN)
        return process.env.MEMORY_TOKEN; // env 优先（与 dashboard.js 读盘口径一致）
    if (_token && !force)
        return _token;
    for (const f of tokenCandidates()) {
        try {
            const t = fs.readFileSync(f, "utf8").trim();
            if (t) {
                _token = t;
                return t;
            }
        }
        catch { /* 不存在 → 试下一个候选 */ }
    }
    return _token;
}

/* ── 在途请求映射（取消用）────────────────────────────────────
 *  · byRequestId：`extra.requestId`(= _meta.requestId) → AbortController；
 *  · all：全部在途控制器（传输关闭时逐一 abort）。 */
const _inflightByRequestId = new Map();
const _inflightAll = new Set();
function abortAllInflight() {
    for (const ac of _inflightAll) {
        try {
            ac.abort();
        }
        catch { /* 已结束 */ }
    }
}
let _transportHookBound = false;
/** stdio 关闭即中止全部在途请求（下游核心据 HTTP 连接关闭 → 取消 → 杀子进程树）。只绑一次。 */
function bindTransportClose() {
    if (_transportHookBound)
        return;
    _transportHookBound = true;
    const onClose = () => abortAllInflight();
    for (const ev of ["end", "close"]) {
        try {
            process.stdin.once(ev, onClose);
        }
        catch { /* 非 stdio 启动（无 stdin）→ 忽略 */ }
    }
}

/* ── ★ 本批：按 JSON-RPC id 精准取消（stdin 只读透听 / tap）────────────
 * 机制合法性：fastmcp 用普通 `_stdin.on('data')` 读 stdin（SDK stdio.js:37），其 close() 还按
 *   `listenerCount('data')` 判断是否独占才 pause（stdio.js:56-64）⇒ 再加一个「只读」监听器是**兼容**的：
 *   只观察，不 consume / 不 pause / 不 unshift，绝不改动 fastmcp 的读取路径（数据同时投递给两个监听器）。
 * 关联口径：tap 自行按行累积缓冲（客户端消息按行，与 SDK ReadBuffer 同前提），逐行 `JSON.parse`（失败即跳过，绝不抛）。
 *   · `tools/call` 请求 → 记其 JSON-RPC `id`、建 AbortController，按「工具名 + 参数稳定哈希」入「待认领」FIFO 队列；
 *   · `notifications/cancelled` → `params.requestId` 命中已知 id：**尚未认领**（execute 还没开始）则标
 *     pre-cancelled 并立刻 abort；**已被认领**（execute 已在跑）则直接 abort 其 Controller。
 * 认领：`executeOverride` 用**同款哈希** FIFO 取最旧一条，作为本次 HTTP 转发的 signal；取不到就新建 Controller
 *   （保持既有语义，绝不因取不到而报错）。
 * 边界（防泄漏）：待认领表**有界** —— 未被认领的条目按 60s TTL + 64 条上限淘汰；认领/结束即从各表移除
 *   （认领后 `_pendingById` 映射**保留**到请求结束，供「在途取消」命中）。stdin end/close 保持既有「abort 全部在途」。
 * 哈希口径：`name + '#' + fnv1a(stableStringify(args))`。**已知局限（如实声明）**：fastmcp 的入参会先经 zod
 *   `parameters['~standard'].validate`（chunk-UVX47AE5.js:1012-1025），若某工具 schema 带 `.default()`/transform，
 *   则 parsed args 与 raw args 不同 ⇒ 认领时哈希对不上 → 回落「新建 Controller」（该次取消不命中）。fastmcp 的
 *   zod 对象默认只剥未知键、`.optional()` 不注入默认值，故**执行面工具（exec_run/file_read/file_write）raw == parsed**，
 *   取消可精确命中（正是最需要取消的长耗时面）。 */
const PENDING_TTL_MS = 60_000;
const PENDING_MAX = 64;
const _pendingAll = new Set();        // 未被认领的 entry（插入序）→ TTL/上限淘汰依据
const _pendingByKey = new Map();      // key(name#hash) → [entry...]（FIFO，最旧在头部）
const _pendingById = new Map();       // String(jsonrpc id) → entry

/** 稳定序列化：对象键排序，保证同内容不同键序得到同一字符串。 */
function stableStringify(v) {
    if (v === null || typeof v !== "object") {
        const s = JSON.stringify(v);
        return s === undefined ? "null" : s;
    }
    if (Array.isArray(v))
        return "[" + v.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
/** FNV-1a 32 位（短、零依赖；仅用于把参数折成稳定键，非密码学用途）。 */
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
function requestKey(name, args) {
    return `${name}#${fnv1a(stableStringify(args ?? {}))}`;
}
/** 淘汰一条**未被认领**的条目（TTL 到期 / 超上限）→ 从各表移除，连同 _inflightAll 清理。 */
function pendingDrop(entry) {
    if (entry.dropped || entry.settled)
        return;
    entry.dropped = true;
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    const q = _pendingByKey.get(entry.key);
    if (q) {
        const i = q.indexOf(entry);
        if (i >= 0)
            q.splice(i, 1);
        if (q.length === 0)
            _pendingByKey.delete(entry.key);
    }
    if (_pendingById.get(String(entry.id)) === entry)
        _pendingById.delete(String(entry.id));
    _pendingAll.delete(entry);
    _inflightAll.delete(entry.ac);
}
/** 认领（FIFO 最旧一条）：从待认领池取出；`_pendingById` 映射**保留**（供后续取消命中在途），结束才清。 */
function claimPending(name, args) {
    const q = _pendingByKey.get(requestKey(name, args));
    if (!q || q.length === 0)
        return null;
    const entry = q.shift();
    if (q.length === 0)
        _pendingByKey.delete(entry.key);
    _pendingAll.delete(entry);
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    entry.claimed = true;
    return entry;
}
/** 请求结束（无论成功/失败/中止）→ 移除 entry 与 id 映射，防泄漏。 */
function settlePending(entry) {
    if (!entry || entry.settled)
        return;
    entry.settled = true;
    if (_pendingById.get(String(entry.id)) === entry)
        _pendingById.delete(String(entry.id));
    _inflightAll.delete(entry.ac);
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
}
/** 单条客户端消息的透听处理（只读，绝不产生副作用到读取路径）。 */
function handleTapMessage(msg) {
    if (!msg || typeof msg !== "object")
        return;
    if (msg.method === "tools/call" && msg.id !== undefined && msg.id !== null) {
        const name = msg.params?.name;
        if (typeof name !== "string")
            return;
        const ac = new AbortController();
        const entry = { id: msg.id, name, key: requestKey(name, msg.params?.arguments ?? {}), ac, timer: null, claimed: false, cancelled: false, dropped: false, settled: false };
        entry.timer = setTimeout(() => pendingDrop(entry), PENDING_TTL_MS);
        if (typeof entry.timer.unref === "function")
            entry.timer.unref();                                  // 不因淘汰定时器拖住进程退出
        _pendingAll.add(entry);
        let q = _pendingByKey.get(entry.key);
        if (!q) {
            q = [];
            _pendingByKey.set(entry.key, q);
        }
        q.push(entry);
        _pendingById.set(String(entry.id), entry);
        _inflightAll.add(ac);                                     // 未认领也登记：传输关闭时同样被 abort（既有能力保留）
        while (_pendingAll.size > PENDING_MAX) {                   // 超上限 → 淘汰最旧未被认领条目
            const oldest = _pendingAll.values().next().value;
            if (!oldest || oldest === entry)
                break;
            pendingDrop(oldest);
        }
        return;
    }
    if (msg.method === "notifications/cancelled") {
        const rid = msg.params?.requestId;
        if (rid === undefined || rid === null)
            return;
        const entry = _pendingById.get(String(rid));              // 兼容 id 为 number 或 string
        if (!entry)
            return;
        entry.cancelled = true;
        try {
            entry.ac.abort();
        }
        catch { /* 已结束 */ }
    }
}
let _stdinTapBound = false;
/** 注册 stdin 只读透听器（**必须早于 fastmcp 开始消费**：本函数在 createShimToolface 内、server.start 之前调用）。 */
function bindStdinTap() {
    if (_stdinTapBound)
        return;
    _stdinTapBound = true;
    let buf = "";
    const onTap = (chunk) => {
        try {
            buf += chunk.toString("utf8");
            if (buf.length > 4_000_000)                            // 防无换行的超大消息撑爆（正常消息按行）
                buf = buf.slice(-1_000_000);
            let i;
            while ((i = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line)
                    continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch { continue; }                                // 非法行 → 跳过，绝不抛
                try {
                    handleTapMessage(msg);
                }
                catch { /* 旁路异常绝不影响主链路 */ }
            }
        }
        catch { /* 同上：透听器绝不向上抛 */ }
    };
    try {
        process.stdin.on("data", onTap);                           // 只 on('data')：不 pause / 不 resume / 不 unshift
    }
    catch { /* 非 stdio 启动（无 stdin）→ 忽略 */ }
}

/* ── 失败文案（可行动）────────────────────────────────────── */
function unavailableText(detail) {
    return `核心（MemoryOS 桌面/内核）未运行或正在重启；**不要重复调用** —— 请先启动/等待核心恢复后重试`
        + `（桌面版：启动 MemoryOS 应用；内核版：node dist/dashboard.js）。诊断：${detail}`;
}
function isRefused(e) {
    const codes = [e?.code, e?.cause?.code, ...(Array.isArray(e?.cause?.errors) ? e.cause.errors.map((x) => x?.code) : [])];
    return codes.includes("ECONNREFUSED");
}
/** ★ 2026-10-14（验收④实测发现并修）：连接级失败一律走重试 + 结构化文案。
 *  原判定只认 ECONNREFUSED；实测「核心刚被杀、客户端立刻调用」时，undici 复用的 keep-alive 连接
 *  先报 **ECONNRESET**（不是 ECONNREFUSED）⇒ 原判据不重试、把裸 `fetch failed` 抛给客户端，
 *  既缺可行动文案，行为还依赖时序（隔 ~300ms 连接被回收后才变成 ECONNREFUSED）。 */
const CONN_FAIL_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EPROTO", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
function isConnFailure(e) {
    const codes = [e?.code, e?.cause?.code, ...(Array.isArray(e?.cause?.errors) ? e.cause.errors.map((x) => x?.code) : [])];
    if (codes.some((c) => c && CONN_FAIL_CODES.has(c)))
        return true;
    return isRefused(e);
}
function isTimeout(e) {
    return e?.name === "AbortError" || e?.name === "TimeoutError" || e?.code === "UND_ERR_ABORTED" || e?.cause?.name === "AbortError";
}
/** ★ 本批：客户端精确取消（notifications/cancelled）时返回的**结构化**结果（MCP 形，文案沿用既有 ⚠ 风格）。
 *  与超时/连接失败文案区分开，避免把「被取消」误读成「核心不可达」。 */
function cancelledResult(name) {
    return { content: [{ type: "text", text: `⏹ ${name} 已被客户端取消（notifications/cancelled）：本次转发已中止（不向核心发起或中断在途调用）。` }], isError: true };
}

/* ── HTTP 转发本体 ───────────────────────────────────────── */
async function postOps(name, args, { signal, timeoutMs, identity }) {
    const port = resolvePort();
    if (!port)
        throw Object.assign(new Error(unavailableText("未设 MEMORY_PORT，且未找到 pid 仍存活的核心 core.json（核心未运行，或 core.json 已陈旧）")), { shimKind: "unavailable" });
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
    }, timeoutMs);
    const onOuterAbort = () => ac.abort();
    if (signal) {
        if (signal.aborted)
            onOuterAbort();
        else
            signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
        const headers = {
            "content-type": "application/json",
            "x-memory-token": loadToken(),                       // 只放头里，绝不打印/落盘
            "x-memory-cwd": process.cwd(),
        };
        if (identity.agent)
            headers["x-memory-agent"] = identity.agent;
        if (identity.agentFpath)
            headers["x-memory-agent-fpath"] = identity.agentFpath;
        if (identity.envCred)
            headers["x-memory-a1-cred"] = identity.envCred;      // 凭据只作头传输，不落任何日志
        const res = await fetch(`http://127.0.0.1:${port}/ops/${encodeURIComponent(name)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(args ?? {}),
            signal: ac.signal,
        });
        const text = await res.text();
        let body = null;
        try {
            body = JSON.parse(text);
        }
        catch { /* 非 JSON（如网关错误页）→ body 留 null，走下方 status 分支 */ }
        return { status: res.status, body, timedOut, port };
    }
    catch (e) {
        if (timedOut)
            throw Object.assign(new Error(unavailableText(`shim 侧 HTTP 超时 ${timeoutMs}ms（核心可能仍在执行该调用，请勿重复发起）`)), { shimKind: "timeout" });
        throw e;
    }
    finally {
        clearTimeout(timer);
        if (signal)
            signal.removeEventListener("abort", onOuterAbort);
    }
}

/** 单次调用（含 401 令牌轮换重试一次）；返回 result 裸值或 MCP 形错误结果。 */
async function callCoreOnce(name, args, { signal, timeoutMs, identity }) {
    let r = await postOps(name, args, { signal, timeoutMs, identity });
    if (r.status === 401) {
        // 令牌可能已轮换：重读一次文件（env 优先则不变）再试一次
        loadToken(true);
        r = await postOps(name, args, { signal, timeoutMs, identity });
    }
    if (r.status === 401)
        return { content: [{ type: "text", text: `⚠ ${name} 调用被核心拒绝（401 未授权）：令牌不匹配或已轮换。请确认 MEMORY_TOKEN / data/token 与核心一致后重试。` }], isError: true };
    if (r.status === 404)
        return { content: [{ type: "text", text: `⚠ ${name} 核心侧未知该工具（404）：shim 工具面与核心版本不一致，请重启核心（\`node dist/dashboard.js\`）后重试。` }], isError: true };
    if (!r.body || typeof r.body !== "object")
        return { content: [{ type: "text", text: `⚠ ${name} 核心返回了不可解析的响应（HTTP ${r.status}）：请检查核心进程日志。` }], isError: true };
    if (r.status >= 500)
        return { content: [{ type: "text", text: `⚠ ${name} 核心内部错误（HTTP ${r.status}）：详见核心进程日志。` }], isError: true };
    // 核心回的入参不合 schema（zod 未过）→ 以 MCP 形错误返回（HTTP 200，不 500）
    if (r.body.ok === false && r.body.isError)
        return { content: [{ type: "text", text: String(r.body.error ?? `${name} 入参不合 schema`) }], isError: true };
    if (r.body.ok !== true)
        return { content: [{ type: "text", text: `⚠ ${name} 核心返回口径异常（无 ok 字段）：${JSON.stringify(r.body).slice(0, 200)}` }], isError: true };
    return r.body.result ?? null;
}

/** 完整转发：连接被拒 → ≤3 次指数退避（总 ≤8s）；其余错误不重试。 */
async function callCore(name, args, { signal, timeoutMs, identity }) {
    const t0 = Date.now();
    let lastErr = null;
    for (let attempt = 1; attempt <= REFUSED_MAX_ATTEMPTS; attempt++) {
        try {
            return await callCoreOnce(name, args, { signal, timeoutMs, identity });
        }
        catch (e) {
            if (e?.shimKind === "timeout" || isTimeout(e))
                throw new Error(unavailableText(`shim 侧请求被取消或超时（${timeoutMs}ms）。若为客户端取消则忽略本行；若为超时，核心可能仍在执行，请勿重复发起`));
            if (!isConnFailure(e))
                throw e;
            lastErr = e;
            resolvePort(true); // 连接被拒 → 失效缓存（核心可能正在重启并换了端口）
            if (attempt >= REFUSED_MAX_ATTEMPTS || Date.now() - t0 >= REFUSED_MAX_TOTAL_MS)
                break;
            await sleep(Math.min(250 * 2 ** (attempt - 1), 1_000)); // 250ms → 500ms → （上限 1s）
        }
    }
    throw new Error(unavailableText(`核心不可达/连接中断（已重试 ${REFUSED_MAX_ATTEMPTS} 次 / ${Date.now() - t0}ms）：${lastErr?.message ?? lastErr}`));
}

/* ── ★ 缺口 A：工具面与核心对齐（启动期，先取 catalog 再注册）─────────
 * 问题：shim 的工具面（尤其执行面 file_read/file_write/exec_run）若由 **shim 进程自己的 env**
 *   （MEMORYOS_EXEC_ON）决定，可能与核心实际启用的工具面**不一致** —— 暴露「核心没提供的工具」，
 *   调用必然 404/失败（且客户端还以为该工具可用）。
 * 修法：启动阶段**先**向核心 `GET /ops/catalog` 取启用位（短超时 + 令牌），据此决定注册哪些工具。
 *   schema/描述仍取**本地同一份 registerAllTools 注册**（保证与 direct 逐字节一致）；核心不可达时
 *   回落本地注册态（env）并打一条 warn（明示「工具面未与核心对齐」）。
 * 时机合法性（本文件为何用顶层 await）：注册发生在**启动阶段**（server.js 模块顶层在
 *   `createShimToolface(...)` 之前）。ESM 语义保证静态导入的模块先于导入方模块体完成求值 ——
 *   故 server.js 的 `import { createShimToolface } from "./server-shim.js"` 会**等待**本块的 await 完成，
 *   「先取 catalog 再注册」无需改动 server.js 即可成立。
 * 仅在模式=shim 时探测；direct 模式零网络开销、零副作用（模式判定同 server.js::readMcpMode 口径）。 */
const CATALOG_TIMEOUT_MS = 1_500;
const VALID_MCP_MODES = new Set(["direct", "shim"]);
/** 模式快速判定（与 server.js::readMcpMode 同口径：env MEMORYOS_MCP_MODE 优先，其次 data/config.json；
 *  缺省/非法/半写 → direct）。此处只为「是否需要探测」快速判定，最终注册仍由 server.js 决定。 */
function readMcpModeSync() {
    const envMode = String(process.env.MEMORYOS_MCP_MODE ?? "").trim().toLowerCase();
    if (VALID_MCP_MODES.has(envMode)) return envMode;
    if (envMode) return "direct";                                  // 非法值 → 与 server.js 一致按 direct
    const dir = dataDirOf();
    const file = dir ? path.join(dir, "config.json") : "";
    if (!file) return "direct";
    try {
        const mode = String(JSON.parse(fs.readFileSync(file, "utf8"))?.mcpMode ?? "").trim().toLowerCase();
        return VALID_MCP_MODES.has(mode) ? mode : "direct";
    } catch { return "direct"; }                                   // 半写/截断 → direct（与 server.js 同口径）
}
/** 向核心取 catalog（短超时 + 令牌；**只读**，不打印令牌）。 */
async function probeCoreCatalog() {
    const port = resolvePort();
    if (!port)
        return { ok: false, reason: "未发现核心端口（未设 MEMORY_PORT，且 core.json 缺失或 pid 已陈旧）" };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CATALOG_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/ops/catalog`, { headers: { "x-memory-token": loadToken() }, signal: ac.signal });
        if (!res.ok)
            return { ok: false, reason: `核心 /ops/catalog HTTP ${res.status}` };
        const body = await res.json().catch(() => null);
        if (!body || typeof body !== "object")
            return { ok: false, reason: "核心 /ops/catalog 响应不可解析" };
        return { ok: true, execEnabled: body.execEnabled === true };
    }
    catch (e) {
        return { ok: false, reason: e?.name === "AbortError" ? `核心 /ops/catalog 探测超时（${CATALOG_TIMEOUT_MS}ms）` : (e?.message ?? String(e)) };
    }
    finally {
        clearTimeout(timer);
    }
}
const _CORE_ALIGN = readMcpModeSync() === "shim" ? await probeCoreCatalog() : { ok: false, skipped: true };
if (!_CORE_ALIGN.ok && !_CORE_ALIGN.skipped)
    console.error(`[shim] warn: 工具面未与核心对齐（${_CORE_ALIGN.reason}）→ 按本地注册态（env MEMORYOS_EXEC_ON）注册；核心恢复后需重启本 MCP 会话方可对齐`);
/** 与核心对齐的执行面启用位：true/false = 强制对齐；null = 核心不可达 → 不干预（回落本地 env）。 */
const _ALIGN_EXEC = _CORE_ALIGN.ok ? _CORE_ALIGN.execEnabled : null;

/**
 * 注册 shim 工具面：与 direct 模式**同一份**注册编排（registerAllTools），只把执行换成 HTTP 转发。
 * @param {object} server FastMCP 实例
 * @param {{ AGENT?:string, AGENT_FPATH?:string|null, ENV_CRED?:string|null, dbPath?:string }} ctx
 * @returns {{ tools: Map<string, object>, execEnabled: boolean }}
 */
export function createShimToolface(server, ctx = {}) {
    bindTransportClose();
    bindStdinTap();                                        // ★ 本批：stdin 只读透听（须早于 server.start 消费）
    const identity = {
        agent: ctx.AGENT ?? "unknown",
        agentFpath: ctx.AGENT_FPATH ?? null,
        envCred: ctx.ENV_CRED ?? null,
    };
    const executeOverride = async (name, def, info) => {
        const rawArgs = info?.args && typeof info.args === "object" && !Array.isArray(info.args) ? { ...info.args } : {};
        // 写类幂等工具自动补 request_id（缺失时）——网络重试/核心重启后仍只产生一次副作用
        if (IDEMPOTENT_WRITE_TOOLS.has(name) && rawArgs.request_id === undefined)
            rawArgs.request_id = crypto.randomUUID();
        // ★ 本批：按「工具名 + 参数稳定哈希」从待认领表 FIFO 认领该请求的取消控制器（取不到则新建）。
        const claim = claimPending(name, rawArgs);
        // 既有能力保留：`_meta.requestId`（fastmcp 的 extra.requestId）→ 控制器，作辅助关联（若客户端同时下发）。
        const metaKey = typeof info?.extra?.requestId === "string" && info.extra.requestId ? info.extra.requestId : null;
        if (claim?.cancelled) {                            // 取消**先到**（execute 尚未开始）→ 不向核心发起无谓调用
            settlePending(claim);
            return cancelledResult(name);
        }
        const ac = claim?.ac ?? new AbortController();
        if (!claim)
            _inflightAll.add(ac);                          // 认领到的控制器已在 tap 期登记；新建的在此登记
        if (metaKey && !_inflightByRequestId.has(metaKey))
            _inflightByRequestId.set(metaKey, ac);
        try {
            return await callCore(name, rawArgs, { signal: ac.signal, timeoutMs: timeoutOf(name), identity });
        }
        catch (e) {
            if (claim?.cancelled)                          // ★ 精确取消命中（在途被 notifications/cancelled abort）
                return cancelledResult(name);
            // 结构化 isError（MCP 形）——文案可行动，且**不**自动回退直连
            return { content: [{ type: "text", text: `⚠ ${name} 执行失败：${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
        finally {
            if (claim) {
                settlePending(claim);
            }
            else {
                _inflightAll.delete(ac);
            }
            if (metaKey && _inflightByRequestId.get(metaKey) === ac)
                _inflightByRequestId.delete(metaKey);
        }
    };
    // ★ 零 DB：ctx.db 传 null —— 注册编排本身不需要 db（db 只在工具 execute 内被消费，而此处 execute 一律被 override 截走）
    // ★ 缺口 A：注册期把执行面启用位与**核心 catalog** 对齐。registerAllTools 的启用判定读 env，
    //   故临时改写 env 再注册、注册完立即还原 —— 只在本次注册调用期间生效，不污染本进程后续行为。
    const savedOn = process.env.MEMORYOS_EXEC_ON;
    const savedOff = process.env.MEMORYOS_EXEC_OFF;
    if (_ALIGN_EXEC === true) {
        process.env.MEMORYOS_EXEC_ON = "1";
        delete process.env.MEMORYOS_EXEC_OFF;      // 核心启用则不熔断（即便本地 env 曾设 OFF）
    }
    else if (_ALIGN_EXEC === false) {
        process.env.MEMORYOS_EXEC_ON = "0";
        process.env.MEMORYOS_EXEC_OFF = "1";       // 核心未启用则强制关闭（不受本地 env=1 影响）
    }
    try {
        return registerAllTools(server, {
            db: null,
            AGENT: identity.agent,
            AGENT_FPATH: identity.agentFpath,
            ENV_CRED: identity.envCred,
            dbPath: ctx.dbPath ?? kernelDbPath(),
        }, { executeOverride });
    }
    finally {
        if (savedOn === undefined) delete process.env.MEMORYOS_EXEC_ON; else process.env.MEMORYOS_EXEC_ON = savedOn;
        if (savedOff === undefined) delete process.env.MEMORYOS_EXEC_OFF; else process.env.MEMORYOS_EXEC_OFF = savedOff;
    }
}
