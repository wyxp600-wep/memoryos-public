/** Orca 融合 P2 · github 域（2026-10-03 CLAIM §5 登记，A 分区）
 * 范围（用户 2026-10-03 拍板「读侧全功能 + 写侧降级」）：
 *  - 读侧：配置（owner/repo + token）、仓库状态、open issues/PR 列表、卡片关联 issue/PR 并回显状态；
 *  - 写侧：建 PR 端点**实现但可降级** —— 工作区无 git remote 时返回 409 {reason:"no-remote"} + 引导
 *    （本仓实证 `git remote -v` 为空 → 真实走的就是降级路径，不假装能用）。
 * 凭据：token 走 secret-store.js DPAPI 密文（githubTokenEnc 落 config.json），**明文不落盘不回传**；
 *   env GITHUB_TOKEN 优先（口径对齐 LLM_API_KEY）。非 Windows 无 DPAPI → 显式 400 + env 提示
 *   （记忆：Termux 环境禁 DPAPI，硬用必 500 —— 这里降级为可读的 400）。
 * 零新依赖：GitHub REST 直连 fetch（无 octokit/gh CLI，本机实证 gh NOT FOUND）。
 * 卡片关联零迁移：存 cards.meta.github（先例 meta.map_pos）。
 * 快照：GET /api/github/status|issues|pulls 随配置与网络变化 → 列入 ENV_DRIFT_ROUTES。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { protectSecret, unprotectSecret, forgetSecret } from "./secret-store.js";
import { logDaemon } from "./db.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(HERE, "..", "..", ".."));

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;                                  // owner/repo
const GH_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)\/?$/i;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;                                 // 与 workbench REF_RE 同口径
const API = "https://api.github.com";
const TAG = "githubToken";

export function registerGithub(app, ctx) {
    const { db, RESTRICTED, readDiskConfig, writeDiskConfig } = ctx;

    /** token 取用：env 优先 → DPAPI 密文解密（进程内缓存，明文只在内存） */
    async function ghToken() {
        const env = String(process.env.GITHUB_TOKEN ?? "").trim();
        if (env) return env;
        const cfg = readDiskConfig();
        if (cfg.githubTokenEnc) return await unprotectSecret(cfg.githubTokenEnc, TAG);
        return null;
    }

    /** GitHub REST 调用（10s 超时；错误结构化回传，不抛堆栈） */
    async function ghFetch(apiPath, init = {}) {
        const token = await ghToken();
        const headers = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "MemoryOS-Dashboard",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(init.headers ?? {}),
        };
        try {
            const r = await fetch(`${API}${apiPath}`, { ...init, headers, signal: AbortSignal.timeout(10000) });
            const text = await r.text();
            let data = null;
            try { data = JSON.parse(text); } catch { /* 非 JSON（网关错误页）→ data 留空 */ }
            return { ok: r.ok, status: r.status, data, error: r.ok ? null : String(data?.message ?? (text.slice(0, 200) || `HTTP ${r.status}`)) };
        }
        catch (e) {
            return { ok: false, status: 0, data: null, error: `GitHub API 不可达：${e?.message ?? e}` };
        }
    }

    /** 工作区 origin 是否存在（写侧降级判据） */
    async function workspaceRemote() {
        try {
            const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: WORKSPACE, timeout: 5000, windowsHide: true, shell: false, encoding: "utf8" });
            return { exists: true, url: stdout.trim() || null };
        }
        catch { return { exists: false, url: null }; }
    }

    /** 已配置仓库？未配置 → 发 400 并返回 null（调用方直接 return） */
    function requireRepo(reply) {
        const cfg = readDiskConfig();
        const repo = String(cfg.githubRepo ?? "").trim();
        if (!REPO_RE.test(repo)) {
            reply.code(400).send({ ok: false, reason: "unconfigured", error: "未配置 GitHub 仓库（owner/repo）", hint: "在卡片详情「工作区 → GitHub」填 owner/repo 保存" });
            return null;
        }
        return repo;
    }

    const audit = (op, detail) => { try { logDaemon(db, { task: "github", op, detail }); } catch { /* 审计失败不阻断 */ } };

    // ── 配置 ──
    app.get("/api/github/config", async () => {
        const cfg = readDiskConfig();
        const tokenEnv = String(process.env.GITHUB_TOKEN ?? "").trim();
        return {
            ok: true,
            repo: String(cfg.githubRepo ?? ""),
            tokenSet: !!(cfg.githubTokenEnc || tokenEnv),
            tokenSource: cfg.githubTokenEnc ? "encrypted" : (tokenEnv ? "env(GITHUB_TOKEN)" : "none"),
            canProtect: process.platform === "win32", // DPAPI 仅 Windows（非 Windows 走 env 注入）
            remote: await workspaceRemote(),
        };
    });

    app.post("/api/github/config", async (req, reply) => {
        const b = req.body ?? {};
        const cfg = readDiskConfig();
        if ("repo" in b) {
            const v = String(b.repo ?? "").trim();
            if (v && !REPO_RE.test(v))
                return reply.code(400).send({ ok: false, error: "仓库格式须为 owner/repo（如 stablyai/orca）" });
            if (v) cfg.githubRepo = v;
            else delete cfg.githubRepo;
        }
        if (b.clearToken === true) {
            delete cfg.githubTokenEnc;
            forgetSecret(TAG);
        }
        else if (typeof b.token === "string" && b.token.trim()) {
            if (process.platform !== "win32")
                return reply.code(400).send({ ok: false, error: "非 Windows 环境不支持 DPAPI 密文存储，未保存", hint: "请改用环境变量 GITHUB_TOKEN 注入（与 LLM_API_KEY 同口径）" });
            const enc = await protectSecret(b.token.trim(), TAG);
            if (!enc.ok)
                return reply.code(500).send({ ok: false, error: `token 加密失败，未保存：${enc.error}`, hint: "可改用环境变量 GITHUB_TOKEN 注入" });
            cfg.githubTokenEnc = enc.blob;
        }
        try {
            writeDiskConfig(cfg);
            audit("config-save", `repo=${cfg.githubRepo ?? "(未设)"} token=${cfg.githubTokenEnc ? "encrypted" : "未变"}`);
            return { ok: true, repo: String(cfg.githubRepo ?? ""), tokenSet: !!(cfg.githubTokenEnc || process.env.GITHUB_TOKEN) };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: "写入 config.json 失败：" + (e?.message ?? e) });
        }
    });

    // ── 仓库状态（ENV_DRIFT：随配置/网络变化） ──
    app.get("/api/github/status", async (req, reply) => {
        const repo = requireRepo(reply);
        if (!repo) return;
        const remote = await workspaceRemote();
        const r = await ghFetch(`/repos/${repo}`);
        if (!r.ok)
            return { ok: false, reason: r.status === 404 ? "not-found" : "api-error", error: r.error, remote };
        const d = r.data;
        return { ok: true, remote, repo: { full_name: d.full_name, private: !!d.private, default_branch: d.default_branch, open_issues_count: d.open_issues_count, html_url: d.html_url, pushed_at: d.pushed_at } };
    });

    // ── 读侧列表（ENV_DRIFT：网络/配置依赖） ──
    app.get("/api/github/issues", async (req, reply) => {
        const repo = requireRepo(reply);
        if (!repo) return;
        const state = ["open", "closed"].includes(String(req.query.state)) ? String(req.query.state) : "open";
        const per = Math.min(50, Math.max(1, Number(req.query.per_page) || 20));
        const r = await ghFetch(`/repos/${repo}/issues?state=${state}&per_page=${per}&sort=updated`);
        if (!r.ok)
            return reply.code(r.status === 404 ? 404 : 502).send({ ok: false, error: r.error });
        // issues 端点混入 PR（带 pull_request 字段）→ 滤掉，PR 归 pulls 列表
        const items = (Array.isArray(r.data) ? r.data : []).filter((i) => !i.pull_request).map((i) => ({
            number: i.number, title: i.title, state: i.state, html_url: i.html_url,
            comments: i.comments, updated_at: i.updated_at, labels: (i.labels ?? []).map((l) => l.name),
        }));
        return { ok: true, repo, items };
    });

    app.get("/api/github/pulls", async (req, reply) => {
        const repo = requireRepo(reply);
        if (!repo) return;
        const state = ["open", "closed", "all"].includes(String(req.query.state)) ? String(req.query.state) : "open";
        const per = Math.min(50, Math.max(1, Number(req.query.per_page) || 20));
        const r = await ghFetch(`/repos/${repo}/pulls?state=${state}&per_page=${per}&sort=updated`);
        if (!r.ok)
            return reply.code(r.status === 404 ? 404 : 502).send({ ok: false, error: r.error });
        const items = (Array.isArray(r.data) ? r.data : []).map((p) => ({
            number: p.number, title: p.title, state: p.state, draft: !!p.draft, html_url: p.html_url,
            head: p.head?.ref, base: p.base?.ref, updated_at: p.updated_at,
        }));
        return { ok: true, repo, items };
    });

    // ── 卡片关联（meta.github，零迁移） ──
    app.post("/api/github/card", (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const id = Number(req.body?.cardId);
        const url = String(req.body?.url ?? "").trim();
        const row = id ? db.prepare(`SELECT id, meta FROM cards WHERE id=?`).get(id) : null;
        if (!row)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        let meta = {};
        try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch { /* 坏 JSON 视为空 */ }
        if (!url) { // 解除关联
            delete meta.github;
            db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify(meta), id);
            audit("card-unlink", `card#${id} 解除 GitHub 关联`);
            return { ok: true, linked: false };
        }
        const m = url.match(GH_URL_RE);
        if (!m)
            return reply.code(400).send({ ok: false, error: "仅支持 GitHub issue/PR 链接，例：https://github.com/owner/repo/issues/123" });
        const [, owner, repoName, kindRaw, num] = m;
        const kind = kindRaw.toLowerCase() === "pull" ? "pr" : "issue";
        meta.github = { url, owner, repo: repoName, kind, number: Number(num), ref: `${owner}/${repoName}#${num}` };
        db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify(meta), id);
        audit("card-link", `card#${id} → ${meta.github.ref} (${kind})`);
        return { ok: true, linked: true, github: meta.github };
    });

    /** 关联状态回显：拉一次 issue/PR 真态并回写 meta.github（读侧核心） */
    app.get("/api/github/card/:id/state", async (req, reply) => {
        const id = Number(req.params.id);
        const row = id ? db.prepare(`SELECT id, meta FROM cards WHERE id=?`).get(id) : null;
        if (!row)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        let meta = {};
        try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch { /* 空 */ }
        const gh = meta.github;
        if (!gh?.ref)
            return { ok: true, linked: false };
        const r = await ghFetch(`/repos/${gh.owner}/${gh.repo}/issues/${gh.number}`); // issues 端点同时覆盖 PR
        if (!r.ok)
            return { ok: true, linked: true, stale: true, github: gh, error: r.error };
        const d = r.data;
        const merged = gh.kind === "pr" ? (d.pull_request?.merged_at ? "merged" : d.state) : d.state;
        gh.state = merged;
        gh.title = String(d.title ?? "").slice(0, 200);
        gh.updated_at = d.updated_at ?? null;
        meta.github = gh;
        db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify(meta), id);
        return { ok: true, linked: true, stale: false, github: gh };
    });

    // ── 写侧：建 PR（实现完整，无 remote 时 409 降级引导） ──
    app.post("/api/github/pr", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const repo = requireRepo(reply);
        if (!repo) return;
        const head = String(req.body?.head ?? "").trim();
        if (!BRANCH_RE.test(head))
            return reply.code(400).send({ ok: false, error: "head 分支名非法（字母开头，允许 ._/-.）" });
        // ★ 降级判据 1：工作区无 origin → 409 + 引导（本仓真实路径）
        const remote = await workspaceRemote();
        if (!remote.exists) {
            audit("pr-degraded", `no-remote head=${head}`);
            return reply.code(409).send({
                ok: false, reason: "no-remote",
                error: "工作区未配置 git 远端（origin），无法推送分支创建 PR",
                hint: "先 `git remote add origin <url>` 并 `git push -u origin <head>`，之后本端点即可用",
            });
        }
        // 降级判据 2：本地分支必须存在（防拼错分支名打到 API）
        try {
            await execFileAsync("git", ["rev-parse", "--verify", "--quiet", head], { cwd: WORKSPACE, timeout: 5000, windowsHide: true, shell: false });
        }
        catch {
            return reply.code(400).send({ ok: false, error: `本地不存在分支：${head}` });
        }
        let base = String(req.body?.base ?? "").trim();
        if (!base) {
            const st = await ghFetch(`/repos/${repo}`);
            if (!st.ok)
                return reply.code(502).send({ ok: false, error: `无法读取仓库默认分支：${st.error}` });
            base = st.data?.default_branch || "main";
        }
        const title = String(req.body?.title ?? "").trim().slice(0, 200) || head;
        const body = String(req.body?.body ?? "").trim().slice(0, 8000);
        const r = await ghFetch(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ head, base, title, body }) });
        if (!r.ok) {
            audit("pr-failed", `head=${head} base=${base} status=${r.status} ${r.error ?? ""}`);
            const hint = /already exists/i.test(r.error ?? "") ? "同名 PR 已存在" : (r.status === 422 ? "分支可能尚未推送到远端（先 git push）" : null);
            return reply.code(r.status === 404 ? 404 : 502).send({ ok: false, error: r.error, hint });
        }
        audit("pr-created", `#${r.data.number} ${head}→${base}`);
        return { ok: true, pr: { number: r.data.number, html_url: r.data.html_url, state: r.data.state } };
    });
}
