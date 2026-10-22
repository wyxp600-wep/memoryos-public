/**
 * 任务交接状态机单测（db 层，与 server.js 三工具同源逻辑）
 * 复刻工具内约定：content 头 `[task][assignee:X][status:open|claimed|done]`
 * 用例：T1 写好头 + FTS 可检索；T2 open→claimed；T3 claimed→done；T4 非法任务不匹配
 * 用法：node dist/smoke-task.js
 */
import { openDb, writeMemory, readMemory, createDispatch, readActiveDispatch, readDispatchByKey, settleDispatch } from "./db.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `mem-task-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
// 与 server.js 同源（保持口径一致）
const TASK_HEAD_RE = /^\[task\]\[assignee:[^\]]*\]\[status:(open|claimed|done)\]/;
const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
const taskHead = (s, a) => `[task][assignee:${a}][status:${s}]`;
function readState(c) {
    const m = c.match(TASK_HEAD_RE);
    if (!m)
        return null;
    const am = c.match(/\[assignee:([^\]]*)\]/);
    const dm = c.match(TASK_DEP_RE);
    const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
    return { assignee: am ? am[1] : "?", status: m[1], deps };
}
// 依赖满足判定（同 task_next 可做集判据）：依赖中所有 id 都在 done 集合里
function depsSatisfied(deps, done) {
    return deps.every((d) => done.has(d));
}
try {
    const db = openDb(dbPath);
    const r = writeMemory(db, {
        content: `${taskHead("open", "codex")} 排查 Ozon API scope 未开通导致 404`,
        type: "task", agent: "trae", agent_fpath: null, project: "global",
    });
    // T1: 状态头正确 + FTS 可检索（LIKE 兜底）
    const st1 = readState(r.content);
    check("T1.open 状态头正确", st1?.status === "open" && st1?.assignee === "codex", JSON.stringify(st1));
    const hit = db.prepare(`SELECT COUNT(*) c FROM memories_fts WHERE content LIKE '%Ozon%'`).get().c;
    check("T1.FTS 可检索", hit >= 1, `fts=${hit}`);
    // T2: open→claimed（updateMemory 同步 FTS）
    const claimed = `${taskHead("claimed", "codex")} ${r.content.replace(TASK_HEAD_RE, "").trim()}`;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(claimed, r.id);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(claimed, r.id);
    const st2 = readState(readMemory(db, r.id).content);
    check("T2.claimed 状态头", st2?.status === "claimed", JSON.stringify(st2));
    // T3: claimed→done
    const done = `${taskHead("done", "codex")} ${claimed.replace(TASK_HEAD_RE, "").trim()}\n→ 结论：scope 未开通，需向平台申请权限`;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(done, r.id);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(done, r.id);
    const doneRow = readMemory(db, r.id);
    const st3 = readState(doneRow.content);
    check("T3.done 状态头 + 结论追加", st3?.status === "done" && doneRow.content.includes("结论"), `status=${st3?.status}`);
    // T4: 非任务语法不匹配
    check("T4.普通记忆不误匹配任务头", readState("这是一条普通记忆") === null);
    // T4b: 状态非法不匹配
    check("T4b.非法状态不匹配", readState(`${taskHead("open", "x").replace("open", "bogus")} y`) === null);
    // T5: 依赖头解析（A 无依赖，B 依赖 A）
    const a = writeMemory(db, { content: `${taskHead("open", "codex")} 设计接口`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const b = writeMemory(db, { content: `${taskHead("open", "claude")} [depends:${a.id}] 实现接口`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const stA = readState(readMemory(db, a.id).content);
    const stB = readState(readMemory(db, b.id).content);
    check("T5.depends 头解析", stB?.deps.length === 1 && stB.deps[0] === a.id && stA?.deps.length === 0, `Adeps=${stA?.deps} Bdeps=${stB?.deps}`);
    // T6: 依赖拓扑可做集判据——B 依赖 A，A 未 done 则 B 不可做；A done 后 B 可做
    const doneIds = new Set();
    check("T6a.A 未完成 → B 依赖不满足", depsSatisfied(stB.deps, doneIds) === false);
    doneIds.add(a.id);
    check("T6b.A 完成后 → B 依赖满足(可做)", depsSatisfied(stB.deps, doneIds) === true);
    // T7: 依赖段在 claim/done 状态流转中保留（body replace 不丢 depends）
    const b2 = writeMemory(db, { content: `${taskHead("open", "claude")} [depends:${a.id}] 写测试`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const claimedB2 = `${taskHead("claimed", "claude")} [depends:${a.id}] 写测试`;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(claimedB2, b2.id);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(claimedB2, b2.id);
    const stB2 = readState(readMemory(db, b2.id).content);
    check("T7.状态流转保留 depends", stB2?.status === "claimed" && stB2.deps.includes(a.id), JSON.stringify(stB2));
    // ── ★ 2026-10-02 Dispatch 语义（对标 orca「one authoritative Task attempt」）──
    //   权威只来自 active dispatch；idx_dispatches_active 机器保证「一任务同时只有一个 active 尝试」。
    const dt = writeMemory(db, { content: `${taskHead("open", "codex")} dispatch 语义样例`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const d1 = createDispatch(db, { key: "aaaa1111bbbb", memoryId: dt.id, agent: "codex", sessionId: "sess-1", credentialId: null, leaseMinutes: 10 });
    check("T8a.首次 dispatch 建 active（generation=1）", d1.generation === 1 && d1.superseded === null, JSON.stringify(d1));
    const ac1 = readActiveDispatch(db, dt.id);
    check("T8b.readActiveDispatch 命中且带会话身份", ac1?.dispatch_key === "aaaa1111bbbb" && ac1?.session_id === "sess-1" && ac1?.state === "active", JSON.stringify({ k: ac1?.dispatch_key, s: ac1?.session_id }));
    const d2 = createDispatch(db, { key: "cccc2222dddd", memoryId: dt.id, agent: "claude", leaseMinutes: 10 });
    check("T8c.二次认领=接管（generation=2 + 旧被取代）", d2.generation === 2 && d2.superseded === d1.id, JSON.stringify(d2));
    const old1 = readDispatchByKey(db, "aaaa1111bbbb");
    check("T8d.旧 dispatch 已 superseded 且指向新代", old1?.state === "superseded" && old1?.superseded_by === d2.id, JSON.stringify({ s: old1?.state, by: old1?.superseded_by }));
    const ac2 = readActiveDispatch(db, dt.id);
    check("T8e.同一任务同时只有一个 active", ac2?.dispatch_key === "cccc2222dddd", String(ac2?.dispatch_key));
    const staleSettle = settleDispatch(db, d1.id, "succeeded", "越权结算");
    check("T8f.对已 superseded 的 dispatch 结算被拒（权威只来自 active）", staleSettle === false);
    const okSettle = settleDispatch(db, d2.id, "succeeded", "task_done by claude");
    const settled = readDispatchByKey(db, "cccc2222dddd");
    check("T8g.active dispatch 结算成功（outcome 落库）", okSettle === true && settled?.state === "settled" && settled?.outcome === "succeeded", JSON.stringify({ s: settled?.state, o: settled?.outcome }));
    const d3 = createDispatch(db, { key: "eeee3333ffff", memoryId: dt.id, agent: "codex", leaseMinutes: 10 });
    check("T8h.结算后再认领 generation 单调递增（不复用旧世代）", d3.generation === 3 && d3.superseded === null, JSON.stringify(d3));
    settleDispatch(db, d3.id, "whatever", null);
    check("T8i.outcome 归一（非 failed 一律 succeeded）", readDispatchByKey(db, "eeee3333ffff")?.outcome === "succeeded");
    // ── ★ 2026-10-03 批次 A1：六处写入点 dispatch 权威「软模式」（与 server-reg-task.js softDispatchNotice 同源复刻）──
    //   软模式定义：不传 / 传错 dispatch_key 一律**放行**，只回提示；四项判据全过 → 返回空串（静默）。
    //   注：真实实现每条提示自带前导 "\n"（让 ⟨state⟩ JSON 独立成行，见 server-reg-task.js 注）；此处只验判据表，故略去换行。
    const softDispatchNotice = (memoryId, dispatchKey, who) => {
        const active = readActiveDispatch(db, memoryId);
        if (!dispatchKey)
            return active ? `已有 active dispatch（持有者 ${active.agent}）` : `当前无 active dispatch`;
        const d = readDispatchByKey(db, dispatchKey);
        if (!d)
            return `dispatch 不存在`;
        if (Number(d.memory_id) !== Number(memoryId))
            return `dispatch 归属任务 #${d.memory_id}`;
        if (d.state !== "active")
            return `dispatch 已 ${d.state}`;
        if (d.agent !== who)
            return `dispatch 由 ${d.agent} 持有`;
        return "";
    };
    // T8j：结算完（无 active）且未携带 key → 提示「无 active dispatch」
    check("T8j.软模式·无 key + 无 active → 提示无权威锚点", softDispatchNotice(dt.id, null, "codex").includes("当前无 active dispatch"), softDispatchNotice(dt.id, null, "codex"));
    const d4 = createDispatch(db, { key: "1357ace91357", memoryId: dt.id, agent: "codex", leaseMinutes: 10 });
    // T8k：携带有效 key（active + 同任务 + 同持有者）→ 静默（空串）
    check("T8k.软模式·有效 key → 静默放行", softDispatchNotice(dt.id, d4.key, "codex") === "", JSON.stringify(softDispatchNotice(dt.id, d4.key, "codex")));
    // T8l：key 不存在 → 提示
    check("T8l.软模式·key 不存在 → 提示", softDispatchNotice(dt.id, "ffffffffffff", "codex").includes("不存在"));
    // T8m：key 属别的任务 → 提示归属（跨任务写入）
    const dt2 = writeMemory(db, { content: `${taskHead("open", "claude")} 软模式跨任务反例`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    check("T8m.软模式·跨任务 key → 提示归属", softDispatchNotice(dt2.id, d4.key, "codex").includes(`归属任务 #${dt.id}`), softDispatchNotice(dt2.id, d4.key, "codex"));
    // T8n：key 已被结算（非 active）→ 提示已 settled
    check("T8n.软模式·已结算 key → 提示已 settled", softDispatchNotice(dt.id, "eeee3333ffff", "codex").includes("已 settled"));
    // T8o：有 active 但未携带 key → 提示持有者（legacy 调用方可观测到自己没带权威锚点）
    check("T8o.软模式·无 key + 有 active → 提示持有者", softDispatchNotice(dt.id, null, "claude").includes("已有 active dispatch") && softDispatchNotice(dt.id, null, "claude").includes("codex"));
    settleDispatch(db, d4.id, "succeeded", "A1 用例收尾");
    // ── ★ 2026-10-03 批次 A3：heartbeat 回执带 `fenced` 位（与 server-reg-task.js fencedLine 同源复刻布尔判据）──
    //   fenced 语义：调用方持有的 dispatch 是否已被取代 —— ①其 state 已 superseded，或 ②当前 active 不是它。
    //   二者任一即 true；定位不到调用方 dispatch（legacy 无票且无历史）返回 null（实现里表现为「不加 fenced 行」）。
    const fencedOf = (memoryId, dispatchKey, who) => {
        const active = readActiveDispatch(db, memoryId);
        let mine = dispatchKey ? readDispatchByKey(db, dispatchKey) : null;
        if (!mine)
            mine = db.prepare(`SELECT * FROM dispatches WHERE memory_id=? AND agent=? ORDER BY generation DESC LIMIT 1`).get(Number(memoryId), String(who)) ?? null;
        if (!mine)
            return null;
        return String(mine.state) === "superseded" || (active != null && Number(active.id) !== Number(mine.id));
    };
    const dt3 = writeMemory(db, { content: `${taskHead("open", "codex")} fenced 位样例`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const f1 = createDispatch(db, { key: "aaaabbbbcccc", memoryId: dt3.id, agent: "codex", leaseMinutes: 10 });
    const f2 = createDispatch(db, { key: "ddddeeeeffff", memoryId: dt3.id, agent: "claude", leaseMinutes: 10 });
    // T8p：换代后旧持有者带旧票 → fenced=true（A3 的核心用例：被取代者下一次心跳即得知）
    check("T8p.fenced·旧票（已被取代）→ true", fencedOf(dt3.id, f1.key, "codex") === true, JSON.stringify({ p: fencedOf(dt3.id, f1.key, "codex"), f1: f1.generation, f2: f2.generation }));
    // T8q：当前权威带自己的票 → fenced=false
    check("T8q.fenced·当前权威票 → false", fencedOf(dt3.id, f2.key, "claude") === false, JSON.stringify({ q: fencedOf(dt3.id, f2.key, "claude") }));
    // T8r：无票回退按 (memory_id, agent) 定位最新 → codex 最新仍是已 superseded 的 gen1 → true
    check("T8r.fenced·无票回退定位（旧持有者）→ true", fencedOf(dt3.id, null, "codex") === true, JSON.stringify({ r: fencedOf(dt3.id, null, "codex") }));
    // ── ★ 2026-10-03 批次 A2：task_next「待处理」段（与 server-reg-task.js 待决策段同源复刻取数口径）──
    //   入栏判据（两条并列，任一中即入栏）：① dispatch.state='active' 且租约已过期；② 卡片 status='running' 且已贴提醒条。
    //   设计语义（Orca J2）：到期/沉默只是检查点，不授权回收 —— 但必须显式可见，否则无人裁决 = 永久积压。
    //   负例同样重要：未过期不得入栏，避免「所有 active 都被列出」的过度上报把真问题淹没。
    const pendingOf = () => {
        const out = [];
        const overdue = db.prepare(`SELECT memory_id, agent FROM dispatches
           WHERE state='active' AND julianday(lease_expires_at) < julianday('now')`).all();
        for (const o of overdue)
            out.push({ via: "lease", mid: Number(o.memory_id), who: o.agent });
        const noticed = db.prepare(`SELECT c.id AS card_id, c.assignee FROM cards c
           WHERE c.status='running' AND c.lease_notice_at IS NOT NULL`).all();
        for (const n of noticed)
            out.push({ via: "notice", card: Number(n.card_id), who: n.assignee });
        return out;
    };
    const dt4 = writeMemory(db, { content: `${taskHead("open", "codex")} 待决策栏样例·租约过期`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const d5 = createDispatch(db, { key: "999988887777", memoryId: dt4.id, agent: "codex", leaseMinutes: 10 });
    check("T8s.待决策·租约未过期 → 不入栏", !pendingOf().some((x) => x.via === "lease" && x.mid === dt4.id), JSON.stringify(pendingOf()));
    db.prepare(`UPDATE dispatches SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours') WHERE id=?`).run(d5.id);
    check("T8t.待决策·租约过期仍 active → 入栏", pendingOf().some((x) => x.via === "lease" && x.mid === dt4.id && x.who === "codex"), JSON.stringify(pendingOf()));
    const cardIns = db.prepare(`INSERT INTO cards(board, kind, title, status, assignee, lease_expires_at, lease_notice_at)
       VALUES('default','task','待决策栏样例卡','running','claude',strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-18 hours'))`).run();
    check("T8u.待决策·已贴提醒条 → 入栏", pendingOf().some((x) => x.via === "notice" && x.card === Number(cardIns.lastInsertRowid) && x.who === "claude"), JSON.stringify(pendingOf()));
    db.close();
}
finally {
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"])
        try {
            fs.rmSync(p, { force: true });
        }
        catch { }
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
