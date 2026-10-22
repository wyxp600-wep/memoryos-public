#!/usr/bin/env node
/**
 * MemoryOS — 执行面 P0 验收冒烟（**git 纳管版**）
 * 原版在 `.workbuddy/tmp/smoke-exec.mjs`，但 `.workbuddy/` 被 .gitignore 忽略 ⇒ 无 git 回滚链、
 * 清理 tmp 即永久丢失（与 F18「新代码没进 git」同型问题）。本文件是唯一权威副本，tmp 版为遗留。
 *
 * 用法：cd resources/memoryos && node dist/smoke-exec.js
 * 隔离：全部动作发生在 mkdtemp 临时工作区 + 临时库内，退出即自清理，**绝不触碰生产库**。
 * 覆盖：① 单元级（needsGate / pickTools / truncateToolResult / resolveInside）
 *       ② 无头门禁语义（F7 用户决策 c）③ MCP 真调用三工具的正常与安全拒绝路径
 *       ④ exec_audit 落行与脱敏 ⑤ 命令形态守卫（★ 2026-10-14 方案 A：node -e / npx / npm install /
 *       git -c alias 等「单次调用即任意代码」形态必须被拒）
 * 退出码：0 全绿 / 1 有失败
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { needsGate, pickTools, truncateToolResult, parseRiskPrefix } from "./agent-core.js";
import { makeHeadlessGate, makeAutoWriteGate } from "./agent.js";
import { resolveInside } from "./exec-tools.js";
import { decideApproval, listApprovals } from "./exec-approval.js"; // ★ 方案 B：审批闸数据层（验收直接用真实现）

const HERE = path.dirname(fileURLToPath(import.meta.url));      // …/resources/memoryos/dist
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-exec-smoke-"));
const DB = path.join(WS, "smoke-exec.db");
const SHIM = path.join(WS, "agent-fpath.txt");                   // 不指向任何真实客户端配置
fs.writeFileSync(SHIM, "smoke-exec\n", "utf8");

let failed = 0, passed = 0;
function check(name, cond, detail = "") {
    if (cond) { passed++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
const cleanup = () => { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on("exit", cleanup);

/* ── 起 MCP 服务端（临时工作区 + 临时库）────────────────────── */
const proc = spawn(process.execPath, [path.join(HERE, "server.js")], {
    env: {
        ...process.env,
        MEMORY_DB: DB,
        MEMORY_AGENT: "smoke-exec",
        MEMORY_AGENT_FPATH: SHIM,
        MEMORYOS_WORKSPACE: WS,          // ← 执行面工作区锁定到临时目录
        MEMORYOS_EXEC_ON: "1",          // ★ P0-2 后执行面默认关闭，验收须显式开启
        MEMORYOS_EXEC_OFF: "",          // 显式确保熔断开关未置 1
        MEMORYOS_EXEC_APPROVAL_TIMEOUT_MS: "8000", // ★ 方案 B：把「等人审」上限压到 8s，便于验收超时路径
    },
    windowsHide: true,
});
let buf = "";
let lastId = 0;
const pending = new Map();
function send(method, params) {
    const id = ++lastId;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
    }
});
const textOf = (resp) => (resp?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const call = async (name, args) => textOf(await send("tools/call", { name, arguments: args }));

try {
    /* ── ① 单元级：不依赖服务端 ───────────────────────────── */
    check("needsGate：L1 前缀 → 需审批", needsGate({ name: "file_write", description: "⟨risk:L1|gate:required⟩ x" }) === true);
    check("needsGate：L0 前缀 → 放行", needsGate({ name: "file_read", description: "⟨risk:L0|gate:auto⟩ x" }) === false);
    check("needsGate：无前缀回落静态名单（memory_write 需审批）", needsGate({ name: "memory_write", description: "无前缀" }) === true);
    check("needsGate：无前缀且不在名单 → 放行（仅旧服务端兼容路径）", needsGate({ name: "some_readonly", description: "无前缀" }) === false);
    check("parseRiskPrefix 解析 L4 fail-closed", parseRiskPrefix("⟨risk:L4|gate:required⟩ y")?.risk === "L4");

    const all = [{ function: { name: "a" } }, { function: { name: "b" } }];
    check("pickTools(undefined) = 全量", pickTools(all, undefined).length === 2);
    check("pickTools([]) = 零工具（★ 修 F17：旧实现会回落成全量）", pickTools(all, []).length === 0);
    let threw = false; try { pickTools(all, ["a", "typo"]); } catch { threw = true; }
    check("pickTools 含未知名 → 抛错（不再静默）", threw);

    const long = "HEAD_MARKER\n" + "x".repeat(9000) + "\nTAIL_ERROR_MARKER";
    const tr = truncateToolResult(long);
    check("truncateToolResult 保留头部", tr.includes("HEAD_MARKER"));
    check("truncateToolResult 保留尾部（★ 修 F3：错误在尾部，旧实现会丢）", tr.includes("TAIL_ERROR_MARKER"));

    threw = false; try { resolveInside(WS, "../../Windows/win.ini"); } catch { threw = true; }
    check("resolveInside 拒绝越界路径", threw);
    threw = false; try { resolveInside(WS, "\\\\server\\share\\x"); } catch { threw = true; }
    check("resolveInside 拒绝 UNC 路径", threw);
    // ★ 2026-10-14：Windows 路径形态加固（ADS 备用数据流 / 保留设备名）
    threw = false; try { resolveInside(WS, "sub/a.txt:evil"); } catch { threw = true; }
    check("resolveInside 拒绝 ADS 备用数据流（盘符后含 ':'）", threw);
    threw = false; try { resolveInside(WS, "NUL"); } catch { threw = true; }
    check("resolveInside 拒绝保留设备名 NUL", threw);
    threw = false; try { resolveInside(WS, "con.txt"); } catch { threw = true; }
    check("resolveInside 拒绝保留设备名 con.txt（带扩展名同样命中）", threw);
    threw = false; try { resolveInside(WS, "sub/ok-name.txt"); } catch { threw = true; }
    check("resolveInside 正常路径不被误拒（防误伤）", threw === false);

    /* ── ② 无头门禁语义（★ P0 修 F7，用户决策「方案 c」）────── */
    const hg = makeHeadlessGate();
    const _err = console.error; console.error = () => { };   // 静音门禁日志
    const hTaskDone = await hg("task_done", {});
    const hClaim = await hg("task_claim", {});
    const hMemWrite = await hg("memory_write", {});
    const hFileWrite = await hg("file_write", {});
    const hExec = await hg("exec_run", {});
    const hObsidian = await hg("obsidian", { action: "write_note" });
    const ag = await makeAutoWriteGate()("file_write", {});
    console.error = _err;
    check("F7① --work 预授权 task_done（否则无人值守无法结项）", hTaskDone === true);
    check("F7② --work 预授权 task_claim", hClaim === true);
    check("F7③ --work 预授权 memory_write", hMemWrite === true);
    check("F7④ --work 拒绝执行类 file_write（旧行为=全放行）", hFileWrite === false);
    check("F7⑤ --work 拒绝 exec_run", hExec === false);
    check("F7⑥ --work 拒绝 obsidian(action=write_note)（写工作区外 vault）", hObsidian === false);
    check("F7⑦ --auto-write 显式全放行", ag === true);

    /* ── ③ MCP 级：真调三个工具 ───────────────────────────── */
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-exec", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await send("tools/list", {})).result?.tools ?? [];
    check("tools/list 含执行面三工具", ["file_read", "file_write", "exec_run"].every((n) => tools.some((t) => t.name === n)), `count=${tools.length}`);
    check("执行工具都带风险前缀", tools.filter((t) => ["file_read", "file_write", "exec_run"].includes(t.name)).every((t) => parseRiskPrefix(t.description) !== null));
    // ★ 2026-09-22 批次③：全量工具 100% 带风险前缀（riskPrefix 未知工具 fail-closed 兜底的验收）
    const noPrefix = tools.filter((t) => parseRiskPrefix(t.description) === null).map((t) => t.name);
    check("tools/list 全量工具都带风险前缀（fail-closed 注入端兜底）", tools.length > 0 && noPrefix.length === 0, `count=${tools.length} 缺前缀=[${noPrefix.join(", ")}]`);
    const l4 = tools.filter((t) => parseRiskPrefix(t.description)?.risk === "L4").map((t) => t.name);
    check("memory_credential 分级 L4/required", l4.includes("memory_credential"), `L4=[${l4.join(", ")}]`);
    const hb = tools.find((t) => t.name === "task_heartbeat");
    check("task_heartbeat 分级 L0/auto（无人值守续期放行）", !!hb && parseRiskPrefix(hb.description)?.gate === false);

    fs.mkdirSync(path.join(WS, "sub"), { recursive: true });
    fs.writeFileSync(path.join(WS, "sub", "a.txt"), "第一行\n第二行\n第三行\n", "utf8");
    // ★ 2026-10-14：执行面用例改用「工作区内脚本文件」方式 —— `node -e`（命令行内联代码）现被
    //   命令形态守卫拦下（那是单次调用即任意代码的执行通道），脚本文件方式更贴近真实用法，
    //   且仍需先 file_write（保留「写操作必审」这道闸的信号）。
    fs.writeFileSync(path.join(WS, "exec-ok.js"), "console.log('EXEC_OK_42')\n", "utf8");
    fs.writeFileSync(path.join(WS, "hang.js"), "setTimeout(()=>{},60000)\n", "utf8");
    fs.writeFileSync(path.join(WS, "spam.js"), "for(let i=0;i<900;i++)console.log('LINE_'+i)\n", "utf8");

    const r1 = await call("file_read", { path: "sub/a.txt" });
    check("file_read 正常读取", r1.includes("第一行") && r1.includes("第三行"), r1.split("\n")[0]);

    const r2 = await call("file_read", { path: "../../Windows/win.ini" });
    check("file_read 越界被拒", r2.includes("越界") || r2.includes("执行失败"), r2.slice(0, 80));

    // ★ 2026-10-14：ADS 形态经真实 MCP 调用链也要被拒（不只是在单元层）
    const r2b = await call("file_read", { path: "sub/a.txt:evil" });
    check("file_read 拒绝 ADS 备用数据流路径", r2b.includes("备用数据流") || r2b.includes("执行失败"), r2b.slice(0, 80));

    const r3 = await call("file_write", { path: "sub/new.txt", content: "hello-p0" });
    check("file_write 新建成功", fs.existsSync(path.join(WS, "sub", "new.txt")) && r3.includes("新建"), r3.split("\n")[0]);

    const r4 = await call("file_write", { path: "sub/new.txt", content: "hello-p0-v2" });
    const bak = fs.readdirSync(path.join(WS, "sub")).filter((f) => f.includes(".bak-p0exec-"));
    check("file_write 覆盖前自动备份（B2 纪律工具化）", bak.length === 1 && r4.includes("改前备份"), `backups=${bak.join(",")}`);

    const r5 = await call("exec_run", { cmd: ["node", "exec-ok.js"] });
    check("exec_run 正常执行", r5.includes("EXEC_OK_42") && r5.includes("exit=0"), r5.split("\n")[1]);

    const r6 = await call("exec_run", { cmd: ["curl", "http://127.0.0.1:9/"] });
    check("exec_run 非白名单命令被拒", r6.includes("不在允许清单") || r6.includes("执行失败"), r6.slice(0, 80));

    /* ── ⑤ ★ 2026-10-14（方案 A）命令形态守卫：默认安全 ─────────────────── */
    const g1 = await call("exec_run", { cmd: ["node", "-e", "console.log('RCE')"] });
    check("守卫① node -e 被拒（单次调用即任意代码，无需先写文件）", g1.includes("命令形态被拒"), g1.slice(0, 90));
    const g2 = await call("exec_run", { cmd: ["npx", "--version"] });
    check("守卫② npx 不在默认清单（拉远程包直接跑）", g2.includes("不在允许清单"), g2.slice(0, 90));
    const g3 = await call("exec_run", { cmd: ["git", "-c", "alias.pwn=!echo x", "pwn"] });
    check("守卫③ git -c alias 逃逸被拒", g3.includes("命令形态被拒"), g3.slice(0, 90));
    const g4 = await call("exec_run", { cmd: ["npm", "install", "--no-save"] });
    check("守卫④ npm install 被拒（第三方包 postinstall 生命周期脚本）", g4.includes("命令形态被拒"), g4.slice(0, 90));
    const g5 = await call("exec_run", { cmd: ["node", "exec-ok.js"] });
    check("守卫⑤ 文件方式仍放行（守卫只拦内联/远程执行形态，不误伤正常用法）", g5.includes("EXEC_OK_42"), g5.slice(0, 90));

    const r7 = await call("exec_run", { cmd: ["node", "hang.js"], timeout_ms: 1500 });
    check("exec_run 超时①标记 TIMEOUT", r7.includes("TIMEOUT"), r7.split("\n")[1]);
    check("exec_run 超时②提示进程树已终止", r7.includes("进程树已终止"));

    const r8 = await call("exec_run", { cmd: ["node", "exec-ok.js"], cwd: "../.." });
    check("exec_run cwd 越界被拒", r8.includes("越界") || r8.includes("执行失败"), r8.slice(0, 80));

    const r9 = await call("exec_run", { cmd: ["node", "spam.js"] });
    check("大输出落 artifact 并回传路径（修 F3）", /完整输出：.*artifacts/.test(r9) && fs.existsSync((r9.match(/完整输出：(.+)/) ?? [])[1]?.trim() ?? ""));
    check("大输出仍保留尾部（LINE_8xx 可见）", /LINE_8\d\d/.test(r9));

    /* ── ⑥ ★ 2026-10-14（方案 B）服务端挂起审批：高风险 → 人批才执行 ────────────
       要证的核心：「人未表态 = 命令不执行」；只有同意/拒绝/超时三种裁决之一到达后才推进。
       用读写句柄直连同一临时库（与服务端 WAL 并发安全）扮演"人"，验收后再关闭。 */
    const rw = new DatabaseSync(DB);
    const apprCount = () => rw.prepare(`SELECT COUNT(*) AS c FROM exec_approvals`).get().c;
    const lastPending = () => rw.prepare(`SELECT * FROM exec_approvals WHERE status='pending' ORDER BY id DESC LIMIT 1`).get() ?? null;
    const waitPending = async () => { for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 100)); const p = lastPending(); if (p) return p; } return null; };

    const before = apprCount();
    const lowRisk = await call("exec_run", { cmd: ["node", "exec-ok.js"] });
    check("B1.低风险命令零打扰直放（不产生待批行）", lowRisk.includes("EXEC_OK_42") && apprCount() === before, `approvals=${apprCount()}`);

    const inflightOK = call("exec_run", { cmd: ["git", "clean", "-nd"] });  // 高危形态（非白名单子命令）；在临时目录执行无害
    const p1 = await waitPending();
    check("B2.高风险命令落 pending 并挂起（人未表态 = 未执行）", !!p1 && String(p1.cmd).includes("git clean") && !!p1.reason, `#${p1?.id} ${String(p1?.cmd).slice(0, 42)}`);
    check("B2b.待批项对人可见（看板数据源 listApprovals 命中）", !!p1 && listApprovals(rw, 60).pending.some((x) => x.id === p1.id && x.seconds_left >= 0), `pending=${listApprovals(rw, 60).pending.length}`);
    decideApproval(rw, p1.id, "approve", "human:smoke");
    const rOk = await inflightOK;
    check("B3.人工批准后，原调用继续执行并回传结果", rOk.includes("【exec_run】") && /exit=/.test(rOk), rOk.split("\n")[1] ?? rOk.slice(0, 80));
    check("B4.审批链闭环：待批项回填 executed + 结果摘要", rw.prepare(`SELECT status,result FROM exec_approvals WHERE id=?`).get(p1.id)?.status === "executed", JSON.stringify(rw.prepare(`SELECT status,result FROM exec_approvals WHERE id=?`).get(p1.id)));

    const inflightDeny = call("exec_run", { cmd: ["git", "clean", "-nd"] });
    const p2 = await waitPending();
    decideApproval(rw, p2.id, "deny", "human:smoke");
    const rDeny = await inflightDeny;
    check("B5.人工拒绝 → 命令不执行，回告原因与审批编号", rDeny.includes("人工拒绝") && !rDeny.includes("【exec_run】") && rDeny.includes(`#${p2.id}`), rDeny.slice(0, 100));

    const inflightTo = call("exec_run", { cmd: ["git", "clean", "-nd"] });
    const p3 = await waitPending();
    const rTo = await inflightTo; // 无人处理 → 到期按拒绝
    check("B6.无人处理超时 → 按拒绝处理（绝不默认放行）", rTo.includes("超时") && !rTo.includes("【exec_run】"), rTo.slice(0, 100));
    check("B7.超时项落 status=expired + decided_by=system:timeout", rw.prepare(`SELECT status,decided_by FROM exec_approvals WHERE id=?`).get(p3.id)?.status === "expired", JSON.stringify(rw.prepare(`SELECT status,decided_by FROM exec_approvals WHERE id=?`).get(p3.id)));

    const dupFlight = call("exec_run", { cmd: ["git", "clean", "-nd"] });
    const p4 = await waitPending();
    decideApproval(rw, p4.id, "deny", "human:smoke");
    const second = decideApproval(rw, p4.id, "approve", "human:smoke2");
    await dupFlight;
    check("B8.二次裁决被拒（CAS：人的决定不被后来的点击覆盖）", second.ok === false && rw.prepare(`SELECT decided_by FROM exec_approvals WHERE id=?`).get(p4.id)?.decided_by === "human:smoke", `second=${second.ok} by=${rw.prepare(`SELECT decided_by FROM exec_approvals WHERE id=?`).get(p4.id)?.decided_by}`);
    rw.close();

    proc.kill();
    await new Promise((r) => setTimeout(r, 700));

    /* ── ④ 审计落行 ──────────────────────────────────────── */
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("SELECT tool,risk,approval,detail FROM exec_audit ORDER BY id").all();
    const byTool = (t) => rows.filter((r) => r.tool === t).length;
    check("exec_audit 有记录（P0 验收：≥3 行）", rows.length >= 3, `rows=${rows.length}`);
    check("exec_audit 覆盖三工具", byTool("file_read") > 0 && byTool("file_write") > 0 && byTool("exec_run") > 0, `file_read=${byTool("file_read")} file_write=${byTool("file_write")} exec_run=${byTool("exec_run")}`);
    check("exec_audit 记录了风险级", rows.every((r) => /^L[0-4]$/.test(r.risk)));
    check("exec_audit 参数摘要已隐去敏感键", !JSON.stringify(rows).includes("Bearer "));
    // ★ 方案 B：审批结论必须在审计流水里可查（人是被谁批的、有没有放行过）
    check("exec_audit 留痕：高风险命令经人工批准（human-approved）", rows.some((r) => r.approval === "human-approved"), `n=${rows.filter((r) => r.approval === "human-approved").length}`);
    check("exec_audit 留痕：拒绝与超时路径（human-denied / approval-expired）", rows.some((r) => r.approval === "human-denied") && rows.some((r) => r.approval === "approval-expired"));
    const apprRows = db.prepare("SELECT status, result, decided_by FROM exec_approvals ORDER BY id").all();
    const hasState = (s) => apprRows.some((r) => r.status === s);
    check("exec_approvals 状态机留痕：pending/approved→executed/denied/expired 全覆盖",
        apprRows.length >= 4 && hasState("executed") && hasState("denied") && hasState("expired"),
        apprRows.map((r) => r.status).join(","));
    db.close();
} catch (e) {
    failed++;
    console.log(`FAIL  冒烟脚本异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
    if (!proc.killed) proc.kill();
}

console.log(`\n== 执行面 P0 冒烟：${passed} PASS / ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
