#!/usr/bin/env node
/**
 * MemoryOS — 静默 catch 体检器（dev 工具）
 *
 * 背景（2026-09-16 实证）：`task_release` 的卡片侧 UPDATE 因「实参多于占位符」抛错，却被
 * `catch { /* 卡片侧失败不阻断记忆侧 *\/ }` 静默吞掉 ⇒ 语句根本没执行，外观却与成功无异。
 * 教训：**静默 catch 是缺陷放大器** —— 它抹平了"没执行"与"执行成功"的区别。
 * 本工具把"无日志的 catch"全部列出来，并按其 try 体内是否含**写操作**分级，优先处理高危项。
 *
 * 分级规则：
 *   HIGH —— try 体内含 SQL 写（INSERT/UPDATE/DELETE/REPLACE）或 fs 写（writeFile/copyFile/rm…）
 *           且 catch 体**无任何 console./log( 调用** ⇒ 失败会彻底隐身，必须补日志或改为显式处理
 *   MED  —— try 体内含 IO（read/prepare/fetch/json）但非写操作
 *   LOW  —— 其余（如 JSON.parse 兜底、可选清理）
 * 判定为"有日志"的情形：catch 体内出现 console. / console.error( / log( / logError( / 或 rethrow(throw)
 *
 * 用法：cd resources/memoryos && node dist/lint-silent-catch.js [--all]   （--all 连 LOW 一起列）
 * 退出码：0 = 无 HIGH / 1 = 存在 HIGH
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SERVICES = path.resolve(HERE, "..", "..", "..", "services");
const SHOW_ALL = process.argv.includes("--all");

/** 自测（防空转）：证明检测器对"静默写失败"报警、对"有日志/重抛"不误报 */
if (process.argv.includes("--self-test")) {
    const samples = [
        { name: "静默 catch 包住 SQL 写（本次缺陷形态）", code: `try { db.prepare("UPDATE t SET a=1 WHERE id=?").run(id); } catch { }`, expect: "HIGH" },
        { name: "静默 catch 包住 fs 写", code: `try { fs.writeFileSync(p, s); } catch { /* 忽略 */ }`, expect: "HIGH" },
        { name: "catch 内有日志 → 不算静默", code: `try { db.prepare("UPDATE t SET a=1 WHERE id=?").run(id); } catch (e) { console.error(e.message); }`, expect: "OK" },
        { name: "catch 内重抛 → 不算静默", code: `try { db.prepare("UPDATE t SET a=1 WHERE id=?").run(id); } catch (e) { throw e; }`, expect: "OK" },
        { name: "只读 JSON.parse 兜底 → LOW", code: `try { j = JSON.parse(s); } catch { j = null; }`, expect: "LOW" },
    ];
    let bad = 0;
    for (const s of samples) {
        const v = classifyTryCatch(s.code);
        const ok = v === s.expect;
        if (!ok) bad++;
        console.log(`${ok ? "PASS" : "FAIL"}  自测：${s.name} → 判为 ${v}（期望 ${s.expect}）`);
    }
    console.log(bad ? `\n❌ 自测失败 ${bad} 项` : "\n✅ 自测通过：静默写失败会报警，有日志/重抛/只读兜底不误报");
    process.exit(bad ? 1 : 0);
}

/** 从 try 起点找匹配的 catch，返回 { tryBody, catchBody, catchLine } */
function classifyTryCatch(src) {
    const ti = src.indexOf("try");
    if (ti === -1) return "NONE";
    const braceOpen = src.indexOf("{", ti);
    if (braceOpen === -1) return "NONE";
    const tryBody = blockOf(src, braceOpen);
    const afterTry = src.slice(braceOpen + tryBody.length + 2); // 跳过 try 的 }
    const ci = afterTry.indexOf("catch");
    if (ci === -1) return "NONE";
    const cbOpen = afterTry.indexOf("{", ci);
    if (cbOpen === -1) return "NONE";
    const catchBody = blockOf(afterTry, cbOpen);
    // 「有日志」判定必须包含本项目自己的日志封装，否则 logDaemon/logAudit 会被误报为静默（降噪）
    const logged = /console\s*\.\s*(error|warn|log)|\.error\s*\(|\blog\s*\(|logDaemon\s*\(|logAudit\s*\(|logExecAudit\s*\(|throw\b/.test(catchBody);
    if (logged) return "OK";
    const wrote = /\.run\s*\(|\.exec\s*\(|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|writeFileSync|writeFile\s*\(|copyFileSync|appendFileSync|unlinkSync|rmSync|renameSync/i.test(tryBody);
    const io = /\.prepare\s*\(|\.get\s*\(|\.all\s*\(|readFileSync|readdirSync|fetch\s*\(/.test(tryBody);
    return wrote ? "HIGH" : io ? "MED" : "LOW";
}
function blockOf(src, openIdx) {
    let depth = 0, i = openIdx, quote = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) { if (c === "\\") { i++; continue; } if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
    }
    return src.slice(openIdx + 1);
}

const targets = [];
/* 默认只扫**生产文件**：测试脚本（smoke 系列）、开发工具（lint 系列、snapshot-routes、audit-probe）
 * 中大量「try 清理 / catch 空」是有意为之、不承载业务写，纳入会淹没真实告警。
 * 需要全量时加 --all-files。 */
const ALL_FILES = process.argv.includes("--all-files");
const isDevTool = (f) => /^(smoke|lint-|snapshot-routes|audit-probe)/.test(f);   // 含 legacy 的 smoke.js
for (const f of fs.readdirSync(HERE)) {
    if (!f.endsWith(".js")) continue;
    if (f === "lint-silent-catch.js") continue;
    if (!ALL_FILES && isDevTool(f)) continue;
    targets.push(path.join(HERE, f));
}
if (fs.existsSync(REPO_SERVICES)) for (const f of fs.readdirSync(REPO_SERVICES)) if (f.endsWith(".js")) targets.push(path.join(REPO_SERVICES, f));

const hits = [];
for (const p of targets) {
    const src = fs.readFileSync(p, "utf8");
    // ★ 正向遍历 `try` 关键字（而非从 catch 反查 try）——反查窗口可能匹配到另一个 try 块造成误报；
    //   判定逻辑与 --self-test 完全同一套（classifyTryCatch），保证"自测过的规则 = 实际用的规则"。
    const re = /\btry\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const verdict = classifyTryCatch(src.slice(m.index));
        if (verdict !== "HIGH" && verdict !== "MED" && !(SHOW_ALL && verdict === "LOW")) continue;
        const line = src.slice(0, m.index).split("\n").length;
        hits.push({ file: path.relative(path.resolve(HERE, "..", "..", ".."), p), line, verdict });
    }
}
hits.sort((a, b) => (a.verdict === b.verdict ? a.file.localeCompare(b.file) : a.verdict === "HIGH" ? -1 : 1));

const high = hits.filter((h) => h.verdict === "HIGH");
console.log(`静默 catch 体检：扫描 ${targets.length} 个文件，命中 HIGH ${high.length} / MED ${hits.filter((h) => h.verdict === "MED").length}${SHOW_ALL ? ` / LOW ${hits.filter((h) => h.verdict === "LOW").length}` : ""}`);
for (const h of hits) console.log(`  [${h.verdict}] ${h.file}:${h.line}`);
console.log(high.length ? `\n❌ ${high.length} 处高危：catch 吞掉了写操作失败且无日志（补 console.error 或改为显式处理）` : "\n✅ 无高危静默 catch（写失败均有日志或重抛）");
process.exit(high.length ? 1 : 0);
