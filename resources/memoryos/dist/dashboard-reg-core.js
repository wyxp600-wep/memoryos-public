/** T8（P2-3）：buildApp 路由域拆分 —— core 域。
 * handler 自 dashboard.js 原行 230-499 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { archiveMemory, logDaemon, withTx, pendingConflicts, applyArbitration, markMerged, SECTOR_KEYS } from "./db.js";
import { funnel, trend, topMemories, zombies, crossTool } from "./report.js";
import { buildPlan, loadHygieneConfig } from "./daemon.js";
import { resolveLlm } from "./agent-core.js";
import { protectSecret, forgetSecret } from "./secret-store.js";
import { probeEndpoint, normalizeLlmEndpoint, llmConf } from "./llm.js";
import path from "node:path";
export function registerCore(app, ctx) {
    const { db, restricted, RESTRICTED, clampLimit, dataDirOf, readDiskConfig, writeDiskConfig, DEFAULT_PORT } = ctx;
    // —— 概览：status 分布 + 总条数 + 类别分布 + secret 计数（R4：H4 仅计数不含内容）——
    app.get("/api/summary", async () => {
        const statusRows = db
            .prepare(`SELECT status, COUNT(*) c FROM memories GROUP BY status ORDER BY c DESC`)
            .all();
        const total = statusRows.reduce((s, r) => s + r.c, 0);
        const effMin = db.prepare(`SELECT MIN(eff_confidence) m FROM memories WHERE status='active'`).get().m;
        // ★ P3：类别分布（9 类，缺省补 0）+ secret 计数（仅计数）
        const sectorRows = db
            .prepare(`SELECT sector, COUNT(*) c FROM memories GROUP BY sector`)
            .all();
        const sectorMap = new Map(sectorRows.map((r) => [r.sector, r.c]));
        const sector_distribution = SECTOR_KEYS.map((k) => ({ sector: k, count: sectorMap.get(k) ?? 0 }));
        const secret_count = Number(db.prepare(`SELECT COUNT(*) c FROM memories WHERE sensitivity='secret'`).get().c);
        return {
            total,
            statusRows,
            minActiveEff: effMin,
            sector_distribution,
            secret_count,
            // 受限能力位：前端据此隐藏入口（单一信源，避免前后端限制漂移）
            restricted: {
                enabled: RESTRICTED,
                taskCreate: RESTRICTED,
                planImport: RESTRICTED,
                customSource: RESTRICTED,
                // ★ M8（R4 裁决）：能力位 +6。cardComment 受限时可评论（只读板 + 自认领卡可流转）
                cardCreate: RESTRICTED,
                cardDispatch: RESTRICTED,
                cardComment: !RESTRICTED,
                cardLink: RESTRICTED,
                noteCreate: RESTRICTED,
                cardToMemory: RESTRICTED,
                // ★ 2026-09-15：Agent 页写门禁能力位（受限模式 → agent 仅只读，前端隐藏「允许写入」勾选）
                agentWrite: RESTRICTED,
            },
        };
    });
    // —— 设置面板：config.json 读 / 写（LLM、受限模式、数据目录、端口、状态）——
    app.get("/api/config", async () => {
        const cfg = readDiskConfig();
        const dbPath = process.env.MEMORY_DB ?? "";
        const port = Number(process.env.MEMORY_PORT ?? DEFAULT_PORT);
        const _dh = db.prepare(`SELECT created_at FROM daemon_log ORDER BY id DESC LIMIT 1`).get();
        const _hrs = _dh && _dh.created_at ? (Date.now() - new Date(_dh.created_at).getTime()) / 3600000 : null;
        return {
            llmUrl: String(cfg.llmUrl ?? ""),
            llmModel: String(cfg.llmModel ?? process.env.INGEST_MODEL ?? ""),
            // ★ 2026-09-15：密钥状态改为反映**真实可用的来源**（原实现取 cfg.llmKey，而它从不落盘 → 永远 false）
            llmKeySet: !!(cfg.llmKeyEnc || process.env.LLM_API_KEY || process.env.INGEST_KEY),
            llmKeySource: cfg.llmKeyEnc ? "encrypted" : (process.env.LLM_API_KEY ? "env(LLM_API_KEY)" : (process.env.INGEST_KEY ? "env(INGEST_KEY)" : "none")),
            llmEffective: await (async () => {
                const c = await llmConf();
                return { url: c.url, model: c.model, source: c.source, keySource: c.keySource };
            })(),
            restricted: cfg.restricted === true,
            restrictedActive: RESTRICTED,
            // ★ 2026-10-14（架构重构 1b 收口）：MCP 模式（direct=直连 / shim=薄转发）；缺省（字段不存在）= direct
            mcpMode: cfg.mcpMode === "shim" ? "shim" : "direct",
            port,
            dataDir: dataDirOf(),
            dbPath,
            dbName: dbPath ? path.basename(dbPath) : "memory.db",
            // 真实状态：查询 daemon_log 最近运行时间
            processAlive: _hrs === null || _hrs > 26 ? false : true,
            daemonStale: _hrs === null || _hrs > 26,
            hoursSince: _hrs !== null ? Number(_hrs.toFixed(1)) : null,
        };
    });
    app.post("/api/config", async (req, reply) => {
        const b = (req.body ?? {});
        const cfg = readDiskConfig();
        let llmTouched = false;
        if (b.llmUrl !== undefined) {
            const v = String(b.llmUrl ?? "").trim();
            if (v)
                cfg.llmUrl = v;
            else
                delete cfg.llmUrl;
            llmTouched = true;
        }
        if (b.llmModel !== undefined) {
            const v = String(b.llmModel ?? "").trim();
            if (v)
                cfg.llmModel = v;
            else
                delete cfg.llmModel;
            llmTouched = true;
        }
        // ★ 2026-09-15：密钥改为 DPAPI 密文落盘（llmKeyEnc）；明文只存在于请求内，不落盘。
        if (b.clearLlmKey === true) {
            delete cfg.llmKeyEnc;
            delete cfg.llmKey;
            forgetSecret();
            llmTouched = true;
        }
        else if (typeof b.llmKey === "string" && b.llmKey.trim()) {
            const enc = await protectSecret(b.llmKey.trim());
            if (!enc.ok)
                return reply.code(500).send({ ok: false, error: `密钥加密失败，未保存：${enc.error}`, hint: "可改用环境变量 LLM_API_KEY 注入密钥" });
            cfg.llmKeyEnc = enc.blob;
            delete cfg.llmKey;
            llmTouched = true;
        }
        const restrictedChanged = typeof b.restricted === "boolean" && b.restricted !== (cfg.restricted === true);
        if (typeof b.restricted === "boolean")
            cfg.restricted = b.restricted;
        // ★ 2026-10-14（架构重构 1b 收口）：MCP 模式（direct/shim）—— 只落 config.json 的 `mcpMode`；
        //   ★ 生效时机：模式由 **MCP 客户端进程**在启动时读取（server.js::readMcpMode），故切换**只对
        //     新开的 MCP 客户端会话生效** —— 已连接的 Agent 需重开会话。缺省（字段不存在）= direct，不写 null。
        let mcpModeTouched = false;
        if (b.mcpMode !== undefined) {
            const v = String(b.mcpMode ?? "").trim().toLowerCase();
            if (v !== "direct" && v !== "shim")
                return reply.code(400).send({ ok: false, error: "mcpMode 须为 direct|shim" });
            cfg.mcpMode = v;
            mcpModeTouched = true;
        }
        try {
            writeDiskConfig(cfg);
            // LLM 配置现已「现读」（llm.js llmConf / agent-core resolveLlm 都每次读 config.json）→ 即时生效
            // 只有受限模式这类启动期环境变量仍需要重启内核重新注入。
            return {
                ok: true,
                restartRequired: restrictedChanged,
                llmEffective: llmTouched ? "saved" : undefined,
                note: mcpModeTouched
                    ? "已保存：MCP 模式切换只对新开的 MCP 客户端会话生效——已连接的 Agent 需重开会话"
                    : restrictedChanged
                        ? "已保存：LLM 配置即时生效；受限模式切换需重启内核"
                        : "已保存，即时生效（无需重启内核）",
            };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: "写入 config.json 失败：" + (e instanceof Error ? e.message : String(e)) });
        }
    });
    /** 设置页「测试连接」：用**表单里还没保存的值**真发一次 max_tokens=1 请求，定位是 URL/密钥/模型哪一步不对 */
    app.post("/api/config/test-llm", async (req) => {
        const b = (req.body ?? {});
        const cfg = readDiskConfig();
        const saved = await llmConf();
        const url = normalizeLlmEndpoint(String(b.llmUrl ?? "").trim() || cfg.llmUrl || saved.url);
        const model = String(b.llmModel ?? "").trim() || cfg.llmModel || saved.model;
        // 表单没填密钥 → 用已保存的（env 或解密）
        let key = String(b.llmKey ?? "").trim();
        if (!key)
            key = saved.key;
        return probeEndpoint({ url, model, key }, Number(b.timeoutMs) || 15000);
    });
    // —— 记忆卫生建议（只读，不落库）：治理阈值 + 去重/归档候选，供前端"建议→人工确认"环 ——
    app.get("/api/hygiene/suggestions", async () => {
        const config = loadHygieneConfig(db);
        const plan = buildPlan(db); // buildPlan 纯计算，不写库，安全
        const ids = [
            ...new Set([...plan.dedupes.flatMap((d) => [d.winner, d.loser]), ...plan.archives.map((a) => a.id)]),
        ];
        const contentMap = new Map();
        if (ids.length) {
            const ph = ids.map(() => "?").join(",");
            const rows = db
                .prepare(`SELECT id, content, type FROM memories WHERE id IN (${ph})`)
                .all(...ids);
            rows.forEach((r) => contentMap.set(Number(r.id), { content: r.content, type: r.type }));
        }
        return {
            config,
            dedupeSuggestions: plan.dedupes.map((d) => ({
                winner: d.winner,
                loser: d.loser,
                sim: d.sim,
                crossSource: d.crossSource,
                winnerSnippet: contentMap.get(d.winner)?.content ?? null,
                loserSnippet: contentMap.get(d.loser)?.content ?? null,
            })),
            archiveSuggestions: plan.archives.map((a) => ({
                id: a.id,
                type: a.type,
                eff: a.eff,
                reason: a.reason,
                daysSinceExposure: a.daysSinceExposure,
                snippet: contentMap.get(a.id)?.content ?? null,
            })),
        };
    });
    // —— 记忆卫生「人工确认」：仅应用用户勾选的建议项（单事务，逐条留痕，不碰全量 applyPlan）——
    app.post("/api/hygiene/apply", async (req, reply) => {
        const archiveIds = (req.body?.archiveIds ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
        const merges = (req.body?.merges ?? []).filter((m) => Number.isFinite(Number(m.winner)) && Number.isFinite(Number(m.loser)) && m.winner > 0 && m.loser > 0).map((m) => ({ winner: Number(m.winner), loser: Number(m.loser) }));
        if (!archiveIds.length && !merges.length) {
            return reply.code(400).send({ ok: false, error: "请至少选择一项" });
        }
        try {
            let archived = 0;
            let merged = 0;
            withTx(db, () => {
                for (const id of archiveIds) {
                    // 归档前检：仅 active 才动，避免重复/已不存在项
                    const row = db.prepare(`SELECT status FROM memories WHERE id=?`).get(id);
                    if (!row || row.status !== "active")
                        continue;
                    archiveMemory(db, id);
                    logDaemon(db, { task: "manual-archive", op: "archive", memory_id: id, operator: "human:dashboard", detail: "记忆卫生·人工归档" });
                    archived++;
                }
                for (const m of merges) {
                    const lr = db.prepare(`SELECT status FROM memories WHERE id=?`).get(m.loser);
                    if (!lr || lr.status !== "active")
                        continue;
                    markMerged(db, m.loser, m.winner);
                    logDaemon(db, { task: "dedupe", op: "merge", memory_id: m.loser, operator: "human:dashboard", detail: `记忆卫生·人工合并 → #${m.winner}` });
                    merged++;
                }
            });
            return { ok: true, archived, merged };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
    });
    // —— 复用周报五查询（仅 active 过滤已内置于 top/zombies）——
    app.get("/api/funnel", async () => funnel(db, {}));
    app.get("/api/trend", async (req) => trend(db, { days: req.query.days ? Number(req.query.days) : 14 }));
    app.get("/api/top", async (req) => topMemories(db, { limit: clampLimit(req.query.limit, 10, 500) }));
    // ★ 2026-10-18（用户报障「记忆显示的数量不对」）：limit 上限 500 → 2000。
    //   前端徽标取的是返回数组长度，上限 500 会重演「假数字」（实测真实僵尸 622 条，徽标却显示 50）。
    //   排序/口径不变，只放宽传输上限；调用方不传 limit 时默认值仍为 20（行为不变）。
    app.get("/api/zombies", async (req) => zombies(db, {
        days: req.query.days ? Number(req.query.days) : 30,
        limit: clampLimit(req.query.limit, 20, 2000),
    }));
    app.get("/api/cross-tool", async (req) => crossTool(db, { limit: clampLimit(req.query.limit, 20, 500) }));
    // —— 仲裁队列：pending-conflict 列表（含旧记忆内容） ——
    app.get("/api/conflicts", async () => {
        const conflicts = pendingConflicts(db);
        return { count: conflicts.length, items: conflicts.map((c) => ({
                id: c.pending.id,
                type: c.pending.type,
                agent: c.pending.agent,
                content: c.pending.content,
                confidence: c.pending.confidence,
                eff: c.pending.eff_confidence ?? c.pending.confidence,
                hits: c.pending.hit_count,
                created_at: c.pending.created_at,
                conflict_with: c.pending.conflict_with,
                old_id: c.old?.id ?? null,
                old_content: c.old?.content ?? null,
                old_type: c.old?.type ?? null,
            })) };
    });
    // —— 仲裁操作：key=1保留新/2保留旧/3合并/4不冲突 ——
    app.post("/api/conflict/:id", async (req, reply) => {
        const id = Number(req.params.id);
        const key = req.body?.key;
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        if (!["1", "2", "3", "4"].includes(key))
            return reply.code(400).send({ ok: false, error: "key 非法，必须为 1/2/3/4" });
        try {
            const result = applyArbitration(db, id, key);
            logDaemon(db, { task: "arbitrate", op: key, memory_id: id, operator: "human:dashboard", detail: result });
            return { ok: true, result };
        }
        catch (e) {
            return reply.code(400).send({ ok: false, error: String(e) });
        }
    });
    // —— 人工归档：ids 批量置 archived，审计 operator=human:dashboard（单事务） ——
    app.post("/api/archive", async (req, reply) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
        if (!ids.length)
            return reply.code(400).send({ ok: false, error: "ids 为空或非法" });
        let archived = 0;
        try {
            withTx(db, () => {
                for (const id of ids) {
                    archiveMemory(db, id);
                    logDaemon(db, { task: "manual-archive", op: "archive", memory_id: id, operator: "human:dashboard", detail: "Dashboard 人工归档" });
                    archived++;
                }
            });
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
        return { ok: true, archived };
    });
    // —— 新建记忆：human 手动写入（agent=human:dashboard，审计留痕；自动生成向量进语义路） ——
}
