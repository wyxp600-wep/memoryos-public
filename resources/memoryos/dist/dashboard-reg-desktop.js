/** T8（P2-3）：buildApp 路由域拆分 —— desktop 域。
 * handler 自 dashboard.js 原行 1243-1305 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { detectVaults, importVault, exportMemories, vaultStatus } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";
import { computeStatus, syncSkills, detectSkillTargets, detectedFromScan } from "./skill-sync.js";
import { Worker } from "node:worker_threads";
import { scanAgentsAsync } from "./scan.js";
import path from "node:path";
export function registerDesktop(app, ctx) {
    const { db,  } = ctx;
    // —— Obsidian 同步：vault 探测 / 状态 / 导入 / 导出（复用 obsidian-sync.js，逻辑不重写）——
    app.get("/api/obsidian/vaults", async () => ({ vaults: detectVaults() }));
    app.get("/api/obsidian/status", async (req, reply) => {
        const vault = req.query.vault;
        if (!vault)
            return reply.code(400).send({ error: "vault 参数必填" });
        try {
            const s = vaultStatus(db, vault);
            const imported = db
                .prepare(`SELECT note_path, memory_id, substr(note_hash,1,8) AS note_hash, mtime_ms, created_at FROM obsidian_sync WHERE vault_root=? ORDER BY created_at DESC LIMIT 200`)
                .all(path.resolve(vault));
            return { ...s, imported };
        }
        catch (e) {
            return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/api/obsidian/import", async (req, reply) => {
        const vault = req.body.vault;
        if (!vault)
            return reply.code(400).send({ ok: false, error: "vault 必填" });
        try {
            const embedder = await getEmbedder();
            const stats = await importVault(db, embedder, {
                vaultPath: vault,
                project: req.body.project,
                dryRun: !!req.body.dry_run,
                agent: "obsidian",
            });
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/api/obsidian/export", async (req, reply) => {
        const vault = req.body.vault;
        if (!vault)
            return reply.code(400).send({ ok: false, error: "vault 必填" });
        try {
            const stats = exportMemories(db, {
                vaultPath: vault,
                project: req.body.project,
                type: req.body.type,
                limit: req.body.limit,
            });
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    // —— 技能同步：中央库状态 / 一键分发（复用 skill-sync.js，纯文件操作不依赖 db）——
    // ★ 2026-10-15 启动加速（两层叠加，TTL 缓存对冷启动无效，必须挪出主线程）：
    //   ① 60s TTL 缓存（同提交 d2130e0）——只惠顾同进程二次请求；
    //   ② worker 线程预热——computeStatus()（同步 fs ~2.3s）+ detectSkillTargets()
    //      （→ scanAgents() spawnSync ~2.1s）在 worker 内执行，**不阻塞主事件循环**，
    //      首屏并发请求潮里的 /app.js、/echarts.min.js 等不再被堵 10s+。
    //   worker 失败 → 同步兜底跑原路径（行为不劣于修复前）。
    let skillsCache = { at: 0, value: null };
    const SKILLS_TTL_MS = 60_000;
    let skillsInflight = null;
    let skillsGen = 0; // syncSkills 分发后作废在途 worker 结果，防「分发后仍读旧状态」
    const getSkillsStatusCached = () => {
        const now = Date.now();
        if (!skillsCache.value || now - skillsCache.at >= SKILLS_TTL_MS)
            return null;
        return skillsCache.value;
    };
    const computeSkillsInWorker = () => {
        if (skillsInflight)
            return skillsInflight;
        const gen = skillsGen;
        skillsInflight = new Promise((resolve) => {
            const w = new Worker(new URL("./skills-status-worker.js", import.meta.url));
            w.once("message", async (v) => {
                w.terminate();
                if (v) {
                    // detected 走主线程共享扫描（scanAgentsAsync：命中缓存或在途合并，零额外 spawnSync 流）
                    const scan = await scanAgentsAsync();
                    const full = { ...v, detected: scan ? detectedFromScan(scan.agents ?? []) : [] };
                    if (gen === skillsGen)
                        skillsCache = { at: Date.now(), value: full };
                    resolve(full);
                }
                else {
                    resolve(null);
                }
            });
            w.once("error", () => { w.terminate(); resolve(null); });
        }).finally(() => { skillsInflight = null; });
        return skillsInflight;
    };
    // 预热：延迟 1.5s 发车（与 scan.js primeScanAgentsInWorker 同口径错峰）——
    //   fs 扫描 burst 曾实测拖慢主线程 socket 传输（echarts 31ms→4590ms）；
    //   load 事件只等 echarts，故首屏 render 先完成，扫盘结果随后到（fetch 不阻塞 load）。
    setTimeout(() => { void computeSkillsInWorker(); }, 1500).unref?.();
    app.get("/api/skills/status", async () => {
        const cached = getSkillsStatusCached();
        if (cached)
            return cached;
        const v = await computeSkillsInWorker();
        // worker 彻底失败（返回 null）→ 同步兜底原路径（含 detectSkillTargets 的 scanAgents）
        return v ?? { ...computeStatus(), detected: detectSkillTargets() };
    });
    app.post("/api/skills/sync", async (req, reply) => {
        try {
            const results = syncSkills(!!req.body.dry_run);
            // 分发是显式写操作：清缓存 + generation++，让下一次 status 反映分发结果（不等 TTL）
            skillsGen += 1;
            skillsCache = { at: 0, value: null };
            return { ok: true, dry_run: !!req.body.dry_run, results };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
}
