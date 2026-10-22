import { randomBytes, createHash } from 'node:crypto';

// 仅状态变更。快照驻留内存，10 秒过期；比较完整记录避免覆盖其他 Agent 的更新。
export function registerMemoryBatch(app, ctx, { syncRules = () => {} } = {}) {
  const { db } = ctx;
  const pending = new Map();
  const fingerprint = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');
  const read = id => db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  const audit = (id, op, from, to) => db.prepare(
    'INSERT INTO daemon_log(task,op,memory_id,operator,detail) VALUES(?,?,?,?,?)'
  ).run('manual-batch', op, id, 'human:dashboard', JSON.stringify({ from, to }));
  const cleanup = () => { for (const [key, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(key); };
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function resync(rows) {
    if (!rows.some(r => r.type === 'rule')) return null;
    try { syncRules(db); return null; }
    catch { return '状态已更新，规则同步失败，请在规则页重新同步'; }
  }
  app.post('/api/memory/batch-status', async (req, reply) => {
    cleanup();
    if (ctx.RESTRICTED) return reply.code(403).send({ ok: false, error: '受限模式禁止批量状态写入' });
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length ||
        !['active', 'archived', 'rejected', 'superseded'].includes(status)) {
      return reply.code(400).send({ ok: false, error: '需提供 1–500 个不重复的记忆编号及合法状态' });
    }
    if (pending.size >= 256) return reply.code(429).send({ ok: false, error: '待撤销操作过多，请稍后重试' });
    let changed;
    try {
      changed = transaction(() => {
        const rows = ids.map(read);
        if (rows.some(r => !r)) throw Object.assign(new Error('部分记忆已不存在，未作任何修改'), { statusCode: 409 });
        return rows.filter(r => r.status !== status).map(before => {
          db.prepare('UPDATE memories SET status=?,version=version+1 WHERE id=?').run(status, before.id);
          audit(before.id, 'status', before.status, status);
          return { before, after: fingerprint(read(before.id)) };
        });
      });
    } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ ok: false, error: e.message });
      throw e;
    }
    const undoId = changed.length ? randomBytes(24).toString('hex') : null;
    const expiresAt = Date.now() + 10000;
    if (undoId) pending.set(undoId, { changed, expiresAt });
    const warning = resync(changed.map(x => x.before));
    // 同步规则可能修改 inject 等字段；以最终提交后的记录作为并发比较基线。
    for (const item of changed) item.after = fingerprint(read(item.before.id));
    return { ok: true, changed: changed.length, undoId, expiresAt, warning };
  });
  app.post('/api/memory/batch-undo', async (req, reply) => {
    cleanup();
    if (ctx.RESTRICTED) return reply.code(403).send({ ok: false, error: '受限模式禁止撤销写入' });
    const undoId = req.body?.undoId;
    if (typeof undoId !== 'string' || !/^[a-f0-9]{48}$/.test(undoId)) return reply.code(400).send({ ok: false, error: '撤销编号不合法' });
    const item = pending.get(undoId);
    if (!item) return reply.code(410).send({ ok: false, error: '撤销已过期或已使用' });
    try {
      transaction(() => {
        for (const entry of item.changed) {
          const now = read(entry.before.id);
          if (!now || fingerprint(now) !== entry.after) throw Object.assign(new Error('记忆已被其他操作修改，撤销已阻止；没有覆盖新数据'), { statusCode: 409 });
        }
        for (const { before } of item.changed) {
          const current = read(before.id);
          db.prepare('UPDATE memories SET status=?,version=version+1 WHERE id=?').run(before.status, before.id);
          audit(before.id, 'undo', current.status, before.status);
        }
      });
    } catch (e) {
      if (e.statusCode) return reply.code(e.statusCode).send({ ok: false, error: e.message });
      throw e;
    }
    pending.delete(undoId);
    return { ok: true, restored: item.changed.length, warning: resync(item.changed.map(x => x.before)) };
  });
}
