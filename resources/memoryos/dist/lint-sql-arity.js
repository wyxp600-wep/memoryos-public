#!/usr/bin/env node
/**
 * MemoryOS — SQL 占位符/实参数量校验器（dev 工具）
 *
 * 背景（2026-09-16 实证）：`dist/server.js` 的 task_release 曾写成
 *   `.prepare('UPDATE cards SET ... WHERE id=?').run(st.assignee, c2.id)`  ← 1 个占位符、2 个实参
 * node:sqlite 在「实参多于占位符」时抛 `column index out of range`，而该段被 `catch {}` 静默吞掉
 * ⇒ 语句根本没执行，表现为「记忆头已更新、卡片侧无任何变化且无事件留痕」。这类错误没有任何静态报错，
 * 属于"能跑、跑完还是错的"最危险一类，故用本脚本做**全仓体检**。
 *
 * 判定规则（保守，宁漏不误）：
 *   ① 只分析**静态 SQL**（模板串中不含 ${} 占位符变量）；含 ${} 的判为 UNKNOWN（如 IN 列表拼 ? 的场景）
 *   ② 统计 SQL 中的 `?` 位置参数（跳过字符串字面量与 SQL 注释里的 ?）
 *   ③ 取紧随其后的 .run() / .get() / .all() 实参个数（顶层逗号切分；含展开语法 `...` 或三元整体数组 → UNKNOWN）
 *   ④ 存在命名参数（@x/:x/$x）或用对象传参 → UNKNOWN
 *   ⑤ 数量不等 → MISMATCH（唯一需要人工处理的类别）
 *
 * 用法：cd resources/memoryos && node dist/lint-sql-arity.js [--verbose]
 * 退出码：0 = 无 MISMATCH / 1 = 有 MISMATCH
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");
const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".js") && !f.startsWith("smoke-") || /^smoke-/.test(f));

/** 从 `(` 位置起找匹配的 `)`，返回 [内容, 结束下标]（跳过字符串/模板串内部） */
function readParen(src, open) {
    let depth = 0, i = open, quote = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === "\\") { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) return [src.slice(open + 1, i), i]; }
    }
    return [null, -1];
}

/** 顶层逗号切分（忽略括号/字符串内） */
function splitArgs(s) {
    const out = [];
    let depth = 0, quote = null, cur = "";
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) { cur += c; if (c === "\\") { cur += s[++i]; continue; } if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
        if (c === "(" || c === "[" || c === "{") depth++;
        if (c === ")" || c === "]" || c === "}") depth--;
        if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
        cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** 统计静态 SQL 里的 ? 占位符（跳过引号与注释）；返回 {q, named, dynamic} */
function analyzeSql(sql) {
    if (sql.includes("${")) return { dynamic: true };
    let q = 0, i = 0, quote = null;
    while (i < sql.length) {
        const c = sql[i];
        if (quote) { if (c === "\\") { i += 2; continue; } if (c === quote) quote = null; i++; continue; }
        if (c === "'" || c === '"') { quote = c; i++; continue; }
        if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
        if (c === "/" && sql[i + 1] === "*") { i += 2; while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++; i += 2; continue; }
        if (c === "?") { q++; i++; continue; }
        i++;
    }
    const named = /(^|[\s(,=])([@:$])[A-Za-z_]\w*/.test(sql.replace(/'[^']*'/g, ""));
    return { q, named, dynamic: false };
}

const problems = [];
let scanned = 0, unknown = 0;

/* ── 自测（防空转）：验证检测器对"已知坏样本"确实报警、对"已知好样本"不误报 ──
 * 依据教训：「通过/一致」型校验必须能证明自己会失败，否则 0 命中可能只是没在工作。 */
if (process.argv.includes("--self-test")) {
    const cases = [
        { name: "1 占位符 / 2 实参（本次真实缺陷形态）", sql: `UPDATE cards SET status='ready' WHERE id=?`, args: "st.assignee, c2.id", expect: 1 },
        { name: "3 占位符 / 3 实参（正常）", sql: `INSERT INTO t(a,b,c) VALUES (?,?,?)`, args: "a, b, c", expect: 0 },
        { name: "0 占位符 / 1 实参（多余参数）", sql: `DELETE FROM t`, args: "a", expect: 1 },
        { name: "引号内的 ? 不应计数", sql: `SELECT '?' AS q FROM t WHERE id=?`, args: "id", expect: 0 },
        { name: "SQL 注释里的 ? 不应计数", sql: `SELECT 1 -- ? 不是占位符\n FROM t WHERE id=?`, args: "id", expect: 0 },
    ];
    let bad = 0;
    for (const c of cases) {
        const info = analyzeSql(c.sql);
        const args = splitArgs(c.args);
        const detected = !info.dynamic && !info.named && info.q !== args.length ? 1 : 0;
        const ok = detected === c.expect;
        if (!ok) bad++;
        console.log(`${ok ? "PASS" : "FAIL"}  自测：${c.name}  → 占位符=${info.q} 实参=${args.length} 判为不匹配=${detected}`);
    }
    console.log(bad ? `\n❌ 自测失败 ${bad} 项：检测器本身不可信` : "\n✅ 自测通过：检测器对坏样本报警、对好样本不误报");
    process.exit(bad ? 1 : 0);
}

for (const f of files) {
    if (f === "lint-sql-arity.js") continue;
    const src = fs.readFileSync(path.join(HERE, f), "utf8");
    let idx = 0;
    while ((idx = src.indexOf(".prepare(", idx)) !== -1) {
        const [sqlArg, endSql] = readParen(src, idx + ".prepare".length);
        if (!sqlArg) break;
        // 取 SQL 文本：仅接受纯模板串/字符串（去掉反引号与多余换行）
        const m = sqlArg.trim().match(/^[`'"]([\s\S]*)[`'"]$/);
        if (!m) { idx = endSql; unknown++; continue; }
        const sql = m[1];
        const info = analyzeSql(sql);
        if (info.dynamic || info.named) { idx = endSql; unknown++; continue; }

        // 找紧随其后的 .run/.get/.all（允许跨行，最多向后 400 字符）
        const tail = src.slice(endSql, endSql + 400);
        const callM = tail.match(/^\s*\)?\s*\.(run|get|all)\s*\(/);
        if (!callM) { idx = endSql; continue; }
        const openParen = endSql + callM[0].length - 1;
        const [argsRaw, endArgs] = readParen(src, openParen);
        if (argsRaw == null) { idx = endSql; continue; }
        const args = splitArgs(argsRaw);
        const spread = /\.\.\./.test(argsRaw) || /^\s*\(/.test(argsRaw);
        if (spread) { unknown++; idx = endArgs; continue; }

        scanned++;
        const line = src.slice(0, idx).split("\n").length;
        if (args.length !== info.q) {
            problems.push({
                file: f, line, method: callM[1], placeholders: info.q, args: args.length,
                sql: sql.replace(/\s+/g, " ").trim().slice(0, 96),
                argsSample: args.join(", ").slice(0, 70),
            });
        }
        idx = endArgs;
    }
}
void files;

console.log(`SQL 参数数量体检（静态可判定）：扫描 ${scanned} 处调用，跳过 ${unknown} 处（动态 SQL / 命名参数 / 展开语法）`);
if (VERBOSE) console.log("（--verbose：仅多打印统计，不改变判定）");
if (!problems.length) {
    console.log("✅ 未发现占位符/实参数量不匹配");
    process.exit(0);
}
console.log(`\n❌ 发现 ${problems.length} 处不匹配（node:sqlite 会在运行时抛 column index out of range，若被静默 catch 则整条语句不执行）：\n`);
for (const p of problems) {
    console.log(`  ${p.file}:${p.line}  .${p.method}()  占位符=${p.placeholders} 实参=${p.args}`);
    console.log(`     SQL : ${p.sql}`);
    console.log(`     实参: ${p.argsSample}\n`);
}
process.exit(1);
