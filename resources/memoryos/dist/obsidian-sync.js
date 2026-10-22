/**
 * MemoryOS — Obsidian 连接模块（obsidian-sync）
 * 双向同步：Obsidian vault（本地 Markdown）↔ 共享记忆库
 *
 * 读方向（import）：扫描 vault 内 .md 笔记 → 解析 frontmatter + 正文 → 增量写入 memories
 *   幂等基础：obsidian_sync 元表（note_path → note_hash + memory_id + mtime_ms）
 *   内容不变 → 跳过；内容变化 → 更新（content + type + embedding + FTS）；新增 → 写入（embed + 去重预检）
 * 写方向（export）：active 记忆 → Markdown 笔记（带溯源 frontmatter），写入 vault/MemoryOS 导出/
 *
 * 设计约束：本地优先、零新依赖（node:crypto / node:fs / node:path / node:sqlite 复用 db.js），
 * 不需要 Obsidian 插件或网络。vault 路径可直接指定，也可从 obsidian.json 自动探测。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, writeMemory, updateMemory, getVectorsOnProject, dedupeDecision, logUsage, upsertVector, } from "./db.js";
import { getEmbedder, embedMode } from "./embed.js";
/** 导出目录名（walk 时排除，防循环导入自身产物） */
export const EXPORT_DIR = "MemoryOS 导出";
/** 单条写入目录（Agent 写回 vault 的位置，同样排除防循环） */
export const WRITE_DIR = "MemoryOS 写入";
/** 需要跳过的目录（Obsidian 系统目录 + VCS + 自身产物） */
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", ".smart-env", "node_modules", EXPORT_DIR, WRITE_DIR]);
/** 单轮扫描文件数上限（超大 vault 保护） */
const MAX_FILES = Number(process.env.OBSIDIAN_MAX_FILES ?? 5000) || 5000;
/* ========== 元表（自建，不侵入 db.js SCHEMA） ========== */
/** 复合主键 (vault_root, note_path)：支持多 vault 独立增量同步，同名笔记互不串扰 */
const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS obsidian_sync (
  vault_root TEXT NOT NULL,
  note_path  TEXT NOT NULL,
  note_hash  TEXT NOT NULL,
  memory_id  INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (vault_root, note_path)
);
CREATE INDEX IF NOT EXISTS idx_obsidian_sync_mem ON obsidian_sync(memory_id);
`;
function ensureMetaTable(db) {
    db.exec(META_SCHEMA);
    // 旧版表（无 vault_root 列，单 vault 假设）→ 重建。正式库此前未建过该表，无需保留旧数据。
    const cols = db.prepare(`PRAGMA table_info(obsidian_sync)`).all();
    if (!cols.some((c) => c.name === "vault_root")) {
        db.exec(`DROP TABLE obsidian_sync; ${META_SCHEMA}`);
    }
}
/** 读取 Obsidian 配置（%APPDATA%/obsidian/obsidian.json）探测本机 vault 列表 */
export function detectVaults() {
    const cfg = path.join(os.homedir(), "AppData", "Roaming", "obsidian", "obsidian.json");
    try {
        if (!fs.existsSync(cfg))
            return [];
        const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
        if (!j.vaults)
            return [];
        const out = [];
        for (const v of Object.values(j.vaults)) {
            const p = v?.path;
            if (!p || !fs.existsSync(p))
                continue;
            out.push({ name: path.basename(p), path: p });
        }
        return out;
    }
    catch {
        return [];
    }
}
/** 递归收集 vault 内 .md 文件（排除系统目录/导出目录/隐藏文件），按路径排序保证稳定 */
export function walkMarkdown(vaultRoot, opts = {}) {
    const max = opts.maxFiles ?? MAX_FILES;
    const out = [];
    const stack = [vaultRoot];
    while (stack.length && out.length < max) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
                    stack.push(full);
            }
            else if (e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".")) {
                out.push(full);
            }
        }
    }
    return out.sort();
}
/** 轻量 frontmatter 解析（不引 YAML 依赖）：--- 块内 key: value 行 */
function parseFrontmatter(raw) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!m)
        return { fm: new Map(), body: raw.trim() };
    const fm = new Map();
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (kv)
            fm.set(kv[1].toLowerCase(), kv[2].trim());
    }
    return { fm, body: m[2].trim() };
}
function parseTags(raw) {
    if (!raw)
        return [];
    const s = raw.replace(/^\[|\]$/g, "").replace(/["']/g, "");
    return s
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, ""))
        .filter(Boolean);
}
/** frontmatter type → memories.type 映射（支持中文别名，未知值回落 experience） */
const TYPE_ALIAS = {
    decision: "decision",
    决策: "decision",
    pitfall: "pitfall",
    坑: "pitfall",
    convention: "convention",
    约定: "convention",
    experience: "experience",
    经验: "experience",
};
export function mapType(t) {
    const k = (t ?? "").trim().toLowerCase();
    return TYPE_ALIAS[k] ?? "experience";
}
/** 解析单个 .md 笔记：标题取 frontmatter title → 首个 # 标题 → 文件名（兼容 UTF-8 BOM） */
export function parseNote(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    }
    catch {
        return null;
    }
    raw = raw.replace(/^\uFEFF/, ""); // Windows 编辑器可能写 BOM，剥离后再解析 frontmatter
    const { fm, body } = parseFrontmatter(raw);
    const title = fm.get("title") ||
        (() => {
            const m = /^#\s+(.+)$/m.exec(body);
            return m ? m[1].trim() : path.basename(filePath, ".md");
        })();
    return {
        title,
        content: body || title,
        tags: parseTags(fm.get("tags")),
        type: mapType(fm.get("type")),
    };
}
/** 内容指纹（标题 + 正文），用于增量幂等 */
export function noteHash(note) {
    return crypto.createHash("sha256").update(`${note.title}\n${note.content}`, "utf8").digest("hex");
}
/**
 * 增量导入 vault 笔记到记忆库。
 * - 新增：embed → 库内去重预检（merge 命中则并入既有记忆；conflict 低置信入库并挂 conflict_with）→ writeMemory
 * - 变化：更新 content/type/embedding + 同步 FTS5 + 刷新 meta
 * - 不变：跳过
 * fake-embed 模式：不产出语义向量（避免假向量污染语义路），直接写入走词法检索。
 */
export async function importVault(db, embedder, opts) {
    const vaultRoot = path.resolve(opts.vaultPath);
    if (!fs.existsSync(vaultRoot) || !fs.statSync(vaultRoot).isDirectory()) {
        throw new Error(`vault 路径不存在或不是目录: ${vaultRoot}`);
    }
    const project = opts.project ?? path.basename(vaultRoot);
    const agent = opts.agent ?? "obsidian";
    const realEmbed = embedMode() !== "fake";
    const stats = { scanned: 0, added: 0, updated: 0, merged: 0, skipped: 0, failed: 0, project, dryRun: !!opts.dryRun };
    ensureMetaTable(db);
    const files = walkMarkdown(vaultRoot);
    const pend = [];
    for (const f of files) {
        stats.scanned++;
        let note;
        try {
            note = parseNote(f);
        }
        catch {
            stats.failed++;
            continue;
        }
        if (!note) {
            stats.failed++;
            continue;
        }
        const hash = noteHash(note);
        const st = fs.statSync(f);
        const rel = path.relative(vaultRoot, f);
        const existing = db
            .prepare(`SELECT note_hash AS hash, memory_id AS memoryId FROM obsidian_sync WHERE vault_root = ? AND note_path = ?`)
            .get(vaultRoot, rel);
        if (existing && existing.hash === hash) {
            stats.skipped++;
            continue;
        }
        pend.push({ file: rel, note, hash, mtimeMs: st.mtimeMs, existing: existing ?? null });
    }
    if (opts.dryRun) {
        stats.added = pend.filter((p) => !p.existing).length;
        stats.updated = pend.filter((p) => p.existing).length;
        return stats;
    }
    // 批量 embed（真实模式）；fake 模式不产出向量
    const texts = pend.map((p) => `${p.note.title}\n${p.note.content}`);
    const vecs = realEmbed && pend.length ? await embedder.embedTexts(texts) : [];
    // ★ 2026-10-15 向量带出处：按当前嵌入器实例自声明 model/dim（各嵌入器已实现 provenance()）
    const prov = embedder.provenance?.() ?? { model: "unknown", dim: 0 };
    for (let i = 0; i < pend.length; i++) {
        const p = pend[i];
        const emb = realEmbed && vecs.length ? vecs[i] : null;
        try {
            if (p.existing) {
                // 内容变化 → 更新既有记忆：复用统一 updateMemory（改 content/type + 同步 FTS + trim/空校验），语义向量单独列换代（updateMemory 不碰 embedding）
                updateMemory(db, p.existing.memoryId, { content: p.note.content, type: p.note.type });
                if (emb) {
                    // ★ P1-2.2：向量写入独立表（原为直接 UPDATE memories.embedding）
                    upsertVector(db, p.existing.memoryId, emb, prov);
                }
                db.prepare(`UPDATE obsidian_sync SET note_hash=?, mtime_ms=? WHERE vault_root=? AND note_path=?`).run(p.hash, p.mtimeMs, vaultRoot, p.file);
                stats.updated++;
                continue;
            }
            // 新增：库内去重预检（真实向量模式 → 语义去重）
            if (emb) {
                const existingVecs = getVectorsOnProject(db, project);
                const d = existingVecs.length ? dedupeDecision(existingVecs, emb, -1) : null;
                if (d?.action === "merge" && d.targetId) {

                    // 重复导入不构成独立验证，不增加置信度。
                    db.prepare(`INSERT OR REPLACE INTO obsidian_sync(vault_root, note_path, note_hash, memory_id, mtime_ms) VALUES (?,?,?,?,?)`).run(vaultRoot, p.file, p.hash, d.targetId, p.mtimeMs);
                    stats.merged++;
                    continue;
                }
                if (d?.action === "conflict" && d.targetId) {
                    const row = writeMemory(db, {
                        content: p.note.content,
                        type: p.note.type,
                        agent,
                        agent_fpath: vaultRoot,
                        project,
                        embedding: emb,
                        confidence: 0.5,
                        // ★ 2026-10-14（③）：笔记镜像属外部采集来源 —— 不进规则反思候选（见 rule-reflection.js）
                        source: "ingest",
                    });
                    db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(d.targetId, row.id);
                    db.prepare(`INSERT INTO obsidian_sync(vault_root, note_path, note_hash, memory_id, mtime_ms) VALUES (?,?,?,?,?)`).run(vaultRoot, p.file, p.hash, row.id, p.mtimeMs);
                    stats.added++;
                    continue;
                }
            }
            else {
                // fake-embed 降级：无向量不做语义去重 → 退回内容 hash 粗查（同 hash active 记忆视为重复，merge 而非裸放行；防 #39 降级裸灌）
                const dup = db
                    .prepare(`SELECT id FROM memories WHERE content = ? AND status = 'active' AND project IN (?, 'global') LIMIT 1`)
                    .get(p.note.content, project);
                if (dup) {

                    // 重复导入不构成独立验证，不增加置信度。
                    db.prepare(`INSERT OR REPLACE INTO obsidian_sync(vault_root, note_path, note_hash, memory_id, mtime_ms) VALUES (?,?,?,?,?)`).run(vaultRoot, p.file, p.hash, dup.id, p.mtimeMs);
                    stats.merged++;
                    continue;
                }
            }
            const row = writeMemory(db, {
                content: p.note.content,
                type: p.note.type,
                agent,
                agent_fpath: vaultRoot,
                project,
                embedding: emb ?? undefined,
                // ★ 2026-10-14（③）：同上，采集来源
                source: "ingest",
            });
            db.prepare(`INSERT OR REPLACE INTO obsidian_sync(vault_root, note_path, note_hash, memory_id, mtime_ms) VALUES (?,?,?,?,?)`).run(vaultRoot, p.file, p.hash, row.id, p.mtimeMs);
            logUsage(db, { memory_id: row.id, event: "write", reader_agent: agent, writer_agent: agent, project });
            stats.added++;
        }
        catch (e) {
            // 单条笔记失败不阻断整库导入，但必须留痕（导入是批量写，静默会掩盖系统性故障）
            console.error(`[obsidian] 导入笔记失败（${p.file}）: ${e instanceof Error ? e.message : String(e)}`);
            stats.failed++;
        }
    }
    // ★ P2：导入落库后重建 notes 镜像 + links 图（幂等；多 vault 域内隔离）
    try {
        const idx = syncNotesIndex(db, vaultRoot);
        stats.index = idx;
    }
    catch (e) {
        console.error(`[obsidian-sync] notes/links 索引失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return stats;
}
/* ========== ★ P2 wikilink 解析 + notes/links 统一图（M12 vault 域隔离） ========== */
/** wikilink 全集：![[嵌入]] / [[目标]] / [[目标#锚点]] / [[目标|别名]] / [[目标#^blockid]] */
const WIKILINK_RE = /!?\[\[([^\]|#^]+)(?:#(\^?[^\]|]+))?(?:\|([^\]]+))?\]\]/g;
/** 解析正文全部 wikilink（重置 lastIndex，保证多次调用无状态残留） */
export function parseLinks(body) {
    WIKILINK_RE.lastIndex = 0;
    const out = [];
    for (const m of body.matchAll(WIKILINK_RE)) {
        const full = m[0];
        const target = (m[1] ?? "").trim();
        if (!target)
            continue;
        const anchor = (m[2] ?? "").trim() || null;
        const alias = (m[3] ?? "").trim() || null;
        const lineStart = body.lastIndexOf("\n", Math.max(0, m.index)) + 1;
        const lineEnd = body.indexOf("\n", m.index);
        const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim();
        out.push({ target, anchor, alias, embed: full.startsWith("!"), context: line.slice(0, 160) });
    }
    return out;
}
/** 目标是否为 .md 笔记（扩展名可省略）；带非 .md 扩展名（图片/附件等）→ asset，跳过建边（R4-8） */
function isNoteTarget(t) {
    if (t.includes(".") && !/\.md$/i.test(t.trim()))
        return false;
    return true;
}
/** vault 域内 title/alias → note_id 索引（大小写不敏感；同名取先到者） */
function buildTitleIndex(db, vaultRoot) {
    const map = new Map();
    const rows = db
        .prepare(`SELECT id, title, aliases FROM notes WHERE vault_root = ?`)
        .all(vaultRoot);
    const put = (k, id) => {
        const key = k.trim().toLowerCase();
        if (key && !map.has(key))
            map.set(key, id);
    };
    for (const r of rows) {
        put(r.title, r.id);
        if (r.aliases) {
            try {
                for (const a of JSON.parse(r.aliases))
                    put(a, r.id);
            }
            catch {
                /* 坏 JSON 忽略 */
            }
        }
    }
    return map;
}
const INS_LINK = `INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,dst_title,kind,anchor,alias,context)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`;
/** 单笔记增量重建 links（R3-3：先删该笔记全部链接再插；未解析 → dst_id=NULL + dst_title 保留；
 *  R6-2：DELETE+INSERT 包单事务，防高频保存时半写坏状态） */
function buildLinksForNote(db, vaultRoot, noteId, body) {
    const titleIndex = buildTitleIndex(db, vaultRoot);
    const ins = db.prepare(INS_LINK);
    let links = 0;
    let unresolved = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
        db.prepare(`DELETE FROM links WHERE src_kind='note' AND src_id=?`).run(noteId);
        for (const l of parseLinks(body)) {
            if (!isNoteTarget(l.target))
                continue;
            const dstId = titleIndex.get(l.target.toLowerCase());
            ins.run(vaultRoot, "note", noteId, "note", dstId ?? null, dstId ? null : l.target, l.embed ? "embed" : "wikilink", l.anchor, l.alias, l.context);
            links++;
            if (!dstId)
                unresolved++;
        }
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    return { links, unresolved };
}
/**
 * 全量重建 vault 的 notes 镜像 + links 图（幂等、可重复跑）。
 * 每篇笔记：① upsert notes 镜像（title/aliases/tags/body/hash/memory_id/mtime，origin='vault'）
 *           ② 按笔记粒度增量重建 links（先删后插）。
 * M12：全部解析与索引均限定 `vault_root=?`，多 vault 同名笔记互不串扰。
 */
export function syncNotesIndex(db, vaultRoot) {
    const root = path.resolve(vaultRoot);
    ensureMetaTable(db);
    const files = walkMarkdown(root);
    const stats = { notes: 0, links: 0, unresolved: 0 };
    if (!files.length)
        return stats;
    const upsert = db.prepare(`INSERT INTO notes(vault_root, rel_path, title, aliases, tags, sector, body, hash, memory_id, mtime_ms, origin, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'vault', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(vault_root, rel_path) DO UPDATE SET
       title=excluded.title, aliases=excluded.aliases, tags=excluded.tags, sector=excluded.sector,
       body=excluded.body, hash=excluded.hash, memory_id=excluded.memory_id,
       mtime_ms=excluded.mtime_ms, updated_at=excluded.updated_at`);
    const qMem = db.prepare(`SELECT memory_id FROM obsidian_sync WHERE vault_root=? AND note_path=?`);
    const qId = db.prepare(`SELECT id FROM notes WHERE vault_root=? AND rel_path=?`);
    // 1) 收集笔记（避免对同一文件重复 parse）
    const parsed = new Map();
    const noteIds = new Map();
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join("/");
        const note = parseNote(f);
        if (!note)
            continue;
        parsed.set(rel, note);
        const st = fs.statSync(f);
        const mem = qMem.get(root, rel);
        upsert.run(root, rel, note.title, "[]", JSON.stringify(note.tags), null, note.content, noteHash(note), mem?.memory_id ?? null, st.mtimeMs);
        const got = qId.get(root, rel);
        if (got)
            noteIds.set(rel, got.id);
    }
    stats.notes = noteIds.size;
    // 2) 每篇笔记增量重建 links
    for (const [rel, note] of parsed) {
        const noteId = noteIds.get(rel);
        if (!noteId)
            continue;
        const r = buildLinksForNote(db, root, noteId, note.content);
        stats.links += r.links;
        stats.unresolved += r.unresolved;
    }
    return stats;
}
/**
 * M5 未解析链接回填：新建笔记后，把该 vault 内指向此标题（含大小写归一）的未解析链接补上 dst_id。
 * 删除笔记则相反（退化为未解析）：见 dropNoteIndex。
 */
export function resolveUnresolvedLinks(db, vaultRoot, title, noteId) {
    const info = db
        .prepare(`UPDATE links SET dst_id=?, dst_title=NULL
       WHERE src_kind='note' AND dst_kind='note' AND dst_id IS NULL
         AND vault_root=? AND lower(dst_title)=lower(?)`)
        .run(noteId, vaultRoot, title);
    return Number(info.changes);
}
/** M5 删除笔记：把指向该笔记的已解析链接退化为未解析（dst_id=NULL + dst_title 保留），不删边（Obsidian 语义） */
export function demoteNoteLinks(db, noteId) {
    const info = db
        .prepare(`UPDATE links SET dst_id=NULL, dst_title=COALESCE(dst_title, (SELECT title FROM notes WHERE id=dst_id))
       WHERE dst_kind='note' AND dst_id=?`)
        .run(noteId);
    return Number(info.changes);
}
/** R5-6：source_ref 导出清洗 —— 仅保留 文件名+行号，去绝对路径（防本机路径泄露进 vault） */
function cleanSourceRef(ref) {
    if (!ref)
        return null;
    const m = /([^\\/:*?"<>|]+(?::\d+)?)$/.exec(ref.trim());
    return m ? m[1] : ref.trim().slice(0, 120);
}
function frontmatter(r) {
    const lines = [
        "---",
        `id: ${r.id}`,
        `type: ${r.type}`,
        `agent: ${r.agent}`,
        `project: ${r.project}`,
        `confidence: ${r.confidence.toFixed(2)}`,
        `status: ${r.status}`,
        `created_at: ${r.created_at}`,
    ];
    if (r.sector)
        lines.push(`sector: ${r.sector}`);
    if (r.salience != null)
        lines.push(`salience: ${r.salience}`);
    if (r.valid_until)
        lines.push(`valid_until: ${r.valid_until}`);
    const src = cleanSourceRef(r.source_ref);
    if (src)
        lines.push(`source_ref: ${src}`);
    lines.push("source: memoryos", "---");
    return lines.join("\n");
}
function slugOf(content) {
    const s = content
        .replace(/[\r\n]+/g, " ")
        .replace(/[\\/:*?"<>|#]+/g, "")
        .trim()
        .slice(0, 24);
    return s || "untitled";
}
/** 把 active 记忆导出为 Markdown 笔记（幂等：同 id 文件已存在则跳过）。outDir 缺省 = <vault>/MemoryOS 导出 */
export function exportMemories(db, opts = {}) {
    const outDir = path.resolve(opts.outDir ?? (opts.vaultPath ? path.join(opts.vaultPath, EXPORT_DIR) : EXPORT_DIR));
    fs.mkdirSync(outDir, { recursive: true });
    const where = ["status='active'"];
    const params = [];
    if (opts.project) {
        where.push("project=?");
        params.push(opts.project);
    }
    if (opts.type) {
        where.push("type=?");
        params.push(opts.type);
    }
    // ★ H4（R4 裁决）：secret 记忆不出本机 —— 导出通道一律静默跳过（计数留痕，前端展示"已跳过 N 条私密"）
    where.push(`sensitivity != 'secret'`);
    let sql = `SELECT id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence, conflict_with, superseded_by, derived_from, hit_count, last_hit_at, created_at, sector, salience, valid_until, source_ref, sensitivity FROM memories WHERE ${where.join(" AND ")} ORDER BY id`;
    if (opts.limit && opts.limit > 0)
        sql += ` LIMIT ${Math.floor(opts.limit)}`;
    const rows = db.prepare(sql).all(...params);
    // H4：统计被静默跳过的 secret 数量（同一 SQL 不带过滤跑一次计数）
    const secretCount = Number(db
        .prepare(`SELECT COUNT(*) AS c FROM memories WHERE status='active' AND sensitivity='secret'${opts.project ? " AND project=?" : ""}`)
        .get(...(opts.project ? [opts.project] : [])).c);
    const stats = { written: 0, skipped: 0, failed: 0, dir: outDir };
    stats.skipped += secretCount; // 计入 skipped，前端可读"已跳过 N 条（含私密）"
    for (const r of rows) {
        const file = path.join(outDir, `#${r.id}-${slugOf(r.content)}.md`);
        try {
            if (fs.existsSync(file)) {
                stats.skipped++;
                continue;
            }
            fs.writeFileSync(file, `${frontmatter(r)}\n\n${r.content}\n`, "utf8");
            stats.written++;
        }
        catch (e) {
            console.error(`[obsidian] 导出写文件失败（${file}）: ${e instanceof Error ? e.message : String(e)}`);
            stats.failed++;
        }
    }
    return stats;
}
/**
 * Agent 往 Obsidian vault 写单条笔记：创建 .md 文件（带溯源 frontmatter），
 * 同时同步写入 memories 表（去重预检 + 埋点），并记录 obsidian_sync 元表映射。
 * 文件已存在时加时间戳后缀，绝不覆盖。
 */
/**
 * ★ 2026-09-15：folder 参数消毒（防路径穿越，P-4170）。
 * folder 来自 MCP 工具/HTTP 入参，原本未消毒直接 path.join(vaultRoot, folder)，
 * 任意 `..` / 绝对路径 / 盘符 / UNC 可把 .md 写到 vault 之外。
 * 规则：清洗每段为安全目录名（仿 title 的非法字符过滤），禁止 `..`、空段、绝对路径、
 * 盘符（C:/）与 UNC（\\），最终解析后必须仍落在 vaultRoot 内（由调用方断言）。
 */
export function sanitizeFolder(folder) {
    const raw = String(folder ?? "").trim();
    if (!raw)
        return "Inbox";
    // 绝对路径 / 盘符 / UNC / 根斜杠 —— 一律拒绝（不静默清洗）
    if (/^[A-Za-z]:[\\/]/.test(raw))
        throw new Error(`非法 folder 路径（盘符绝对）: ${folder}`);
    if (/^\\\\/.test(raw))
        throw new Error(`非法 folder 路径（UNC）: ${folder}`);
    if (/^[/]/.test(raw))
        throw new Error(`非法 folder 路径（根绝对）: ${folder}`);
    // 穿越段：任何 .. 段都拒绝（不丢弃，直接报错）
    const segments = raw.split(/[\\/]+/).map((s) => s.replace(/[\\/:*?"<>|#]+/g, "_").trim());
    if (segments.some((s) => s === ".."))
        throw new Error(`非法 folder 路径（含 .. 穿越）: ${folder}`);
    const clean = segments.filter((s) => s && s !== ".");
    if (!clean.length)
        throw new Error(`非法 folder 路径（空）: ${folder}`);
    return clean.join("/");
}
export async function writeNoteToVault(db, embedder, opts) {
    const vaultRoot = path.resolve(opts.vaultPath);
    if (!fs.existsSync(vaultRoot) || !fs.statSync(vaultRoot).isDirectory()) {
        throw new Error(`vault 路径不存在或不是目录: ${vaultRoot}`);
    }
    ensureMetaTable(db);
    const type = mapType(opts.type);
    const project = opts.project ?? "global";
    const folder = sanitizeFolder(opts.folder ?? WRITE_DIR);
    const agent = opts.agent;
    const agent_fpath = opts.agent_fpath ?? null;
    // 文件名：清洗 title 非法字符
    const safeTitle = opts.title.replace(/[\\/:*?"<>|#]+/g, "_").trim().slice(0, 80) || "untitled";
    const dir = path.join(vaultRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    let fileName = `${safeTitle}.md`;
    let filePath = path.join(dir, fileName);
    let created = true;
    if (fs.existsSync(filePath)) {
        // 已存在 → 加时间戳后缀，绝不覆盖
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        fileName = `${safeTitle}-${ts}.md`;
        filePath = path.join(dir, fileName);
        created = false;
    }
    // ★ 2026-09-15：纵深防御——最终路径必须仍落在 vaultRoot 内（folder 消毒后的兜底断言）
    if (!filePath.startsWith(vaultRoot + path.sep) && filePath !== vaultRoot) {
        throw new Error(`拒绝写入 vault 之外: ${filePath}`);
    }
    // 生成 frontmatter + 写文件
    const now = new Date().toISOString();
    const fm = [
        "---",
        `title: ${opts.title}`,
        `type: ${type}`,
        `agent: ${agent}`,
        `project: ${project}`,
        `created_at: ${now}`,
        "source: memoryos",
        "---",
    ].join("\n");
    fs.writeFileSync(filePath, `${fm}\n\n${opts.content}\n`, "utf8");
    // 同步写记忆库（embed + 去重预检）
    let memoryId = null;
    const realEmbed = embedMode() !== "fake";
    const emb = realEmbed ? (await embedder.embedTexts([opts.content]))[0] : null;
    if (emb) {
        const existing = getVectorsOnProject(db, project);
        const d = existing.length ? dedupeDecision(existing, emb, -1) : null;
        if (d?.action === "merge" && d.targetId) {

                    // 重复导入不构成独立验证，不增加置信度。
            memoryId = d.targetId;
        }
    }
    if (memoryId === null) {
        const row = writeMemory(db, {
            content: opts.content,
            type,
            agent,
            agent_fpath,
            project,
            embedding: emb ?? undefined,
            // ★ 2026-10-14（③）：同上，采集来源
            source: "ingest",
        });
        memoryId = row.id;
        logUsage(db, { memory_id: row.id, event: "write", reader_agent: agent, writer_agent: agent, project });
    }
    // 记录 obsidian_sync 元表（建立笔记→记忆映射，后续增量同步可识别）
    const notePath = path.relative(vaultRoot, filePath);
    const hash = crypto.createHash("sha256").update(`${opts.title}\n${opts.content}`, "utf8").digest("hex");
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    db.prepare(`INSERT OR REPLACE INTO obsidian_sync(vault_root, note_path, note_hash, memory_id, mtime_ms) VALUES (?,?,?,?,?)`).run(vaultRoot, notePath, hash, memoryId, mtimeMs);
    // ★ P2：同步 notes 镜像 + links 图 + M5 未解析回填
    try {
        db.prepare(`INSERT INTO notes(vault_root, rel_path, title, aliases, tags, sector, body, hash, memory_id, mtime_ms, origin, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'user', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(vault_root, rel_path) DO UPDATE SET
         title=excluded.title, body=excluded.body, hash=excluded.hash, memory_id=excluded.memory_id,
         mtime_ms=excluded.mtime_ms, updated_at=excluded.updated_at`).run(vaultRoot, notePath, opts.title, "[]", "[]", null, opts.content, hash, memoryId, mtimeMs);
        const noteRow = db.prepare(`SELECT id FROM notes WHERE vault_root=? AND rel_path=?`).get(vaultRoot, notePath);
        if (noteRow) {
            buildLinksForNote(db, vaultRoot, noteRow.id, opts.content);
            resolveUnresolvedLinks(db, vaultRoot, opts.title, noteRow.id);
        }
    }
    catch (e) {
        console.error(`[obsidian-sync] 笔记索引同步失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { file: filePath, notePath, memoryId, created };
}
export function vaultStatus(db, vaultPath) {
    const vaultRoot = path.resolve(vaultPath);
    ensureMetaTable(db);
    const files = walkMarkdown(vaultRoot);
    const imported = Number(db.prepare(`SELECT COUNT(*) AS c FROM obsidian_sync WHERE vault_root=?`).get(vaultRoot).c);
    const memoriesFromObsidian = Number(db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE agent='obsidian'`).get().c);
    return {
        vaultName: path.basename(vaultRoot),
        noteFiles: files.length,
        imported,
        pending: Math.max(0, files.length - imported),
        memoriesFromObsidian,
    };
}
/* ========== CLI ========== */
function arg(flag, argv = process.argv.slice(2)) {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}
function has(flag, argv = process.argv.slice(2)) {
    return argv.includes(flag);
}
function help() {
    return [
        "MemoryOS Obsidian 同步 CLI",
        "用法: node dist/obsidian-sync.js <command> [options]",
        "",
        "命令:",
        "  list-vaults            探测本机 Obsidian vault 列表",
        "  status                 显示 vault 与导入统计",
        "  import                 把 vault 笔记增量导入记忆库",
        "  index                  重建 notes 镜像 + wikilink 链接图（幂等）",
        "  export                 把 active 记忆导出为 Markdown 笔记（默认写入 vault/MemoryOS 导出）",
        "",
        "选项:",
        "  --vault <path>   vault 绝对路径（缺省时若本机仅一个 vault 自动使用）",
        "  --db <path>      记忆库路径（默认 memoryos/data/memory.db）",
        "  --project <name> project scope（导入默认取 vault 目录名；导出默认不过滤）",
        "  --dry-run        只统计不落库（import）",
        "  --limit <n>      导出条数上限",
        "  --type <t>       导出类型过滤（decision/experience/pitfall/convention）",
        "  --out <dir>      导出目录（默认 vault/MemoryOS 导出）",
    ].join("\n");
}
async function main() {
    const [cmd] = process.argv.slice(2);
    const dbPath = arg("--db") ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));
    const vaultPath = arg("--vault");
    if (!cmd || cmd === "help" || cmd === "--help") {
        console.log(help());
        return;
    }
    if (cmd === "list-vaults") {
        const vaults = detectVaults();
        if (!vaults.length) {
            console.log("未探测到 Obsidian vault（未安装 Obsidian 或未打开过仓库）。可用 --vault <path> 直接指定。");
            return;
        }
        for (const v of vaults)
            console.log(`${v.name}\t${v.path}`);
        return;
    }
    const db = openDb(dbPath);
    try {
        if (cmd === "status") {
            if (!vaultPath)
                throw new Error("status 需要 --vault <path>");
            const s = vaultStatus(db, vaultPath);
            console.log(`vault: ${s.vaultName}`);
            console.log(`笔记文件: ${s.noteFiles}`);
            console.log(`已导入: ${s.imported}`);
            console.log(`待导入: ${s.pending}`);
            console.log(`记忆库中 agent=obsidian 的记忆: ${s.memoriesFromObsidian}`);
            return;
        }
        if (cmd === "import") {
            if (!vaultPath)
                throw new Error("import 需要 --vault <path>");
            const embedder = await getEmbedder();
            const stats = await importVault(db, embedder, {
                vaultPath,
                project: arg("--project"),
                dryRun: has("--dry-run"),
            });
            console.log(`扫描 ${stats.scanned} 个笔记 → 新增 ${stats.added} / 更新 ${stats.updated} / 去重合并 ${stats.merged} / 跳过 ${stats.skipped} / 失败 ${stats.failed}（project=${stats.project}${stats.dryRun ? "，dry-run 未落库" : ""}）`);
            return;
        }
        if (cmd === "index") {
            if (!vaultPath)
                throw new Error("index 需要 --vault <path>");
            const s = syncNotesIndex(db, vaultPath);
            console.log(`索引重建完成：笔记 ${s.notes} / 链接 ${s.links} / 未解析 ${s.unresolved}`);
            return;
        }
        if (cmd === "export") {
            const stats = exportMemories(db, {
                vaultPath,
                project: arg("--project"),
                type: arg("--type"),
                limit: arg("--limit") ? Number(arg("--limit")) : undefined,
                outDir: arg("--out"),
            });
            console.log(`导出到 ${stats.dir}：写入 ${stats.written} / 跳过(已存在) ${stats.skipped} / 失败 ${stats.failed}`);
            return;
        }
        console.log(`未知命令: ${cmd}\n`);
        console.log(help());
    }
    finally {
        db.close();
    }
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main().catch((e) => {
        console.error(`[obsidian-sync] ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
}
