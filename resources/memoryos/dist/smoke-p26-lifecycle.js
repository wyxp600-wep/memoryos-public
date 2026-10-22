#!/usr/bin/env node
import { bodyFixture } from "./memory-body-fixture.js";
/**
 * MemoryOS — P2-6（MACP C-2/C-3）任务生命周期 **独立验收** 冒烟
 *
 * 定位：不替代他方的 smoke-mcp/smoke-macp，而是补它们**没覆盖到的角度**：
 *   ① **卡侧副作用**（记忆头对了、卡片没动 = 三方不一致，正是本冒烟首次跑就抓到的真实缺陷）；
 *   ② **负路径**（非法迁移/非认领者/缺必填 必须被拒，而不是"没报错就算过"）；
 *   ③ 租约窗口的实际值（C-3 声称 10 分钟，必须量出来而非读注释）。
 *
 * 手法：stdio 真调 MCP + 另一条**只读连接**直查同一临时库（同时观测"对外契约"与"落库事实"）。
 * 用法：cd resources/memoryos && node dist/smoke-p26-lifecycle.js     退出码 0/1
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "p26-life-"));
const DB = path.join(WS, "life.db");
const proc = spawn(process.execPath, [path.join("dist", "server.js")], {
    env: { ...process.env, MEMORY_DB: DB, MEMORY_AGENT: "p26-life", MEMORY_AGENT_FPATH: path.join(WS, "f.txt") },
    windowsHide: true,
});
let buf = "", id = 0;
const wait = new Map();
const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id && wait.has(m.id)) { const r = wait.get(m.id); wait.delete(m.id); r(m); }
    }
});
const text = (resp) => (resp?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const call = (name, args) => send("tools/call", { name, arguments: args }).then(text);

let pass = 0, fail = 0;
const check = (n, ok, detail = "") => { if (ok) { pass++; console.log(`PASS  ${n}${detail ? "  — " + detail : ""}`); } else { fail++; console.log(`FAIL  ${n}${detail ? "  — " + detail : ""}`); } };

let db = null;
const cardOf = (memId) => db.prepare(`SELECT * FROM cards WHERE ref_kind='memory' AND ref_id=? ORDER BY id DESC LIMIT 1`).get(memId);
const headStatus = (memId) => {
    const c = db.prepare(`SELECT content FROM memories WHERE id=?`).get(memId)?.content ?? "";
    return (c.match(/\[status:([a-z_]+)\]/) ?? [])[1] ?? "";
};
const versionOf = (memId) => db.prepare(`SELECT version FROM memories WHERE id=?`).get(memId)?.version;
const leaseMinutes = (cardId) => {
    const r = db.prepare(`SELECT (julianday(lease_expires_at) - julianday('now'))*24*60 AS m FROM cards WHERE id=?`).get(cardId);
    return r?.m;
};

try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p26-life", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    db = new DatabaseSync(DB, { readOnly: true });
    const dbFix = new DatabaseSync(DB); // 夹具专用可写连接：仅制造「列状态漂移」场景（归档/merged），不参与断言

    /* ── A. 领取 + 租约窗口（C-3 实测值） ── */
    const a = Number((await call("task_assign", { content: "生命周期验收任务 A", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    const cardA1 = cardOf(a);
    check("A1.task_assign 同步建卡", !!cardA1, cardA1 ? `card#${cardA1.id} status=${cardA1.status}` : "无卡");
    const claimMsg = await call("task_claim", { memory_id: a, as: "p26-life" });
    const cardA2 = cardOf(a);
    check("A2.claim 后记忆头=in_progress", headStatus(a) === "in_progress", `head=${headStatus(a)}`);
    check("A3.claim 后卡片=running 且持锁", cardA2?.status === "running" && !!cardA2?.claim_lock, `card=${cardA2?.status} lock=${cardA2?.claim_lock ? "有" : "无"}`);
    const lm = leaseMinutes(cardA2.id);
    check("A4.租约窗口实测 ≈10 分钟（C-3，非读注释）", Number.isFinite(lm) && lm > 8 && lm < 12, `lease≈${lm?.toFixed(2)}min`);

    /* ── B. heartbeat：正路径 + 非认领者被拒 ── */
    check("B1.认领者续租成功", /续租成功/.test(await call("task_heartbeat", { memory_id: a, as: "p26-life" })));
    check("B2.非认领者续租被拒（负路径）", /无权续租/.test(await call("task_heartbeat", { memory_id: a, as: "someone-else" })));

    /* ── C. release：记忆侧 + **卡侧** 同步（本冒烟首跑即抓到卡侧静默失败的缺陷） ── */
    const vBefore = versionOf(a);
    check("C1.release 后记忆头=pending", /已释放/.test(await call("task_release", { memory_id: a, reason: "验收释放" })) && headStatus(a) === "pending", `head=${headStatus(a)}`);
    const cardA3 = cardOf(a);
    check("C2.★release 后卡片=ready 且清锁（卡侧副作用，防静默失败）", cardA3?.status === "ready" && !cardA3?.claim_lock, `card=${cardA3?.status} lock=${cardA3?.claim_lock ?? "null"}`);
    check("C3.release 递增记忆版本（乐观锁语义）", versionOf(a) === vBefore + 1, `${vBefore}→${versionOf(a)}`);
    check("C4.非进行中任务 release 被拒（负路径）", /仅进行中任务可释放/.test(await call("task_release", { memory_id: a })));

    /* ── D. 释放后可被他人接管重领 + fencing ── */
    // ★ 2026-09-19（弊端 H2）：as="any" 托管认领会改写归属——须携 scope>=write 凭据（与硬模式同口径）
    const d1Cred = String(await call("memory_credential", { action: "issue", agent: "p26-life", scope: "write", ttl_hours: 1 })).split("：").pop().trim();
    const claim2 = await call("task_claim", { memory_id: a, as: "any", credential: d1Cred });   // 指派他人须 as=any 强制托管认领（assignee 校验会拦）+ H2 凭据
    check("D1.释放后可被他人接管重领", /已认领/.test(claim2) && headStatus(a) === "in_progress", claim2.replace(/\s+/g, " ").slice(0, 80));
    check("D2.错误 lease 的完成写被拒（fencing）", /本次完成拒绝|租约/.test(await call("task_done", { memory_id: a, conclusion: "x", lease_token: "00000000-0000-0000-0000-000000000000" })));

    /* ── E. block：必填原因 + 卡侧同步 + 不进可做集 ── */
    const b = Number((await call("task_assign", { content: "生命周期验收任务 B（用于 block/reopen）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    const blockFromPending = await call("task_admin", { action: "block", memory_id: b, reason: "验收：pending 直接 block 应非法" });
    check("E0.裸 pending 不可直接 block（状态机拦截）", !/已标记受阻/.test(blockFromPending) && headStatus(b) === "pending", blockFromPending.replace(/\s+/g, " ").slice(0, 80));
    await call("task_claim", { memory_id: b, as: "p26-life" });              // 先进入 in_progress 才允许 block
    const noReason = await call("task_admin", { action: "block", memory_id: b });
    check("E1.block 缺原因被拒（必填校验）", !/已标记受阻/.test(noReason), noReason.replace(/\s+/g, " ").slice(0, 100));
    const blockOk = await call("task_admin", { action: "block", memory_id: b, reason: "验收：模拟依赖断裂" });
    check("E2.block 带原因成功且头=blocked", /已标记受阻/.test(blockOk) && headStatus(b) === "blocked", `head=${headStatus(b)}｜${blockOk.replace(/\s+/g, " ").slice(0, 60)}`);
    const cardB = cardOf(b);
    check("E3.★block 卡侧同步为 blocked", cardB?.status === "blocked", `card=${cardB?.status}`);
    check("E4.blocked 任务原因已写入正文（留痕）", /模拟依赖断裂/.test(db.prepare(`SELECT content FROM memories WHERE id=?`).get(b).content));
    const nextMsg = await call("task_next", { project: "global", as: "" });
    check("E5.blocked 不进可做集（task_next 不列可做）", !new RegExp(`#${b}\\b[\\s\\S]{0,80}可做`).test(nextMsg), "见 next 输出分段");

    /* ── F. 终态 + reopen（E-0 口径：reopened 为派生态） ── */
    const c = Number((await call("task_assign", { content: "生命周期验收任务 C（用于 reopen）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    await call("task_claim", { memory_id: c, as: "p26-life" });
    const reopenNonTerminal = await call("task_admin", { action: "reopen", memory_id: c, reason: "试" });
    check("F1.非终态任务 reopen 被拒（负路径）", !/已重开/.test(reopenNonTerminal), reopenNonTerminal.replace(/\s+/g, " ").slice(0, 80));
    check("F2.先完成（done）", /已完成/.test(await call("task_done", { memory_id: c, conclusion: "生命周期验收：完成" })) && headStatus(c) === "done", `head=${headStatus(c)}`);
    const cardC1 = cardOf(c);
    check("F3.★done 卡侧同步为 done", cardC1?.status === "done", `card=${cardC1?.status}`);
    const reopenNoReason = await call("task_admin", { action: "reopen", memory_id: c });
    check("F4.reopen 缺原因被拒（必填）", !/已重开/.test(reopenNoReason), reopenNoReason.replace(/\s+/g, " ").slice(0, 100));
    const reopenOk = await call("task_admin", { action: "reopen", memory_id: c, reason: "验收：结论被推翻需重做" });
    check("F5.reopen 后头=in_progress 且原因留痕（派生态不落库）", /已重开/.test(reopenOk) && headStatus(c) === "in_progress", `head=${headStatus(c)}｜${reopenOk.replace(/\s+/g, " ").slice(0, 60)}`);
    const cardC2 = cardOf(c);
    check("F6.★reopen 卡侧回 ready 且清锁", cardC2?.status === "ready" && !cardC2?.claim_lock, `card=${cardC2?.status}`);

    /* ── G. 实操复盘「立刻」档回归（2026-09-19）：按 id 列守卫 / supersede 头同步 / task_verify / 依赖死锁修复 ── */
    const dG = Number((await call("task_assign", { content: "守卫验收任务 D（列将被归档）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    const eG = Number((await call("task_assign", { content: "守卫验收任务 E（supersede loser）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    const fG = Number((await call("task_assign", { content: "守卫验收任务 F（supersede winner）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    const gG = Number((await call("task_assign", { content: "守卫验收任务 G（实际已完成待第三方验收）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    dbFix.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(dG); // 制造 P0 场景：头 pending、列 archived
    const claimArchived = await call("task_claim", { memory_id: dG });
    check("G1.★列已归档的头 pending 任务按 id 领取被拒（列守卫，P0#1）", /不可按 id 操作/.test(claimArchived) && headStatus(dG) === "pending", claimArchived.replace(/\s+/g, " ").slice(0, 90));
    await call("task_supersede", { memory_id: eG, superseded_by: fG });
    check("G2.★supersede 后 loser 头文本同步 [status:merged]（P0#2）", headStatus(eG) === "merged", `head=${headStatus(eG)}`);
    const claimMerged = await call("task_claim", { memory_id: eG });
    check("G3.merged 任务按 id 领取被拒（双保险）", /不可按 id 操作/.test(claimMerged), claimMerged.replace(/\s+/g, " ").slice(0, 90));
    const reopenMerged = await call("task_admin", { action: "reopen", memory_id: eG, reason: "试复活被取代任务" });
    check("G4.merged 任务不可 reopen（应操作 winner）", !/已重开/.test(reopenMerged), reopenMerged.replace(/\s+/g, " ").slice(0, 90));
    const asgBefore = (db.prepare(`SELECT content FROM memories WHERE id=?`).get(gG).content.match(/\[assignee:([^\]]*)\]/) ?? [])[1];
    const verifyMsg = await call("task_admin", { action: "verify", memory_id: gG, reason: "守卫验收：证据=smoke G5" });
    check("G5.★task_verify pending→done（不改归属不发租约）", /已验收关闭/.test(verifyMsg) && headStatus(gG) === "done", verifyMsg.replace(/\s+/g, " ").slice(0, 90));
    const asgAfter = (db.prepare(`SELECT content FROM memories WHERE id=?`).get(gG).content.match(/\[assignee:([^\]]*)\]/) ?? [])[1];
    check("G6.verify 不改归属（assignee 原样）", asgBefore === asgAfter, `${asgBefore}→${asgAfter}`);
    const cardG = cardOf(gG);
    check("G7.★verify 卡侧同步 done 且清锁", cardG?.status === "done" && !cardG?.claim_lock, `card=${cardG?.status} lock=${cardG?.claim_lock ?? "null"}`);
    const verifyEvt = db.prepare(`SELECT COUNT(*) n FROM memory_events WHERE memory_id=? AND op='task_verify'`).get(gG)?.n;
    check("G8.verify 事件留痕（verified_by，非 claim 噪音）", Number(verifyEvt) >= 1, `events=${verifyEvt}`);
    const verifyAgain = await call("task_admin", { action: "verify", memory_id: gG, reason: "重复验收" });
    check("G9.重复验收被拒（幂等负路径）", !/已验收关闭/.test(verifyAgain), verifyAgain.replace(/\s+/g, " ").slice(0, 90));
    // G10：依赖死锁修复 —— 依赖「头 done 但列归档」的任务不再永久阻塞
    const iG = Number((await call("task_assign", { content: "守卫验收任务 I（done 后列将被归档）", assignee: "p26-life", project: "global" })).match(/#(\d+)/)?.[1]);
    const hG = Number((await call("task_assign", { content: "守卫验收任务 H（依赖 I，I done 后应可做）", assignee: "p26-life", project: "global", depends_on: String(iG) })).match(/#(\d+)/)?.[1]);
    await call("task_claim", { memory_id: iG, as: "p26-life" });
    await call("task_done", { memory_id: iG, conclusion: "I 完成，随后列被归档（模拟归档不改头的存量场景）" });
    dbFix.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(iG);
    const nextAfterFix = await call("task_next", { project: "global", as: "" });
    const availSection = (nextAfterFix.split("可做（")[1] ?? "").split("阻塞（")[0] ?? "";
    const hAvail = new RegExp(`#${hG}\\b`).test(availSection);
    const hBlocked = new RegExp(`阻塞（[\\s\\S]*?#${hG}\\b`).test(nextAfterFix);
    check("G10.★依赖「头done列归档」不再永久阻塞（done 集按头判定）", hAvail && !hBlocked, `H 可做=${hAvail} 误阻塞=${hBlocked}`);

    /* ── H. 实操复盘「本周」档回归（2026-09-19）：assignee 白名单 / A1 凭据 / 会话隔离 / [task] 头强制 ── */
    const tidOf = (msg) => parseInt(String(msg).split("#")[1] ?? "0", 10) || 0;
    const badAsg = await call("task_assign", { content: "白名单探针任务（脏 assignee 应被拒）", assignee: "前端开发者", project: "global" });
    check("H1.assignee 脏值被拒（小写 kebab 白名单，#6）", !/已分派/.test(badAsg), badAsg.replace(/\s+/g, " ").slice(0, 80));
    const wMsg = await call("memory_write", { content: "[task][assignee:?][status:pending] 强制通道探针：以 memory_write 建任务", type: "convention", project: "global" });
    const wId = tidOf(wMsg);
    const wType = db.prepare(`SELECT type FROM memories WHERE id=?`).get(wId)?.type;
    check("H2.★[task] 头强制 type=task（修静默降级，#9）", wType === "task" && /已强制 task/.test(wMsg), `type=${wType}`);
    const fId = tidOf(await call("task_assign", { content: "凭据探针任务（A1）", assignee: "p26-life", project: "global" }));
    const forged = await call("task_claim", { memory_id: fId, credential: "deadbeefdeadbeefdeadbeefdeadbeef" });
    check("H3.A1 伪造凭据被拒（不属于该 agent，#8）", /A1 拒绝/.test(forged) && headStatus(fId) === "pending", forged.replace(/\s+/g, " ").slice(0, 80));
    const readCred = String(await call("memory_credential", { action: "issue", agent: "p26-life", scope: "read", ttl_hours: 1 })).split("：").pop().trim();
    const readTry = await call("task_claim", { memory_id: fId, credential: readCred });
    check("H4.A1 read-scope 凭据被拒（改写需 write）", /scope=read 不足/.test(readTry) && headStatus(fId) === "pending", readTry.replace(/\s+/g, " ").slice(0, 80));
    const writeCred = String(await call("memory_credential", { action: "issue", agent: "p26-life", scope: "write", ttl_hours: 1 })).split("：").pop().trim();
    const okClaim = await call("task_claim", { memory_id: fId, credential: writeCred, session_id: "sess-H5" });
    const claimEvt = JSON.parse(db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_claim' ORDER BY id DESC LIMIT 1`).get(fId)?.payload ?? "{}");
    check("H5.★A1 write 凭据认领成功（cred_id/session 落事件）", /已认领/.test(okClaim) && Number.isInteger(claimEvt.cred_id) && claimEvt.session_id === "sess-H5", `cred_id=${claimEvt.cred_id} session=${claimEvt.session_id}`);
    const nxt = await call("task_next", { project: "global", as: "p26-life", session_id: "sess-diff" });
    const mineSec = (nxt.split("我在做:")[1] ?? "").split("同名其他会话")[0];
    const otherSec = nxt.split("同名其他会话进行中")[1] ?? "";
    const inMine = mineSec.includes(`#${fId} `);
    const inOther = otherSec.includes(`#${fId} `);
    check("H6.★task_next 会话隔离（他会话任务单列「勿动」，#7）", !inMine && inOther, `本会话=${inMine} 他会话=${inOther}`);

    /* ── I. 结构性档回归（2026-09-19）：⟨state⟩ 结构化回执（#10）/ CAS 并发守卫 ── */
    const iA = tidOf(await call("task_assign", { content: "回执探针任务 A（claim 后查验 ⟨state⟩）", assignee: "p26-life", project: "global" }));
    const iClaim = await call("task_claim", { memory_id: iA });
    const iState = (iClaim.split("⟨state⟩ ")[1] ?? "").split("\n")[0];
    let iParsed = null;
    try { iParsed = JSON.parse(iState); } catch { /* 解析失败置 null */ }
    check("I1.★task_claim 回执含 ⟨state⟩ 终态行（#10）", iParsed?.op === "task_claim" && iParsed?.id === iA && iParsed?.status === "in_progress" && Number.isInteger(iParsed?.version), iState.slice(0, 120));
    const iV = tidOf(await call("task_assign", { content: "回执探针任务 B（verify 后查验 ⟨state⟩）", assignee: "p26-life", project: "global" }));
    const iVer = await call("task_admin", { action: "verify", memory_id: iV, reason: "回执断言" });
    const vParsed = (() => { try { return JSON.parse((iVer.split("⟨state⟩ ")[1] ?? "").split("\n")[0]); } catch { return null; } })();
    check("I2.★task_verify 回执含 verified_by 终态行", vParsed?.op === "task_verify" && vParsed?.verified_by === "p26-life" && vParsed?.status === "done", (vParsed ? JSON.stringify(vParsed) : "").slice(0, 120));
    const iW = await call("memory_write", { content: bodyFixture("回执探针：普通写入路径的结构化终态行（唯一性后缀 KZ7Q）"), type: "experience", project: "global" });
    const wParsed = (() => { try { return JSON.parse((iW.split("⟨state⟩ ")[1] ?? "").split("\n")[0]); } catch { return null; } })();
    check("I3.★memory_write 回执含 ⟨state⟩（id/type/version）", (wParsed?.op === "memory_write" || wParsed?.op === "memory_write_merged") && wParsed?.id > 0, (wParsed ? JSON.stringify(wParsed) : "").slice(0, 120));
    // CAS 并发守卫（黑盒模拟）：H5 已认领的 fId 版本被 dbFix 外部推进后，同版本 CAS 写必被拒
    const iC = tidOf(await call("task_assign", { content: "CAS 探针任务（过期 expected_version 认领应拒）", assignee: "p26-life", project: "global" }));
    // 注：黑盒冒烟插不进「server 读版本后、写前」的竞态窗口（CAS 在服务端单语句内原子完成）；
    // 此处回归其调用方契约形态：过期 expected_version 的认领必须被拒且零副作用。服务端 CAS 见 db.js updateMemory。
    const curV = db.prepare(`SELECT version FROM memories WHERE id=?`).get(iC)?.version ?? 0;
    const staleClaim = await call("task_claim", { memory_id: iC, expected_version: curV - 1 });
    check("I4.★过期 expected_version 认领被拒（fencing 契约，M5）", /版本漂移/.test(staleClaim) && headStatus(iC) === "pending", staleClaim.replace(/\s+/g, " ").slice(0, 90));

    db.close();
} catch (e) {
    fail++;
    console.log(`FAIL  冒烟异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
    proc.kill();
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}
console.log(`\n== P2-6 生命周期独立验收：${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
