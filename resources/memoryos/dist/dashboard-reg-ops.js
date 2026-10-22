/**
 * MemoryOS dashboard — 核心侧工具面接口（★ 2026-10-14 架构重构 1a / 1b）
 *
 * 三条路由（核心 = dashboard 进程持有唯一一份工具面 Map，见 server-tools.js::registerAllTools）：
 *   POST /ops/:tool    → 按工具 schema 解析入参 → 派发 def.execute → 回 { ok:true, result:<**裸值**> }
 *   GET  /ops/catalog   → 工具清单（name/description）+ execEnabled + embedderLoaded
 *                          （★ 1c：`?vec=1` 追加 vecInvalidations；无参响应体保持逐字节不变，保 snapshot:check 零漂移）
 *   GET  /health        → 核心存活探针 {ok, port, pid, startedAt}
 *
 * 鉴权：**零新增暴露面** —— 走既有全局令牌门禁（dashboard.js 的 installAccessControl onRequest 钩子，
 *   x-memory-token / Authorization: Bearer / ?token= / cookie 四者任一）。本模块不写鉴权逻辑；
 *   无令牌 → 401，Host 非回环 → 403，与既有全部路由同一口径。
 *
 * ── 返回口径（★ 1b 关键决策）：回裸值 + 信封 ──────────────────────────
 *   响应体是 `{ ok:true, result: <def.execute 的原始返回值> }`，
 *   **不再**由本模块自行包 `{content:[...]}`。
 *   理由：MCP stdio shim（server-shim.js，经 `POST /ops/:tool` 转发）拿到 `result` 后要**原样**交回
 *   fastmcp 协议层，由 fastmcp 用它自己的规则包装（字符串 → `{content:[{type:"text",text}]}`、
 *   对象含 `type` → 单条、其余 → ContentResultZodSchema 解析，见 fastmcp dist/chunk-UVX47AE5.js:1141-1155）。
 *   只有把**与 direct 模式一模一样的裸值**交给 shim，客户端可见输出才能逐字节一致；
 *   若本模块先包一层 content，shim 侧 `"type" in r` 判定与协议层包装口径就会与 direct 错位。
 *
 * ── 入参解析（★ 1b 修缺陷）──────────────────────────────────────────
 *   原实现直接 `def.execute(args)`，**跳过了 fastmcp 的 zod 解析**（default 填充 / 校验）。
 *   实测：不带 `type` 调 memory_write → `args.type` 为 undefined →
 *   `Provided value cannot be bound to SQLite parameter 2`（direct 模式不会：fastmcp 先按 schema 解析并填默认值）。
 *   现改为与 fastmcp 协议层同口径：`def.parameters.safeParse(args)`（fastmcp 走的是同一 schema 的
 *   `~standard.validate`，解析结果等价）——
 *     · 成功 → 用 parsed 调 `def.execute(parsed)`；
 *     · 失败 → 回 `{ ok:false, isError:true, error:<zod issues 文本> }`（HTTP 仍 **200**，MCP 形，**不要 500**）。
 *   注意 `undefined`：`result === undefined` 时显式写 `null`，避免响应体出现非法 JSON。
 *
 * ── 取消（★ 1b）──────────────────────────────────────────────────
 *   监听请求中断（Fastify `req.raw` 的 `close` / `aborted`）→ 生成 per-request `AbortSignal`，
 *   经 `withToolIdentity({..., signal})` 放进请求上下文；exec_run / [gate] 验收子进程据此杀进程树。
 *   正常完成时 `close` 也会触发，故 finally 里先撤监听 + 用 `reply.raw.writableEnded` 兜底。
 */
import { embedderLoaded } from "./embed.js";
import { vecInvalidationStats } from "./db.js"; // ★ 1c：核心进程内「向量缓存/L1 失效」统计（只读导出，零 I/O）
import { withToolIdentity } from "./server-tools.js"; // ★ 1b：请求级身份 + 取消信号载体
import {recordFeedback} from './feedback-events.js';

/** zod issues → 单行文案（与 fastmcp 的 formatInvalidParamsErrorMessage 同形：`path: message` 逗号分隔） */
function zodIssuesText(err) {
    const issues = Array.isArray(err?.issues) ? err.issues : [];
    if (!issues.length)
        return String(err?.message ?? "参数校验失败");
    return issues.map((i) => `${(i.path ?? []).join(".") || "root"}: ${i.message}`).join(", ");
}

export function registerOps(app, ctx) {
    const { opsTools, opsExecEnabled, DEFAULT_PORT } = ctx;
    const startedAt = new Date().toISOString();

    app.get("/health", async () => ({
        ok: true,
        port: Number(process.env.MEMORY_PORT ?? DEFAULT_PORT),
        pid: process.pid,
        startedAt,
    }));

    // ★ 1c（2026-10-14）：响应**追加** `vecInvalidations`（additive，既有键一个不动、**零新增路由**）。
    //   · 为什么用查询参数门控：本端点是无参 GET，其响应体已被 `outputs/route-snapshot.json` **逐字节快照**
    //     （snapshot-routes.js 对全部无参 GET 记录 sha256）。无条件追加会让 `snapshot:check` 出现硬差异，
    //     而本批硬要求「snapshot:check EXIT=0 且不重定基线」——两者在 /ops/catalog 上直接冲突。故：
    //       GET /ops/catalog        → 响应体与改前**逐字节一致**（快照零漂移）
    //       GET /ops/catalog?vec=1  → 追加 `vecInvalidations`（`?full=1` 同义）
    //     若希望默认即暴露，需在干净树重定快照基线（属另一批，本批不做）。
    //   · 数据源 = 本进程（核心）的 `vecInvalidationStats()`：{total,lastAt,byHour,bySource,lastSource}。
    app.get("/ops/catalog", async (req) => {
        const out = {
            tools: [...opsTools.values()].map((d) => ({ name: d.name, description: d.description })),
            execEnabled: opsExecEnabled === true,
            embedderLoaded: embedderLoaded(),
        };
        if (req.query?.vec === "1" || req.query?.full === "1")
            out.vecInvalidations = vecInvalidationStats();
        return out;
    });

    app.post("/ops/:tool", async (req, reply) => {
        const name = String(req.params.tool ?? "");
        const def = opsTools.get(name);
        if (!def)
            return reply.code(404).send({ ok: false, error: `未知工具：${name}`, tools: opsTools.size });
        const raw = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
        // ── 按工具 schema 解析入参（口径同 fastmcp 协议层；失败回 MCP 形 isError，不 500）──
        let args = raw;
        if (def.parameters && typeof def.parameters.safeParse === "function") {
            const parsed = def.parameters.safeParse(raw);
            if (!parsed.success) {
                recordFeedback(ctx.db,{agent:String(req.headers['x-memory-agent']||'unknown'),tool:name,status:'failed',code:'schema_rejected'});
                return { ok: false, isError: true, error: `工具 ${name} 入参不合 schema：${zodIssuesText(parsed.error)}` };
            }
            args = parsed.data;
        }
        // ★ 1b：请求中断 → per-request AbortSignal（下游 exec_run / 验收子进程据此杀进程树）
        //   ★ 2026-10-14 修复（实测缺陷）：**不可用 `req.raw` 的 'close'** —— Node ≥16 起
        //     IncomingMessage 的 'close' 在**请求体读完（消息完成）**时即触发，并不等客户端断开。
        //     实测后果：直连核心 `POST /ops/exec_run` 会在 ~250–530ms 被误判成"客户端断开"→
        //     AbortSignal 触发 → 子进程被杀（长耗时工具经 /ops 根本跑不完）。
        //   改为监听 **`reply.raw` 的 'close'**（只在连接真的关掉时发；正常完成时 writableEnded
        //   已为 true，被守卫挡掉），并保留 **`req.raw` 的 'aborted'**（该事件只在客户端中止时触发）。
        const _ac = new AbortController();
        const _onAbort = () => {
            if (reply.raw?.writableEnded)
                return;               // 响应已写完的连接关闭不算中断
            try { _ac.abort(); } catch { /* 已中止 */ }
        };
        const _reqRaw = req.raw;
        const _repRaw = reply.raw;
        try { _reqRaw?.on?.("aborted", _onAbort); } catch { /* 无 raw（非 HTTP）→ 忽略 */ }
        try { _repRaw?.on?.("close", _onAbort); } catch { /* 同上 */ }
        // ★ 1b：按请求头建立调用方身份后再派发（缺省回落核心进程 env = direct 行为）。
        //   契约头（仅用于身份标识，**不**参与鉴权）：x-memory-agent / x-memory-agent-fpath / x-memory-a1-cred；
        //   鉴权仍由既有全局令牌门禁（x-memory-token / Bearer / ?token= / cookie）负责，本模块不新增鉴权。
        //   ★ 1b 收口（缺口 B）：x-memory-cwd ← 调用方 cwd（shim 透传）—— 执行面在调用方未显式给 cwd/路径
        //     基准时改用它解析相对路径（口径见 exec-tools.js::pickBase），使 shim 与 direct 语义等价。
        const _hdr = (v) => { const s = Array.isArray(v) ? v[0] : v; return typeof s === "string" && s.length ? s : undefined; };
        const ident = {
            agent: _hdr(req.headers["x-memory-agent"]),
            agentFpath: _hdr(req.headers["x-memory-agent-fpath"]),
            envCred: _hdr(req.headers["x-memory-a1-cred"]),
            clientCwd: _hdr(req.headers["x-memory-cwd"]),   // ★ 缺口 B：调用方 cwd（可缺省）
            signal: _ac.signal,
        };
        try {
            const result = await withToolIdentity(ident, () => def.execute(args));
            // 裸值 + 信封：undefined 显式写 null，保证响应体合法 JSON（JSON.stringify 会丢 undefined 字段）
            return { ok: true, result: result === undefined ? null : result };
        }
        finally {
            // 撤监听：本请求已完成，后续的连接关闭不得再触发 abort
            try { _reqRaw?.off?.("aborted", _onAbort); } catch { /* 忽略 */ }
            try { _repRaw?.off?.("close", _onAbort); } catch { /* 忽略 */ }
        }
    });
}
