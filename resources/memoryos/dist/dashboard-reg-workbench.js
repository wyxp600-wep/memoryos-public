/** Orca 融合 P0+P1 · workbench 域（2026-10-03 CLAIM §5 登记，A 分区）
 * 能力：① 并行 git worktree 编排（list/create/remove + 卡片关联）② worktree 变更清单 + unified diff
 *       ③ 卡片行级 diff 批注（复用 card_comments 表，零迁移）④ 拖拽文件上传（base64，落 artifacts，零新依赖）
 * 设计依据：
 *  - 记忆 #4519（Orca 原则）：**默认共享工作区，仅在并行任务真实冲突时才建隔离 worktree** —— 本域绝不自动建，必须显式 POST；
 *  - 零新 npm 依赖：git 走 execFile 参数数组（不经过 shell 拼接，杜绝注入），diff/上传自写；
 *  - exec_run cwd 白名单：worktree 落在 `<workspace>/.worktrees/` 内 → 天然在 exec-tools resolveInside 白名单内，Agent 可直接在其中执行命令（零改动）；
 *  - RESTRICTED 下写操作一律 403（对齐知识/卡片域体例）；路径/名称一律白名单正则 + 段校验，防逃逸。
 * 门禁：npm run snapshot 重定基线（/api/worktrees 列入 env-drift）→ snapshot:check 0 硬差异；npm test / lint 全绿。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile); // 成功 resolve {stdout,stderr}（无 status）；非零退出 reject（e.stderr 可取）

const HERE = path.dirname(fileURLToPath(import.meta.url));                                     // .../resources/memoryos/dist
/** 工作区口径与 server.js:159 一致：MEMORYOS_WORKSPACE 优先，缺省 = 仓根（dist/../../..） */
const WORKSPACE = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(HERE, "..", "..", ".."));
const WT_ROOT = path.join(WORKSPACE, ".worktrees");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;   // 首字符禁 . 与 - → 天然排除 ".."/".git"/"-option"
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;    // base/ref（分支名或 sha）
const UPLOAD_MAX = 5 * 1024 * 1024;                    // 拖拽上传上限 5MB
const DIFF_MAX_BYTES = 512 * 1024;                     // diff 返回上限（超出截断 + truncated 标记）
const SECRET_PAT = /(secret|密码|passwd|token|api[_-]?key|私密)/i; // 与卡片评论同款敏感扫描

/** 相对路径安全校验：拒绝对路径/盘符/`..` 段/`|`（批注编码分隔符）；反斜杠归一为 / */
function safeRelPath(p) {
    const s = String(p ?? "").replace(/\\/g, "/").trim();
    if (!s || s.length > 500) return null;
    if (/^[A-Za-z]:/.test(s) || s.startsWith("/")) return null;
    if (s.split("/").some((seg) => seg === "..")) return null;
    if (s.includes("|") || s.includes("\0")) return null;
    return s;
}
/** 上传名净化：仅保留 [A-Za-z0-9._-]（须过 /api/artifacts/:id 下载端点的正则），点串压成单点，前缀时间戳防撞 */
function sanitizeUploadName(orig) {
    const base = path.basename(String(orig ?? "")).replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").replace(/-{2,}/g, "-").replace(/^[.\-]+/, "");
    if (!base) return null;
    return `up-${Date.now()}-${base}`.slice(0, 180);
}

/** 目录体检（只读诊断用）：统计文件数/字节数，**绝不跟随链接点**。
 *  ★ 2026-10-05 批4：门禁 worktree 用 junction 供给 node_modules（实测 `git worktree remove --force`
 *  不删穿 junction 目标，但目录含 junction 时回收必失败留孤儿）——所以任何"数一遍/删一遍"的
 *  递归都必须先判链接：realpath 与自身不一致即链接点，跳过不进入，否则会把主树 260 个包数进来。 */
function treeStats(root) {
    let files = 0, bytes = 0, links = 0, unreadable = 0;
    const CAP = 2000;
    const stack = [root];
    while (stack.length && files < CAP) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) {
            unreadable++;
            console.warn(`[workbench] 回收体检：目录不可读已跳过（${path.basename(dir)}）：${String(e?.code ?? e?.message ?? e).slice(0, 60)}`);
            continue;
        }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            let st;
            try { st = fs.lstatSync(p); }
            catch { continue; }
            if (st.isSymbolicLink()) { links++; continue; }
            if (st.isDirectory()) {
                let rp;
                try { rp = fs.realpathSync(p); }
                catch { continue; }
                if (path.resolve(rp).toLowerCase() !== path.resolve(p).toLowerCase()) { links++; continue; } // junction/挂载点
                stack.push(p);
            }
            else if (st.isFile()) { files++; bytes += Number(st.size || 0); }
        }
    }
    return { files, bytes, links, unreadable, truncated: files >= CAP };
}

/** 孤儿检出：`.worktrees/` 下**磁盘有目录但 git 注册表不认**的残留。
 *  这类目录对既有实现是双向死锁——DELETE 交给 `git worktree remove` 得 `not a working tree` → 502，
 *  POST 同名因目录存在 → 409，而它又不出现在 `items[]` 里，前端根本看不见。 */
function listOrphanWorktrees(knownPaths) {
    const out = [];
    if (!fs.existsSync(WT_ROOT)) return out;   // 从未用过 worktree 是常态，静默返回空（别在每次 GET 上刷日志）
    let ents;
    try { ents = fs.readdirSync(WT_ROOT, { withFileTypes: true }); }
    catch (e) { console.warn(`[workbench] 读 ${WT_ROOT} 失败，孤儿检出降级为空：${String(e?.message ?? e).slice(0, 120)}`); return out; }
    for (const e of ents) {
        if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
        const abs = path.join(WT_ROOT, e.name);
        if (knownPaths.has(path.resolve(abs).toLowerCase())) continue;
        out.push({ name: e.name, path: abs, git_registered: false, ...treeStats(abs) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerWorkbench(app, ctx) {
    const { db, RESTRICTED, dataDirOf } = ctx;

    /** git 执行（参数数组 + 30s 超时 + 16MB 缓冲；错误取 stderr 尾部回传，不泄堆栈） */
    function git(args, cwd = WORKSPACE) {
        return execFileAsync("git", args, {
            cwd, windowsHide: true, shell: false, timeout: 30000,
            maxBuffer: 16 * 1024 * 1024, encoding: "utf8",
        });
    }
    const gitErrTail = (e) => String(e?.stderr || e?.message || "").trim().slice(-300) || "git 执行失败";

    /** 解析 `git worktree list --porcelain`；回填卡片关联（cards.workspace_kind='worktree'） */
    async function listWorktrees() {
        const { stdout } = await git(["worktree", "list", "--porcelain"]);
        const items = [];
        let cur = null;
        for (const line of stdout.split(/\r?\n/)) {
            if (line.startsWith("worktree ")) {
                const p = line.slice(9).trim();
                cur = { path: p, name: path.basename(p), main: false, head: null, branch: null, detached: false, bare: false, cardId: null };
                items.push(cur);
            }
            else if (!cur) { /* worktree 块之前的杂行忽略 */ }
            else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
            else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
            else if (line === "detached") cur.detached = true;
            else if (line === "bare") cur.bare = true;
        }
        // 主工作区判定：路径与工作区根一致（不依赖 porcelain 输出顺序）
        const wsNorm = path.resolve(WORKSPACE).toLowerCase();
        for (const it of items) it.main = path.resolve(it.path).toLowerCase() === wsNorm;
        // 卡片关联（workspace 绝对路径 → cardId）
        try {
            const rows = db.prepare(`SELECT id, workspace FROM cards WHERE workspace_kind='worktree' AND workspace IS NOT NULL`).all();
            const byWs = new Map(rows.map((r) => [path.resolve(String(r.workspace)).toLowerCase(), Number(r.id)]));
            for (const it of items) it.cardId = byWs.get(path.resolve(it.path).toLowerCase()) ?? null;
        }
        catch { /* 卡片表异常不影响 worktree 列表 */ }
        return items.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
    }

    const wtExists = (abs) => { try { return fs.statSync(abs).isDirectory(); } catch { return false; } };
    const cardExists = (id) => Boolean(db.prepare(`SELECT id FROM cards WHERE id=?`).get(id));

    // ══════════════════ ① worktree 编排 ══════════════════
    /** 列出全部 worktree（含主工作区）；policy = Orca 共享优先原则提示 */
    app.get("/api/worktrees", async (req, reply) => {
        try {
            const items = await listWorktrees();
            // ★ 批4：只读补 orphans[]（磁盘残留但 git 不认的孤儿）。**这里绝不做真 prune** ——
            //   snapshot:check 与 [gate:snapshot] 都 app.inject 本路由，读门一旦带写副作用，
            //   门禁跑一次就真改仓库状态（本轮实测：prune 会把注册表清掉而目录仍在）。
            const known = new Set(items.map((it) => path.resolve(it.path).toLowerCase()));
            return {
                ok: true,
                workspace: WORKSPACE,
                root: WT_ROOT,
                policy: "默认共享工作区；仅在并行任务真实冲突时创建隔离 worktree（Orca 原则 #4519），完成后及时清理",
                items,
                orphans: listOrphanWorktrees(known),
            };
        }
        catch (e) {
            return reply.code(502).send({ ok: false, error: `git worktree list 失败：${gitErrTail(e)}` });
        }
    });

    /** 创建隔离 worktree：POST {name, base?, cardId?} → 分支 wt/<name>，落 <workspace>/.worktrees/<name> */
    app.post("/api/worktrees", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = req.body ?? {};
        const name = String(b.name ?? "").trim();
        if (!NAME_RE.test(name))
            return reply.code(400).send({ ok: false, error: "非法名称：仅允许字母/数字/._-，首字符为字母数字，≤64 位" });
        if (name === path.basename(WORKSPACE))
            return reply.code(400).send({ ok: false, error: "与主工作区同名" });
        const base = b.base ? String(b.base) : "HEAD";
        if (!REF_RE.test(base))
            return reply.code(400).send({ ok: false, error: "非法 base：仅允许字母/数字/._-/，≤100 位" });
        let cardId = b.cardId == null || b.cardId === "" ? null : Number(b.cardId);
        if (cardId != null && (!Number.isFinite(cardId) || cardId <= 0))
            return reply.code(400).send({ ok: false, error: "非法 cardId" });
        if (cardId != null && !cardExists(cardId))
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const target = path.join(WT_ROOT, name);
        if (wtExists(target))
            return reply.code(409).send({ ok: false, error: "worktree 已存在" });
        try {
            fs.mkdirSync(WT_ROOT, { recursive: true });
            const branch = `wt/${name}`;
            await git(["worktree", "add", "-b", branch, target, base]);
            // 卡片关联：workspace/workspace_kind 语义列 + meta.worktree 快取（cardRowOf 原样透出）
            if (cardId != null) {
                const row = db.prepare(`SELECT meta FROM cards WHERE id=?`).get(cardId);
                let meta = {};
                try { meta = row?.meta ? JSON.parse(row.meta) : {}; } catch { meta = {}; }
                meta.worktree = name;
                db.prepare(`UPDATE cards SET workspace=?, workspace_kind='worktree', meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
                    .run(target, JSON.stringify(meta), cardId);
                db.prepare(`INSERT INTO card_comments(card_id, author, body) VALUES (?,?,?)`)
                    .run(cardId, "dispatcher", `[worktree] 已创建隔离工作区 \`${name}\`（分支 ${branch}）——仅并行冲突时需要；用完可用 DELETE /api/worktrees/${name} 清理（分支保留可回滚）`);
            }
            const items = await listWorktrees();
            return { ok: true, name, path: target, branch, base, cardId, items };
        }
        catch (e) {
            const tail = gitErrTail(e);
            console.error(`[workbench] 创建 worktree 失败（${name}）：${tail}`);
            if (/already exists/i.test(tail))
                return reply.code(409).send({ ok: false, error: `分支或目录已存在：${tail}` });
            return reply.code(502).send({ ok: false, error: `创建失败：${tail}` });
        }
    });

    /** 移除 worktree（?force=1 强制，用于脏工作区；分支一律保留 → 可回滚）。
     *  ★ 2026-10-05 批4：改成三段可验证，终结「孤儿双向死锁」与 Windows 句柄锁的假失败。
     *    ① 未注册（磁盘孤儿）→ 不再交给 git（必得 `not a working tree` → 502），直接 fs 降级；
     *    ② git 删除因句柄/权限失败（实测 `.worktrees/<名>/resources/app.asar` 被本机进程按文件名占住，
     *       `rm`/`mv`/`del`/`git worktree remove --force` 全报 Invalid argument）→ 补跑 `git worktree prune`
     *       并如实回 `pending_release`：**「git 生命周期已结束、盘待释放」是合法终态**，不再谎报成功也不再报 502；
     *    ③ 卡片解除关联改判据为「git 侧已不再登记」，**不再依赖目录删除成功** —— 原实现只在 try 成功路径里解联，
     *       于是删除失败时卡片永远指着已作废的 worktree（走查 W7c 红的真因），也会把 B1a 的 cwd 解析锁死。 */
    const LOCK_TAIL_RE = /invalid argument|device or resource busy|resource busy|permission denied|access is denied/i;
    app.delete("/api/worktrees/:name", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const name = String(req.params.name ?? "");
        if (!NAME_RE.test(name))
            return reply.code(400).send({ ok: false, error: "非法名称" });
        const abs = path.join(WT_ROOT, name);
        if (path.resolve(abs).toLowerCase() === path.resolve(WORKSPACE).toLowerCase())
            return reply.code(400).send({ ok: false, error: "拒绝移除主工作区" });
        if (!wtExists(abs))
            return reply.code(404).send({ ok: false, error: "worktree 不存在" });
        const force = String(req.query?.force ?? "") === "1";
        let items0;
        try { items0 = await listWorktrees(); }
        catch (e) { return reply.code(502).send({ ok: false, error: `git worktree list 失败：${gitErrTail(e)}` }); }
        const registered = items0.some((it) => path.resolve(it.path).toLowerCase() === path.resolve(abs).toLowerCase());
        let released = false, pruned = false, blocker = null;
        if (registered) {
            try {
                await git(["worktree", "remove", ...(force ? ["--force"] : []), abs]);
                released = true;
            }
            catch (e) {
                const tail = gitErrTail(e);
                console.error(`[workbench] 移除 worktree 失败（${name}）：${tail}`);
                if (/contains modified|untracked|dirty|would be lost/i.test(tail))
                    return reply.code(409).send({ ok: false, error: `工作区有未提交改动，拒绝移除（可用 ?force=1 强制）：${tail}` });
                blocker = tail;
                if (LOCK_TAIL_RE.test(tail)) {
                    try { await git(["worktree", "prune"]); pruned = true; }
                    catch (e2) { console.warn(`[workbench] 回收后 prune 失败（${name}）：${gitErrTail(e2)}`); }
                }
            }
        }
        else {
            // 孤儿：git 已不认，只能 fs 级降级（仍失败就如实报，不谎称已删）
            try {
                await fs.promises.rm(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
                released = true;
            }
            catch (e) { blocker = String(e?.message ?? e); console.warn(`[workbench] 孤儿目录 fs 回收失败（${name}）：${blocker.slice(0, 200)}`); }
            try { await git(["worktree", "prune"]); pruned = true; }
            catch (e2) { console.warn(`[workbench] 孤儿 prune 失败（${name}）：${gitErrTail(e2)}`); }
        }
        // 解联判据 = git 侧确实不再登记（比"删除成功"更准：git 是先摘注册、后删目录）
        let items;
        try { items = await listWorktrees(); }
        catch (e) { items = items0; console.warn(`[workbench] 回收后重取列表失败（${name}）：${gitErrTail(e)}`); }
        const stillRegistered = items.some((it) => path.resolve(it.path).toLowerCase() === path.resolve(abs).toLowerCase());
        if (!stillRegistered) {
            try {
                const rows = db.prepare(`SELECT id, meta FROM cards WHERE workspace_kind='worktree' AND workspace=?`).all(abs);
                for (const r of rows) {
                    let meta = {};
                    try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { meta = {}; }
                    delete meta.worktree;
                    db.prepare(`UPDATE cards SET workspace=NULL, workspace_kind='scratch', meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
                        .run(JSON.stringify(meta), r.id);
                }
            }
            catch (e) { console.error(`[workbench] 回收后解除卡片关联失败（${name}）：${String(e?.message ?? e).slice(0, 200)}`); /* 不阻断回收 */ }
        }
        const pending = stillRegistered || !released
            ? { path: abs, git_registered: stillRegistered, blocker: blocker ? String(blocker).slice(0, 200) : null, ...treeStats(abs) }
            : null;
        return { ok: true, name, force, released, pruned, orphan: !registered, pending_release: pending, items };
    });

    // ══════════════════ ② 变更清单 + diff ══════════════════
    /** GET /api/worktrees/:name/changes?file=&staged=1&base=<ref>
     *  → {branch, files[], diff, truncated}；默认比对工作区未暂存改动；staged=1 比对暂存区；base= 三-dot 比对 base...HEAD */
    app.get("/api/worktrees/:name/changes", async (req, reply) => {
        const name = String(req.params.name ?? "");
        if (!NAME_RE.test(name))
            return reply.code(400).send({ ok: false, error: "非法名称" });
        const abs = path.join(WT_ROOT, name);
        if (!wtExists(abs))
            return reply.code(404).send({ ok: false, error: "worktree 不存在" });
        const file = req.query?.file ? safeRelPath(req.query.file) : null;
        if (req.query?.file && !file)
            return reply.code(400).send({ ok: false, error: "非法 file 路径" });
        const staged = String(req.query?.staged ?? "") === "1";
        const base = req.query?.base ? String(req.query.base) : "";
        if (base && !REF_RE.test(base))
            return reply.code(400).send({ ok: false, error: "非法 base" });
        try {
            const { stdout: stOut } = await git(["status", "--porcelain"], abs);
            const files = [];
            for (const line of stOut.split(/\r?\n/)) {
                if (!line.trim()) continue;
                const xy = line.slice(0, 2);
                let p = line.slice(3);
                if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
                    const arrow = p.indexOf(" -> ");
                    if (arrow !== -1) p = p.slice(arrow + 4);
                }
                p = p.replace(/^"|"$/g, "");
                files.push({
                    path: p,
                    index: xy[0] === " " ? "" : xy[0],
                    worktree: xy[1] === " " ? "" : xy[1],
                    untracked: xy === "??",
                    conflicted: ["DD", "AA", "UU", "AU", "UA", "DU", "UD"].includes(xy),
                });
            }
            const dargs = ["diff", "--no-color", "--unified=3"];
            if (base) dargs.push(`${base}...HEAD`);
            else if (staged) dargs.push("--cached");
            if (file) dargs.push("--", file);
            const { stdout: dOut } = await git(dargs, abs);
            const buf = Buffer.from(dOut, "utf8");
            const truncated = buf.length > DIFF_MAX_BYTES;
            const diff = truncated ? buf.subarray(0, DIFF_MAX_BYTES).toString("utf8") : dOut;
            const { stdout: bOut } = await git(["rev-parse", "--abbrev-ref", "HEAD"], abs).catch(() => ({ stdout: "" }));
            return { ok: true, name, branch: bOut.trim() || null, mode: base ? "base" : staged ? "staged" : "worktree", files, diff, truncated, totalBytes: buf.length };
        }
        catch (e) {
            return reply.code(502).send({ ok: false, error: `读取变更失败：${gitErrTail(e)}` });
        }
    });

    // ══════════════════ ③ 卡片行级 diff 批注（复用 card_comments，零迁移） ══════════════════
    /** 批注编码：`[diff|<path>|<line>|<side>] <body>`（side 0=旧 1=新）；与普通评论同表同流，正文可读可 grep */
    const ANN_RE = /^\[diff\|([^|\]]+)\|(\d+)\|([01])\]\s+([\s\S]*)$/;
    const ANN_PREFIX = (p, l, s) => `[diff|${p}|${l}|${s}]`;

    /** POST /api/cards/:id/annotations {path, line, side, body, author?} → 落 card_comments + 行级元数据 */
    app.post("/api/cards/:id/annotations", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "非法 id" });
        if (!cardExists(id))
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const b = req.body ?? {};
        const p = safeRelPath(b.path);
        if (!p)
            return reply.code(400).send({ ok: false, error: "非法 path" });
        const line = Number(b.line);
        if (!Number.isInteger(line) || line < 1 || line > 1000000)
            return reply.code(400).send({ ok: false, error: "非法 line" });
        const side = Number(b.side);
        if (side !== 0 && side !== 1)
            return reply.code(400).send({ ok: false, error: "非法 side（0=旧 1=新）" });
        const text = String(b.body ?? "").trim();
        if (!text)
            return reply.code(400).send({ ok: false, error: "批注内容不能为空" });
        if (text.length > 2000)
            return reply.code(400).send({ ok: false, error: "批注过长（≤2000 字）" });
        const author = String(b.author ?? "").trim() || "human:dashboard";
        if (SECRET_PAT.test(text) && !author.startsWith("human"))
            return reply.code(403).send({ ok: false, error: "批注疑似含敏感信息，仅 human 可强制写入" });
        const body = `${ANN_PREFIX(p, line, side)} ${text}`;
        db.prepare(`INSERT INTO card_comments(card_id, author, body) VALUES (?,?,?)`).run(id, author, body);
        return { ok: true, id, annotation: { path: p, line, side, body: text, author } };
    });

    /** GET /api/cards/:id/annotations?path= → 解析该卡全部行级批注（普通评论走既有 /comments 端点） */
    app.get("/api/cards/:id/annotations", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "非法 id" });
        if (!cardExists(id))
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const filter = req.query?.path ? safeRelPath(req.query.path) : null;
        if (req.query?.path && !filter)
            return reply.code(400).send({ ok: false, error: "非法 path" });
        const rows = db.prepare(`SELECT id, author, body, created_at FROM card_comments WHERE card_id=? ORDER BY id ASC`).all(id);
        const annotations = [];
        for (const r of rows) {
            const m = ANN_RE.exec(String(r.body ?? ""));
            if (!m) continue;
            const item = { id: Number(r.id), author: r.author, created_at: r.created_at, path: m[1], line: Number(m[2]), side: Number(m[3]), body: m[4] };
            if (filter && item.path !== filter) continue;
            annotations.push(item);
        }
        return { ok: true, id, annotations };
    });

    // ══════════════════ ④ 拖拽文件上传（base64，零依赖，5MB 上限） ══════════════════
    /** POST /api/artifacts/upload {name, data, encoding?} → data/artifacts/<ts>-<safe>；GET /api/artifacts/:id 下载 */
    app.post("/api/artifacts/upload", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = req.body ?? {};
        const enc = b.encoding === "text" ? "text" : "base64";
        const raw = String(b.data ?? "");
        if (!raw)
            return reply.code(400).send({ ok: false, error: "内容为空" });
        let buf;
        if (enc === "text") {
            buf = Buffer.from(raw, "utf8");
        }
        else {
            const compact = raw.replace(/\s+/g, "");
            if (!/^[A-Za-z0-9+/=]*$/.test(compact))
                return reply.code(400).send({ ok: false, error: "非法 base64" });
            buf = Buffer.from(compact, "base64");
        }
        if (!buf.length)
            return reply.code(400).send({ ok: false, error: "解码后内容为空" });
        if (buf.length > UPLOAD_MAX)
            return reply.code(413).send({ ok: false, error: `超过上限 ${UPLOAD_MAX / 1024 / 1024}MB` });
        const name = sanitizeUploadName(b.name);
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes(".."))
            return reply.code(400).send({ ok: false, error: "非法文件名" });
        try {
            const dir = path.join(dataDirOf() || "", "artifacts");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
            return { ok: true, name, url: `/api/artifacts/${name}`, size: buf.length };
        }
        catch (e) {
            console.error(`[workbench] 上传落盘失败（${name}）：${String(e?.message ?? e).slice(0, 200)}`);
            return reply.code(500).send({ ok: false, error: `落盘失败：${String(e?.message ?? e).slice(0, 200)}` });
        }
    });
}
