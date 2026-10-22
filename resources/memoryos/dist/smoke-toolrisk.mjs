#!/usr/bin/env node
/**
 * MemoryOS — 工具风险表覆盖复核（★ 批次③ 新增，独立 .mjs 避免 ESM/CJS 混用歧义）
 *
 * 取证背景：TOOL_RISK 曾停在 21 项而实际注册 29 项，memory_credential + 任务域 7 个工具
 * 无前缀 → needsGate 回落 LEGACY_WRITE_TOOLS → 静默放行（smoke-exec.js:80 旧断言钉死了该行为）。
 * 修法（用户拍板「server 注入端兜底」）：riskPrefix 未知工具返回 L4/required，注册端 100% 注入前缀。
 *
 * 本脚本核对两条链路：
 *   ① 注册清单（server.js --list-tools 派生） vs TOOL_RISK 键集 —— 任一缺失即 FAIL（退出码 1）
 *   ② riskPrefix 对未知工具返回 fail-closed 前缀；HEADLESS_PREAUTHORIZED 不含执行类/特权工具
 *
 * 用法：cd resources/memoryos && node dist/smoke-toolrisk.mjs
 * 退出码：0 全绿 / 1 有失败
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOL_RISK, HEADLESS_PREAUTHORIZED, riskPrefix } from "./exec-tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
function check(name, cond, detail = "") {
    if (cond) { passed++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

// ① 注册清单（--list-tools 派生；执行面 3 工具默认不注册，单独并入核对）
const out = execFileSync(process.execPath, [path.join(HERE, "server.js"), "--list-tools"], {
    maxBuffer: 1 << 20,
    encoding: "utf8",
});
const m = /##TOOLS##(\[[^\n]*\])/.exec(out);
const registered = m ? JSON.parse(m[1]) : [];
const EXEC3 = ["file_read", "file_write", "exec_run"];
const union = [...new Set([...registered, ...EXEC3])];
check("--list-tools 解析成功", registered.length > 0, `常驻 ${registered.length} + 执行 3`);

const missing = union.filter((n) => !TOOL_RISK[n]);
check("TOOL_RISK 覆盖全部注册工具（含执行面 3）",
    union.length > 0 && missing.length === 0,
    `注册 ${union.length} / TOOL_RISK ${Object.keys(TOOL_RISK).length}｜缺=[${missing.join(", ")}]`);

const extra = Object.keys(TOOL_RISK).filter((n) => !union.includes(n));
check("TOOL_RISK 无幽灵键（登记但未注册）",
    extra.length === 0, `多余=[${extra.join(", ")}]`);

// ② fail-closed 兜底语义
check("riskPrefix(未知工具) = L4/required fail-closed",
    riskPrefix("some_brand_new_tool") === "⟨risk:L4|gate:required⟩ ",
    JSON.stringify(riskPrefix("some_brand_new_tool")));
check("riskPrefix(已知 L0) = auto 放行",
    riskPrefix("memory_search") === "⟨risk:L0|gate:auto⟩ ");
check("riskPrefix(memory_credential) = L4/required",
    riskPrefix("memory_credential") === "⟨risk:L4|gate:required⟩ ");
check("riskPrefix(task_heartbeat) = L0/auto",
    riskPrefix("task_heartbeat") === "⟨risk:L0|gate:auto⟩ ");
check("riskPrefix(task_gate) = L0/auto（2026-09-25 改判：纯只读查看不该每次过审批）",
    riskPrefix("task_gate") === "⟨risk:L0|gate:auto⟩ ");

// ③ 无头预授权白名单边界（方案 A）
const mustNotPreauth = ["file_write", "exec_run", "memory_credential",
    // ★ 2026-09-25：task_gate 移出本表 —— 它已改判 L0/auto（纯只读查看），不属"执行类/特权/状态流转"，
    //   改由下方显式断言钉住其分级，避免"列表式豁免"掩盖分级回退。
    "obsidian", "task_delegate", "task_admin"];
const leaked = mustNotPreauth.filter((n) => HEADLESS_PREAUTHORIZED.has(n));
check("HEADLESS_PREAUTHORIZED 不含执行类/特权/状态流转工具", leaked.length === 0, `泄漏=[${leaked.join(", ")}]`);
check("HEADLESS_PREAUTHORIZED 含 task_release（无头归还锁防泄漏）",
    HEADLESS_PREAUTHORIZED.has("task_release"));

console.log(`\nsmoke-toolrisk：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
