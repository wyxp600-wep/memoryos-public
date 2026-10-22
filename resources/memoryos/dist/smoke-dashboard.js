/**
 * MemoryOS v0.3 — Dashboard 冒烟（M-2.3）
 * 用 buildApp(db) + app.inject() 端到端测试，无需真实端口。
 *   F1 首页 HTML 含标题（零构建前端下发）
 *   F2 summary 返回 status 分布与总数
 *   F3 top/zombies/trend/cross-tool 注入数据后可查
 *   F4 POST /api/archive 批量归档 + 审计 operator=human:dashboard
 *   F5 归档后 top 不再召回该记忆
 *   F6 非法 ids 返回 400
 * 用法：node dist/smoke-dashboard.js
 */
import { openDb, writeMemory, logUsage } from "./db.js";
import { buildApp } from "./dashboard.js";
import { getEmbedder } from "./embed.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `memoryos-smoke-dash-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
try {
    const db = openDb(dbPath);
    // P0-2.2 fail-closed 后 buildApp 需令牌（测试修复：注入固定测试令牌，断言不变）
    const TOKEN = "smoke-test-token";
    const app = buildApp(db, { token: TOKEN });
    // 所有 inject 携带 x-memory-token（免逐处写 query）
    const inj = (o) => app.inject({ ...o, headers: { "x-memory-token": TOKEN } });
    // ★ 一致性⑥：/v1/embeddings 共享端点 —— 无令牌 401（全局钩子覆盖）；fake embedder 下 503 拒产伪向量
    const embNoTok = await app.inject({ method: "POST", url: "/v1/embeddings", payload: { input: "测试" } });
    check("⑥a./v1/embeddings 无令牌 401（全局访问控制覆盖）", embNoTok.statusCode === 401, `status=${embNoTok.statusCode}`);
    const embFake = await app.inject({ method: "POST", url: "/v1/embeddings", headers: { "x-memory-token": TOKEN }, payload: { input: "测试" } });
    /* ★ 2026-10-18（DeepSeek 收尾 P1）：断言按当前 embed 模式分派 —— 本冒烟用进程内 buildApp（app.inject），
     *   故本进程的 EMBED_MODE 生效。fake 模式下须 503（宁不服务不污染）；local 模式下须 200 且出处非 fake
     *   （真实向量可服务）。两分支均验证同一条不变量「绝不产出伪向量」，不是放宽断言。 */
    const _embMode = String(process.env.EMBED_MODE || "").toLowerCase();
    if (_embMode === "local") {
        const _body = embFake.json();
        const _model = String(_body?.model ?? "");
        check("⑥b.local embedder 下 200 且出处非 fake（不产伪向量）", embFake.statusCode === 200 && _model.length > 0 && !/fake/i.test(_model),
            `status=${embFake.statusCode} model=${_model} dim=${_body?.data?.[0]?.embedding?.length ?? "-"}`);
    }
    else {
        check("⑥b.fake embedder 下 503 拒产伪向量（宁不服务不污染）", embFake.statusCode === 503, `status=${embFake.statusCode} body=${JSON.stringify(embFake.body).slice(0, 70)}`);
    }
    const embBearer = await app.inject({ method: "POST", url: "/v1/embeddings", headers: { authorization: `Bearer ${TOKEN}` }, payload: { input: "测试" } });
    check("⑥c.Bearer 令牌过鉴权（抵达 embedder-fake 守卫=非 401）", embBearer.statusCode !== 401, `status=${embBearer.statusCode}`);
    const emb = await getEmbedder();
    const w = async (content, type, agent, project = "p1") => writeMemory(db, { content, type, agent, agent_fpath: null, project, embedding: (await emb.embedTexts([content]))[0] });
    // F1 首页
    const home = await inj({ method: "GET", url: "/" });
    // ★ 2026-09-18：断言从旧标题串 "MemoryOS Dashboard" 放宽为品牌词 "MemoryOS" ——
    //   外部 V1 重构改了 index.html 的 <title>（「MemoryOS — 跨工具…」），断言不该耦合呈现层文案（同 smoke-agent 工具面断言纪律）。
    check("F1.首页内嵌前端下发", home.statusCode === 200 && home.body.includes("MemoryOS"));
    // F2 summary（空表→注入后）
    const s0 = await inj({ method: "GET", url: "/api/summary" });
    const sum0 = s0.json();
    check("F2.空库 summary total=0", sum0.total === 0);
    // 注入：一条高价值(被 cited/returned，跨工具) + 一条僵尸(0 命中、60 天前) + 普通
    const hot = await w("订单状态机迁移到 Redis 方案", "experience", "codex");
    const zombie = await w("无人读取的旧缓存清理方案", "experience", "codex");
    const dup = await w("重复记忆仅作填充数量", "experience", "claude");
    db.prepare(`UPDATE memories SET hit_count=6 WHERE id=?`).run(hot.id);
    db.prepare(`UPDATE memories SET created_at=datetime('now','-60 days') WHERE id=?`).run(zombie.id);
    // 埋点：跨工具复用（codex 写、claude 读，returned+cited）
    logUsage(db, { memory_id: hot.id, event: "returned", reader_agent: "claude", writer_agent: "codex", project: "p1", session_id: "s1" });
    logUsage(db, { memory_id: hot.id, event: "cited", reader_agent: "claude", writer_agent: "codex", project: "p1", session_id: "s1" });
    // F3 各页可查
    const sum = (await inj({ method: "GET", url: "/api/summary" })).json();
    check("F3a.summary 反映注入(3 条)", sum.total === 3, `total=${sum.total}`);
    const top = (await inj({ method: "GET", url: "/api/top" })).json();
    check("F3b.top 有数据且含 hot", top.length > 0 && top.some((r) => r.id === hot.id));
    const zombies = (await inj({ method: "GET", url: "/api/zombies?days=30" })).json();
    check("F3c.zombies 命中僵尸", zombies.some((r) => r.id === zombie.id));
    const trend = (await inj({ method: "GET", url: "/api/trend?days=7" })).json();
    check("F3d.trend 返回数组", Array.isArray(trend));
    const ct = (await inj({ method: "GET", url: "/api/cross-tool" })).json();
    check("F3e.cross-tool 检出跨工具(cite)", ct.some((r) => r.event === "cited" && r.reader_agent === "claude"), JSON.stringify(ct));
    // F6 非法 ids
    const bad = await inj({ method: "POST", url: "/api/archive", payload: { ids: [] } });
    check("F6.空 ids 返回 400", bad.statusCode === 400);
    // F7 任务看板：写入 open/claimed/done 三种任务 → /api/tasks 分桶正确
    // （TASK_NORMALIZE 契约：open→pending、claimed→in_progress；断言对齐现行 API 桶名）
    const tOpen = await w("[task][assignee:codex][status:open] 排查 Ozon scope", "task", "trae");
    const tClaim = await w("[task][assignee:claude][status:claimed] 实现登录鉴权", "task", "trae");
    const tDone = await w("[task][assignee:zcode][status:done] 写单元测试\n→ 结论(codex)：需加 3 个用例", "task", "trae");
    const tk = (await inj({ method: "GET", url: "/api/tasks?limit=50" })).json();
    check("F7.任务看板三分桶 + 解码正确", tk.pending.some((r) => r.id === tOpen.id && r.assignee === "codex") &&
        tk.in_progress.some((r) => r.id === tClaim.id && r.assignee === "claude") &&
        tk.done.some((r) => r.id === tDone.id && r.concludedBy === "codex" && r.conclusion.includes("3 个用例")), `pending=${tk.pending?.length} in_progress=${tk.in_progress?.length} done=${tk.done?.length}`);
    // F4 人工归档 zombie，审计 operator=human:dashboard
    const arch = await inj({ method: "POST", url: "/api/archive", payload: { ids: [zombie.id] } });
    const archJson = arch.json();
    check("F4a.归档请求 ok", archJson.ok === true && archJson.archived === 1, JSON.stringify(archJson));
    const audit = (await inj({ method: "GET", url: "/api/audit" })).json().rows;
    const hit = audit.find((r) => r.memory_id === zombie.id);
    check("F4b.归档审计 operator=human:dashboard", !!hit && hit.operator === "human:dashboard" && hit.task === "manual-archive", JSON.stringify(hit));
    const status = db.prepare(`SELECT status s FROM memories WHERE id=?`).get(zombie.id).s;
    check("F4c.记忆已置 archived", status === "archived", `status=${status}`);
    // F5 归档后 top 不再含 zombie
    const topAfter = (await inj({ method: "GET", url: "/api/top?limit=20" })).json();
    check("F5.归档记忆不再被 top 召回", !topAfter.some((r) => r.id === zombie.id));
    await app.close();
    db.close();
}
finally {
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
        try {
            fs.rmSync(p, { force: true });
        }
        catch { }
    }
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
