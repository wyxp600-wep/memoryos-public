#!/usr/bin/env node
/**
 * MemoryOS — 聚合冒烟 runner（修 F16 第二半）
 *
 * 背景：dist/ 下 17 个 smoke-*.js 各自独立退出码，无法知道「全绿」还是「某个被跳过」——
 * 这正是 F16 里「新工具上线后分不清陈旧断言噪声与真实注册缺失」的成因。
 * 本文件把全部冒烟收口成一次运行 + 一张表 + 单一退出码。
 *
 * 用法（cwd 必须是 resources/memoryos）：
 *   node dist/smoke-all.js                  # 跑全部（含环境依赖项，缺环境则 SKIP）
 *   node dist/smoke-all.js --only mcp,exec  # 只跑指定项（按脚本名片段匹配）
 *   node dist/smoke-all.js --skip agent     # 跳过指定项
 *   node dist/smoke-all.js --timeout 90     # 单项超时秒数（默认 120）
 *   node dist/smoke-all.js --list           # 只列清单
 *
 * 退出码：0 = 无 FAIL（SKIP 不算失败） / 1 = 有 FAIL
 * 约定：脚本自身非 0 退出即 FAIL；超时按 FAIL 计并提示（避免"卡住=全绿"的错觉）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));      // …/dist
const KERNEL = path.resolve(HERE, "..");                        // …/resources/memoryos（冒烟约定的 cwd）
const REPO = path.resolve(KERNEL, "..", "..");                  // 仓库根

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const pickList = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : null);
const ONLY = pickList(opt("only", ""));
const SKIP = pickList(opt("skip", "")) ?? [];
const TIMEOUT_S = Math.max(5, Number(opt("timeout", "120")) || 120);

/** 环境依赖项：缺依赖时 SKIP 而不是 FAIL（否则"环境没起"会被误读成"代码回归"）。
 *  ① NEEDS_LLM       = 需要可用的 OpenAI 兼容端点（默认本地 Ollama :11434）；
 *  ② NEEDS_LOCAL_EMBED = smoke-local.js 自述「需要 EMBED_MODE=local（BGE-M3）才跑」。
 *  实测口径（2026-09-15）：smoke-local 在 EMBED_MODE=fake 下以 exit 1 退出，属环境门控不是回归。 */
const NEEDS_LLM = new Set(["smoke-agent.js"]);
const NEEDS_LOCAL_EMBED = new Set(["smoke-local.js"]);
/** LLM 类单项含多轮真实推理，比常规项更慢：给不低于 180s，避免误判成超时 FAIL */
const LLM_MIN_TIMEOUT_S = 180;
const hasLocalEmbed = () => String(process.env.EMBED_MODE || "").toLowerCase() === "local";

function llmReachable() {
    const base = String(process.env.LLM_BASE_URL || process.env.MIMOS_URL || "http://127.0.0.1:11434/v1")
        .replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "");
    const r = spawnSync(process.execPath, [
        "-e",
        `const t=setTimeout(()=>process.exit(1),1500);fetch(${JSON.stringify(base + "/models")}).then(()=>{clearTimeout(t);process.exit(0)}).catch(()=>{clearTimeout(t);process.exit(1)})`,
    ], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    return r.status === 0;
}

/** 被测清单：dist/smoke-*.js（自动发现，避免手工维护漏项）+ 临时目录里的执行面冒烟 */
function discover() {
    const items = fs.readdirSync(HERE)
        .filter((f) => /^smoke-.*\.js$/.test(f) && f !== "smoke-all.js")
        .sort()
        .map((f) => ({ name: f.replace(/^smoke-|\.js$/g, ""), label: f, file: path.join(HERE, f) }));

    // 执行面冒烟：dist/smoke-exec.js 是 git 纳管的权威副本；`.workbuddy/tmp/smoke-exec.mjs` 为遗留
    //  scratch 副本（.workbuddy/ 被 .gitignore 忽略）。仅当 dist 版缺失时才回落 tmp 版，避免重复计数。
    if (!items.some((i) => i.label === "smoke-exec.js")) {
        const tmp = path.join(REPO, ".workbuddy", "tmp", "smoke-exec.mjs");
        if (fs.existsSync(tmp)) items.push({ name: "exec", label: "smoke-exec.mjs", file: tmp });
    }
    return items;
}

function runOne(item, skipReason) {
    const t0 = Date.now();
    if (skipReason) return { status: "SKIP", ms: 0, detail: skipReason, out: "" };
    const timeoutS = NEEDS_LLM.has(item.label) ? Math.max(TIMEOUT_S, LLM_MIN_TIMEOUT_S) : TIMEOUT_S;
    const r = spawnSync(process.execPath, [item.file], {
        cwd: KERNEL,
        encoding: "utf8",
        timeout: timeoutS * 1000,
        windowsHide: true,
        env: {
            ...process.env,
            MEMORY_AGENT: "smoke-all",
            MEMORY_AGENT_FPATH: path.join(REPO, ".workbuddy", "tmp", "smoke-agent.txt"),
            // ★ P0-2 落地后 server 侧执行面**默认关闭**（需 MEMORYOS_EXEC_ON=1）。
            //   冒烟必须显式打开，否则执行面本身无法被验证（生产默认值不受影响）。
            MEMORYOS_EXEC_ON: "1",
            MEMORYOS_EXEC_OFF: "",
        },
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const ms = Date.now() - t0;
    if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") return { status: "FAIL", ms, detail: `超时 >${timeoutS}s（进程已杀）`, out };
    return r.status === 0
        ? { status: "PASS", ms, detail: "", out }
        : { status: "FAIL", ms, detail: `exit=${r.status}`, out };
}

const all = discover();
const selected = all.filter((it) => {
    const hitOnly = !ONLY || ONLY.some((k) => it.name.includes(k) || it.label.includes(k));
    const hitSkip = SKIP.some((k) => it.name === k || it.label === k || it.name.includes(k));
    return hitOnly && !hitSkip;
});

if (argv.includes("--list") || !selected.length) {
    console.log(`共 ${all.length} 项冒烟：\n` + all.map((i) => `  ${i.name.padEnd(18)} ${i.label}`).join("\n"));
    process.exit(selected.length ? 0 : 1);
}

const llmOk = llmReachable();
const localEmbedOk = hasLocalEmbed();
console.log(`== MemoryOS 聚合冒烟 ==  cwd=${KERNEL}  超时=${TIMEOUT_S}s  LLM=${llmOk ? "可用" : "不可用（相关项 SKIP）"}  EMBED_MODE=${localEmbedOk ? "local" : "fake（smoke-local SKIP）"}\n`);

const rows = [];
for (const item of selected) {
    const skipReason = (NEEDS_LLM.has(item.label) && !llmOk) ? "无可用 LLM 端点（设 LLM_BASE_URL 或起 Ollama 后可跑）"
        : (NEEDS_LOCAL_EMBED.has(item.label) && !localEmbedOk) ? "需要 EMBED_MODE=local（BGE-M3）"
            : null;
    const r = runOne(item, skipReason);
    rows.push({ ...item, ...r });
    const mark = r.status === "PASS" ? "PASS" : r.status === "SKIP" ? "SKIP" : "FAIL";
    console.log(`${mark}  ${item.name.padEnd(18)} ${String(r.ms + "ms").padStart(7)}  ${r.detail}`);
    // 失败时打印最后 8 行输出，便于直接定位（聚合器不该吞掉证据）
    if (r.status === "FAIL") {
        const tail = r.out.trim().split(/\r?\n/).slice(-8);
        console.log(tail.map((l) => `        │ ${l}`).join("\n"));
    }
}

const n = (s) => rows.filter((r) => r.status === s).length;
const failNames = rows.filter((r) => r.status === "FAIL").map((r) => r.name);
console.log(`\n== 合计：${n("PASS")} PASS / ${n("FAIL")} FAIL / ${n("SKIP")} SKIP（共 ${rows.length} 项）==`);
if (failNames.length) console.log(`FAIL 项：${failNames.join(", ")}`);
process.exit(failNames.length ? 1 : 0);
