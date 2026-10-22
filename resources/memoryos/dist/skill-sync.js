#!/usr/bin/env node
/**
 * skill-sync.js — 技能中央库 + 一键分发（MemoryOS 功能模块）
 *
 * 中央库：<项目根>/skills/<技能名>/SKILL.md
 * 分发目标（默认映射）：
 *   - 豆包 Doubao   → %LOCALAPPDATA%\Doubao\User Data\Default\.doubao\agent_mode\workspace\.user_skills
 *   - Codex         → ~\.codex\skills
 *   - Claude Code   → ~\.claude\skills
 *   （TRAE 目前只有内置技能目录 builtin_skills，无用户自定义技能机制，暂不纳入）
 *
 * 命令：
 *   node dist/skill-sync.js status                 # 查看中央库 + 各目标状态
 *   node dist/skill-sync.js sync                   # 分发中央库技能到所有目标
 *   node dist/skill-sync.js sync --dry-run         # 预演，不落盘
 *   node dist/skill-sync.js adopt --from <dir>     # 把已有技能收编进中央库
 *   node dist/skill-sync.js adopt --from <dir> --dry-run
 *
 * 环境变量（测试/自定义用）：
 *   SKILL_CENTRAL=...           覆盖中央库路径
 *   SKILL_TARGETS="name1|dir1;name2|dir2"   覆盖目标映射
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scanAgents } from "./scan.js";
const CENTRAL_DIR = process.env.SKILL_CENTRAL
    ? path.resolve(process.env.SKILL_CENTRAL)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");
function doubaoUserSkillsDir() {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Doubao", "User Data", "Default", ".doubao", "agent_mode", "workspace", ".user_skills");
}
const DEFAULT_TARGETS = [
    { name: "豆包 Doubao", dir: doubaoUserSkillsDir() },
    { name: "Codex", dir: path.join(os.homedir(), ".codex", "skills") },
    { name: "Claude Code", dir: path.join(os.homedir(), ".claude", "skills") },
];
/** 支持 SKILL_TARGETS="name1|dir1;name2|dir2" 覆盖目标映射（测试用） */
function resolveTargets() {
    const env = process.env.SKILL_TARGETS;
    if (!env)
        return DEFAULT_TARGETS;
    return env
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
        const i = s.indexOf("|");
        if (i < 0)
            throw new Error(`SKILL_TARGETS 格式应为 name|dir;name|dir，收到: ${s}`);
        return { name: s.slice(0, i).trim(), dir: path.resolve(s.slice(i + 1).trim()) };
    });
}
const TARGETS = resolveTargets();
const AGENT_SKILL_PROFILES = {
    codex: { name: "OpenAI Codex CLI", skillsDir: path.join(os.homedir(), ".codex", "skills") },
    claude: { name: "Claude Code", skillsDir: path.join(os.homedir(), ".claude", "skills") },
    doubao: { name: "豆包 Doubao", skillsDir: doubaoUserSkillsDir() },
    aider: { name: "Aider", skillsDir: null, note: "无本地 skills 目录机制" },
    gemini: { name: "Gemini CLI", skillsDir: null, note: "无本地 skills 目录机制" },
    glm: { name: "智谱 GLM CLI", skillsDir: null, note: "无本地 skills 目录机制" },
    qwen: { name: "Qwen Code", skillsDir: null, note: "无本地 skills 目录机制" },
    openrouter: { name: "OpenRouter", skillsDir: null, note: "无本地 skills 目录机制" },
    zcode: { name: "ZCode", skillsDir: null, note: "IDE 基于 extensions，无 skills 目录" },
    workbuddy: { name: "WorkBuddy", skillsDir: path.join(os.homedir(), ".workbuddy", "skills") },
    "workbuddy-ai": { name: "WorkBuddy AI", skillsDir: path.join(os.homedir(), ".workbuddy-ai", "skills") },
    traecode: { name: "TraeCode CN", skillsDir: null, note: "IDE 基于 extensions，无 skills 目录" },
    traework: { name: "TraeWork CN", skillsDir: null, note: "IDE 基于 extensions，无 skills 目录" },
    zhipu: { name: "智谱清言", skillsDir: null, note: "客户端无 skills 目录机制" },
    codexpp: { name: "Codex++", skillsDir: null, note: "待确认是否共享 ~/.codex/skills" },
    minimax: { name: "MiniMax Code", skillsDir: null, note: "IDE 基于 extensions，无 skills 目录" },
};
/**
 * 扫描本机所有 Agent（与「工具连接」页同源），返回技能分发视角的检测结果。
 * 豆包不在 scan.js 列表中（无标准 exe 探测），在此按 skills 目录存在性追加。
 */
export function detectSkillTargets() {
    return detectedFromScan(scanAgents().agents ?? []);
}
/** 从 scans 结果构造 detected（无 spawnSync 副作用）：detectSkillTargets 的纯映射部分，
 *  ★ 2026-10-15 抽出——skills/status 的 worker 化链路改为复用 scan.js 共享扫描结果，
 *  避免 worker 内再跑一份 spawnSync 探测（探测 burst 会拖慢主线程 socket 传输）。 */
export function detectedFromScan(agents) {
    const existingDirs = new Set(TARGETS.map((t) => path.resolve(t.dir)));
    const result = (agents ?? []).map((a) => {
        const profile = AGENT_SKILL_PROFILES[a.id];
        const skillsDir = profile?.skillsDir ?? null;
        return {
            id: a.id,
            name: a.name,
            type: a.type,
            connected: a.connected,
            supported: !!skillsDir,
            skillsDir,
            note: profile?.note,
            alreadyTarget: skillsDir ? existingDirs.has(path.resolve(skillsDir)) : false,
        };
    });
    // 追加豆包（scan.js 不探测豆包 exe，按 skills 目录存在性判断）
    const doubaoDir = doubaoUserSkillsDir();
    if (fs.existsSync(doubaoDir)) {
        result.push({
            id: "doubao",
            name: "豆包 Doubao",
            type: "桌面客户端",
            connected: true, // 豆包正在运行本 Dashboard，视为已连接
            supported: true,
            skillsDir: doubaoDir,
            alreadyTarget: existingDirs.has(path.resolve(doubaoDir)),
        });
    }
    return result;
}
/**
 * 全部分发目标 = 手动目标（DEFAULT_TARGETS / SKILL_TARGETS 环境变量）
 *             ∪ 自动检测目标（已连接 MCP + 支持 skills 目录 + 未重复）
 */
function allTargets() {
    const seen = new Set(TARGETS.map((t) => path.resolve(t.dir)));
    const result = [...TARGETS];
    for (const a of detectSkillTargets()) {
        if (!a.supported || !a.connected || !a.skillsDir)
            continue;
        const dir = path.resolve(a.skillsDir);
        if (seen.has(dir))
            continue;
        seen.add(dir);
        result.push({ name: a.name, dir });
    }
    return result;
}
/* ========== 基础工具 ========== */
export function isSkill(dir) {
    try {
        return fs.existsSync(path.join(dir, "SKILL.md"));
    }
    catch {
        return false;
    }
}
export function listSkills(root) {
    if (!fs.existsSync(root))
        return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.includes(".bak-") && isSkill(path.join(root, e.name)))
        .map((e) => e.name)
        .sort();
}
/** 目录指纹：递归所有文件（排除 .bak-* 备份）的相对路径 + sha256，汇总后再 hash */
export function dirFingerprint(dir) {
    const entries = [];
    const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.includes(".bak-"))
                continue;
            const full = path.join(d, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(full, r);
            else {
                const h = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
                entries.push(`${r}:${h}`);
            }
        }
    };
    if (!fs.existsSync(dir))
        return "";
    walk(dir, "");
    return crypto.createHash("sha256").update(entries.sort().join("|")).digest("hex");
}
/** 递归复制目录（Node 22 Windows 上 fs.cpSync 有原生崩溃 bug，改用自实现） */
function copySkill(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory())
            copySkill(s, d);
        else
            fs.copyFileSync(s, d);
    }
}
export function computeStatus() {
    const central = listSkills(CENTRAL_DIR);
    const targets = allTargets().map((t) => {
        const skills = listSkills(t.dir);
        const missing = [];
        const outdated = [];
        const upToDate = [];
        for (const name of central) {
            if (!skills.includes(name)) {
                missing.push(name);
            }
            else if (dirFingerprint(path.join(t.dir, name)) === dirFingerprint(path.join(CENTRAL_DIR, name))) {
                upToDate.push(name);
            }
            else {
                outdated.push(name);
            }
        }
        return { name: t.name, dir: t.dir, exists: fs.existsSync(t.dir), skills, missing, outdated, upToDate };
    });
    return { central, centralDir: CENTRAL_DIR, targets };
}
export function syncSkills(dryRun) {
    const { central } = computeStatus();
    const results = [];
    for (const t of allTargets()) {
        const res = { target: t.name, added: [], updated: [], skipped: [], backedUp: [] };
        if (!central.length) {
            results.push(res);
            continue;
        }
        if (!dryRun)
            fs.mkdirSync(t.dir, { recursive: true }); // dry-run 不创建任何目录
        for (const name of central) {
            const src = path.join(CENTRAL_DIR, name);
            const dest = path.join(t.dir, name);
            if (!fs.existsSync(dest)) {
                if (!dryRun)
                    copySkill(src, dest);
                res.added.push(name);
            }
            else if (dirFingerprint(dest) === dirFingerprint(src)) {
                res.skipped.push(name);
            }
            else {
                // 目标已存在但不一致 → 先复制备份旧版，再删除替换（中央库为权威）
                // 注：不用 rename 做备份，Windows 上目录 rename 偶发 EPERM（杀软延迟扫描）
                if (!dryRun) {
                    const bak = `${dest}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
                    try {
                        copySkill(dest, bak);
                        res.backedUp.push(path.basename(bak));
                    }
                    catch {
                        res.backedUp.push(`备份失败:${name}`);
                    }
                    fs.rmSync(dest, { recursive: true, force: true });
                    copySkill(src, dest);
                }
                res.updated.push(name);
            }
        }
        results.push(res);
    }
    return results;
}
/* ========== adopt（收编） ========== */
export function adoptSkills(fromDir, dryRun) {
    const res = { adopted: [], skipped: [], conflicted: [] };
    const from = path.resolve(fromDir);
    if (!fs.existsSync(from))
        throw new Error(`源目录不存在: ${from}`);
    fs.mkdirSync(CENTRAL_DIR, { recursive: true });
    for (const name of listSkills(from)) {
        const src = path.join(from, name);
        const dest = path.join(CENTRAL_DIR, name);
        if (!fs.existsSync(dest)) {
            if (!dryRun)
                copySkill(src, dest);
            res.adopted.push(name);
        }
        else if (dirFingerprint(dest) === dirFingerprint(src)) {
            res.skipped.push(name);
        }
        else {
            res.conflicted.push(name); // 中央库已有不同版本，不覆盖，需人工处理
        }
    }
    return res;
}
/* ========== CLI 输出 ========== */
function printStatus() {
    const { central, centralDir, targets } = computeStatus();
    console.log(`中央技能库: ${centralDir}`);
    console.log(`技能数量: ${central.length}${central.length ? " → " + central.join(", ") : ""}\n`);
    console.log("=== 分发目标 ===");
    for (const t of targets) {
        const flags = [];
        if (t.missing.length)
            flags.push(`缺 ${t.missing.length}`);
        if (t.outdated.length)
            flags.push(`待更新 ${t.outdated.length}`);
        if (t.upToDate.length)
            flags.push(`同步 ${t.upToDate.length}`);
        console.log(`[${t.name}] ${t.dir}`);
        console.log(`  ${flags.length ? flags.join(" / ") : "无中央库技能"}${t.skills.length ? ` | 目标现有 ${t.skills.length} 个: ${t.skills.join(", ")}` : ""}`);
        if (t.missing.length)
            console.log(`  待分发: ${t.missing.join(", ")}`);
        if (t.outdated.length)
            console.log(`  需更新: ${t.outdated.join(", ")}`);
    }
    console.log("\n=== 本机 Agent 自动检测（与「工具连接」页同源）===");
    const detected = detectSkillTargets();
    for (const a of detected) {
        const tag = a.supported ? (a.alreadyTarget ? "✓ 已在分发目标" : "🔵 可自动分发") : a.connected ? "⚪ 已连接但不支持 skills" : "⚫ 未连接 MCP";
        console.log(`  [${a.name}] ${a.type} | ${tag}${a.note ? ` | ${a.note}` : ""}`);
    }
}
function printSync(results, dryRun) {
    for (const r of results) {
        console.log(`[${r.target}]`);
        console.log(`  新增: ${r.added.length ? r.added.join(", ") : "无"}`);
        console.log(`  更新: ${r.updated.length ? r.updated.join(", ") : "无"}`);
        console.log(`  跳过: ${r.skipped.length ? r.skipped.join(", ") : "无"}`);
        if (r.backedUp.length)
            console.log(`  已备份旧版: ${r.backedUp.join(", ")}`);
    }
    console.log(dryRun ? "\n[dry-run] 以上为预演，未写入任何文件" : "\n✓ 同步完成");
}
function arg(flag, argv) {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}
/* ========== CLI 入口（仅直接运行时执行，import 时不触发） ========== */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (cmd === "status") {
        printStatus();
    }
    else if (cmd === "sync") {
        printSync(syncSkills(argv.includes("--dry-run")), argv.includes("--dry-run"));
    }
    else if (cmd === "adopt") {
        const from = arg("--from", argv);
        if (!from) {
            console.error("用法: node dist/skill-sync.js adopt --from <技能目录> [--dry-run]");
            process.exit(1);
        }
        const res = adoptSkills(from, argv.includes("--dry-run"));
        console.log(`收编: ${res.adopted.length ? res.adopted.join(", ") : "无"}`);
        console.log(`跳过(已一致): ${res.skipped.length ? res.skipped.join(", ") : "无"}`);
        console.log(`冲突(中央库已有不同版本): ${res.conflicted.length ? res.conflicted.join(", ") : "无"}`);
        if (argv.includes("--dry-run"))
            console.log("\n[dry-run] 以上为预演，未写入任何文件");
    }
    else {
        console.log("用法:\n  node dist/skill-sync.js status\n  node dist/skill-sync.js sync [--dry-run]\n  node dist/skill-sync.js adopt --from <dir> [--dry-run]");
        process.exit(1);
    }
}
