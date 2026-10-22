#!/usr/bin/env node
/**
 * MemoryOS — P2-5（E-1 / MACP 强一致字段 + 资源锁）schema 冒烟
 *
 * 覆盖：
 *   A. 迁移落地：memories / cards 各 5 个 MACP 列齐备；resource_locks 表与索引存在
 *   B. 迁移幂等：同一库连续 openDb 两次不报错、列不重复
 *   C. 资源锁互斥：**部分唯一索引**保证「同资源同时刻仅一把活跃锁」；释放后可再获取
 *   D. 租约接管语义：过期锁可被接管，新行 fencing_token 递增、旧行补 released_at（不硬删，可追溯）
 *   E. 幂等键：同 key 二次写入被拒；NULL 不受唯一约束（存量与普通写入不受影响）
 *   F. E-0 裁决口径：持久状态集合与派生态（依赖阻塞/重开）不落库（以 task 头归一化集合为准）
 *
 * 纪律：全部动作在临时库内（绝不触碰生产库）；生产库迁移见 .workbuddy/tmp/macp-migrate.mjs。
 * 用法：cd resources/memoryos && node dist/smoke-macp.js     退出码 0/1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, writeMemory, readMemory } from "./db.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
};
const MACP = ["version", "fencing_token", "epoch", "idempotency_key", "causal_parent"];
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-macp-"));
const DB = path.join(ws, "macp.db");

try {
    const db = openDb(DB);

    /* ── A. 迁移落地 ── */
    const memCols = db.prepare(`PRAGMA table_info(memories)`).all().map((c) => c.name);
    const cardCols = db.prepare(`PRAGMA table_info(cards)`).all().map((c) => c.name);
    check("A1.memories 具备 5 个 MACP 列", MACP.every((c) => memCols.includes(c)), MACP.filter((c) => !memCols.includes(c)).join(",") || "5/5");
    check("A2.cards 具备 5 个 MACP 列", MACP.every((c) => cardCols.includes(c)), MACP.filter((c) => !cardCols.includes(c)).join(",") || "5/5");
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    check("A3.resource_locks 表已建", tables.includes("resource_locks"));
    const idx = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN ('idx_resource_locks_active','idx_resource_locks_holder','idx_resource_locks_expiry','idx_memories_idem','idx_cards_idem')`).all();
    const idxNames = idx.map((r) => r.name);
    check("A4.资源锁与幂等索引齐备", ["idx_resource_locks_active", "idx_resource_locks_holder", "idx_resource_locks_expiry", "idx_memories_idem", "idx_cards_idem"].every((n) => idxNames.includes(n)), idxNames.join(","));
    check("A5.活跃锁唯一索引是**部分索引**（仅约束 released_at IS NULL）", /WHERE\s+released_at\s+IS\s+NULL/i.test(idx.find((r) => r.name === "idx_resource_locks_active")?.sql ?? ""));

    /* ── B. 迁移幂等 ── */
    db.close();
    const db2 = openDb(DB);
    const memCols2 = db2.prepare(`PRAGMA table_info(memories)`).all().map((c) => c.name);
    check("B1.二次打开幂等（列不重复、无异常）", memCols2.filter((c) => c === "version").length === 1 && MACP.every((c) => memCols2.includes(c)));
    db2.close();
    const db3 = openDb(DB);

    /* ── C. 资源锁互斥 + 释放后可再获取 ── */
    const acq = (resource, holder, token = 0, expires = "2099-01-01T00:00:00Z") =>
        db3.prepare(`INSERT INTO resource_locks(resource,holder,fencing_token,expires_at) VALUES(?,?,?,?)`).run(resource, holder, token, expires);
    acq("file:/tmp/x.js", "agentA");
    let blocked = false;
    try { acq("file:/tmp/x.js", "agentB"); } catch { blocked = true; }
    check("C1.同资源第二把活跃锁被数据库拒绝（非约定，是约束）", blocked);
    const activeCount = db3.prepare(`SELECT COUNT(*) c FROM resource_locks WHERE resource=? AND released_at IS NULL`).get("file:/tmp/x.js").c;
    check("C2.活跃锁始终只有 1 把", activeCount === 1, `active=${activeCount}`);
    db3.prepare(`UPDATE resource_locks SET released_at=datetime('now') WHERE resource=? AND released_at IS NULL`).run("file:/tmp/x.js");
    acq("file:/tmp/x.js", "agentB", 1);
    const active2 = db3.prepare(`SELECT COUNT(*) c FROM resource_locks WHERE resource=? AND released_at IS NULL`).get("file:/tmp/x.js").c;
    const history = db3.prepare(`SELECT COUNT(*) c FROM resource_locks WHERE resource=?`).get("file:/tmp/x.js").c;
    check("C3.释放后可重新获取，且历史行保留（可追溯）", active2 === 1 && history === 2, `active=${active2} history=${history}`);

    /* ── D. 租约接管语义 ── */
    acq("port:8787", "agentA", 0, "2000-01-01T00:00:00Z");           // 已过期
    const expired = db3.prepare(`SELECT id,fencing_token FROM resource_locks WHERE resource='port:8787' AND released_at IS NULL`).get();
    // 接管：先释放旧行，再以 token+1 写入新行（P2-6 工具将按此实现）
    db3.prepare(`UPDATE resource_locks SET released_at=datetime('now') WHERE id=?`).run(expired.id);
    acq("port:8787", "agentC", expired.fencing_token + 1);
    const takeover = db3.prepare(`SELECT fencing_token,holder FROM resource_locks WHERE resource='port:8787' AND released_at IS NULL`).get();
    check("D1.过期锁可被接管，fencing_token 递增", takeover.fencing_token === 1 && takeover.holder === "agentC", `token=${takeover.fencing_token} holder=${takeover.holder}`);
    check("D2.被接管的旧行未被删除（审计可追溯）", db3.prepare(`SELECT COUNT(*) c FROM resource_locks WHERE resource='port:8787'`).get().c === 2);

    /* ── E. 幂等键 ── */
    const w = (content, idem) => writeMemory(db3, {
        content, type: "experience", agent: "macp-smoke", agent_fpath: null, project: "global", embedding: null, idempotency_key: idem ?? null,
    });
    w("幂等键样本：端口 80 迁移默认站点绑定", "macp-key-1");
    let dupRejected = false;
    try { w("幂等键样本：端口 80 迁移默认站点绑定", "macp-key-1"); } catch { dupRejected = true; }
    check("E1.同 idempotency_key 二次写入被拒", dupRejected);
    w("无序样本 A", null);
    w("无序样本 B", null);
    check("E2.NULL 幂等键不受唯一约束（存量与普通写入不受影响）", db3.prepare(`SELECT COUNT(*) c FROM memories WHERE idempotency_key IS NULL`).get().c >= 2);

    /* ── F. 写入不受 MACP 列影响（默认值语义） ── */
    const r = readMemory(db3, 1);
    check("F1.新写入行 version=1 / fencing_token=0 / epoch 为空（默认值语义）", r.version === 1 && r.fencing_token === 0 && (r.epoch == null || r.epoch === ""), `v=${r.version} ft=${r.fencing_token} epoch=${JSON.stringify(r.epoch)}`);


    /* ── G. P2-6（C-3/C-5）：租约回收守护 + 三方对账守护 ── */
    const { reapExpiredLeases } = await import("./daemon.js");
    const { reconcileTasksAndCards } = await import("./reconcile.js");
    // G1 过期租约回收（C-3）
    db3.prepare(`INSERT INTO cards(board,kind,title,body,status,assignee,claim_lock,lease_expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run("default", "task", "租约回收样本", "smoke", "running", "agentA", "lock-expired-1", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
    const expiredCardId = Number(db3.prepare(`SELECT id FROM cards WHERE claim_lock=?`).get("lock-expired-1").id);
    // ★ 一致性⑦（2026-09-19）→ ★ 批次 B1（2026-10-03）：租约到期两阶段 —— 到期「贴条」不抢回，超期「只标不回收」（⑧ 缺席不授权销毁）
    const rp1 = reapExpiredLeases(db3);
    const afterNotice = db3.prepare(`SELECT status, assignee, claim_lock, lease_notice_at FROM cards WHERE id=?`).get(expiredCardId);
    check("G1a.过期租约贴条不抢回（running 保持 + 锁保留 + notice 标记）", rp1.noticed >= 1 && afterNotice.status === "running" && afterNotice.claim_lock === "lock-expired-1" && !!afterNotice.lease_notice_at, `noticed=${rp1.noticed} status=${afterNotice.status} notice=${!!afterNotice.lease_notice_at}`);
    check("G1b.贴条留 card_events 事件（可审计）", db3.prepare(`SELECT COUNT(*) c FROM card_events WHERE card_id=? AND action=?`).get(expiredCardId, "lease_expired").c >= 1);
    const rp2 = reapExpiredLeases(db3);
    check("G1c.贴条幂等（再跑无新增）", rp2.noticed === 0, `noticed=${rp2.noticed}`);
    // G1d 贴条超期（notice 时间回拨 + grace=0）→ **只标不回收**（批次 B1；⑧ absence never authorizes destruction）
    //   该样本卡无关联任务记忆 → 走孤儿卡路径：只打 lease_stale_at 裁决标记，running/锁/归属全保留。
    db3.prepare(`UPDATE cards SET lease_notice_at=? WHERE id=?`).run("2000-01-01T00:00:00.000Z", expiredCardId);
    const rp3 = reapExpiredLeases(db3, { graceHours: 0 });
    const afterStale = db3.prepare(`SELECT status, assignee, claim_lock, lease_notice_at, lease_stale_at FROM cards WHERE id=?`).get(expiredCardId);
    check("G1d.贴条超期只标不回收（running 保持 + 锁/归属保留 + 打 lease_stale_at）", rp3.staled >= 1 && rp3.reclaimed === 0 && afterStale.status === "running" && afterStale.assignee === "agentA" && afterStale.claim_lock === "lock-expired-1" && !!afterStale.lease_stale_at, `staled=${rp3.staled} reclaimed=${rp3.reclaimed} status=${afterStale.status} stale=${!!afterStale.lease_stale_at}`);
    check("G1e.只标留 lease_stale 事件、不再产生 lease_reclaimed", db3.prepare(`SELECT COUNT(*) c FROM card_events WHERE card_id=? AND action=?`).get(expiredCardId, "lease_stale").c >= 1 && db3.prepare(`SELECT COUNT(*) c FROM card_events WHERE card_id=? AND action=?`).get(expiredCardId, "lease_reclaimed").c === 0, "lease_stale≥1 且 lease_reclaimed=0");
    const rp4 = reapExpiredLeases(db3, { graceHours: 0 });
    check("G1f.裁决标记幂等（再跑 0 新增；lease_stale_at 兼作幂等键）", rp4.staled === 0 && rp4.reclaimed === 0, `staled=${rp4.staled} reclaimed=${rp4.reclaimed}`);
    // G2 投影重建（C-5）：任务记忆无卡 → 补建
    const taskRow = writeMemory(db3, { content: "[task][assignee:?][status:pending] 对账样本：无卡任务", type: "task", agent: "macp-smoke", agent_fpath: null, project: "global", embedding: null });
    const rc1 = reconcileTasksAndCards(db3);
    const rel = db3.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation=?`).get(taskRow.id, "dispatch");
    check("G2a.无卡任务被投影重建（建卡 + dispatch 关联）", rc1.created >= 1 && !!rel, `created=${rc1.created} card=${rel?.card_id ?? "none"}`);
    check("G2b.重建留 reconcile_created 事件", !!rel && db3.prepare(`SELECT COUNT(*) c FROM card_events WHERE card_id=? AND action=?`).get(rel.card_id, "reconcile_created").c >= 1);
    const rc2 = reconcileTasksAndCards(db3);
    check("G2c.对账幂等（再跑 0 建卡 0 对齐）", rc2.created === 0 && rc2.aligned === 0, `created=${rc2.created} aligned=${rc2.aligned}`);
    // G3 状态对齐（C-5）：记忆头 in_progress ↔ 卡片 ready 失配 → 修复
    db3.prepare(`UPDATE memories SET content=? WHERE id=?`).run("[task][assignee:macp-smoke][status:in_progress] 对账样本：无卡任务", taskRow.id);
    db3.prepare(`UPDATE cards SET status=?, updated_at=? WHERE id=?`).run("ready", new Date(Date.now() - 30 * 60000).toISOString(), rel.card_id);
    const rc3 = reconcileTasksAndCards(db3);
    const fixed = db3.prepare(`SELECT status FROM cards WHERE id=?`).get(rel.card_id);
    check("G3a.失配被修复（头 in_progress → 卡 running）", rc3.aligned >= 1 && fixed.status === "running", `aligned=${rc3.aligned} card=${fixed.status}`);
    check("G3b.镜像滞后 >5min 触发 daemon_log 告警", db3.prepare(`SELECT COUNT(*) c FROM daemon_log WHERE task=? AND op=?`).get("reconcile", "lag").c >= 1);
    db3.close();
} catch (e) {
    fail++;
    console.log(`FAIL  冒烟异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}
console.log(`\n== MACP 冒烟（P2-5 schema + P2-6 生命周期/守护）：${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
