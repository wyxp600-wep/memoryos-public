import { memoryFields, bodyCTE } from './memory-fields.js';
/** 正文为唯一来源；关键词索引可重建，纯 SQLite 触发器兼容其它写入连接。 */
export const KEYWORD_LIMIT = 8;
export const KEYWORD_CHAR_LIMIT = 160;
export function keywordNorm(s) { return String(s).trim().replace(/[A-Z]/g, c => c.toLowerCase()); }
export function keywordLine(content) {
    return memoryFields(content).find(f=>f.name==='关键词')?.value ?? null;
}
export function parseKeywords(content) {
    const line=keywordLine(content);
    return line==null?[]:[...new Map(line.split(/[;；,，|]/).map(s=>s.trim()).filter(Boolean).map(s=>[keywordNorm(s),s])).values()];
}
export function keywordErrors(content,{strict=false}={}) {
    const fields=memoryFields(content),keys=fields.filter(f=>f.name==='关键词');
    if(!keys.length)return strict?['缺少关键词字段']:[];
    if(keys.length!==1)return ['关键词字段只能出现一次'];
    const key=keys[0],line=key.value,values=line.split(/[;；,，|]/).map(s=>s.trim());
    if(!(key.index>(fields.find(f=>f.name==='结论')?.index??Infinity)&&key.index<(fields.find(f=>f.name==='适用范围')?.index??-1)))return ['关键词须位于结论之后、适用范围之前'];
    if(line.includes('\n')||line.length>160||values.length>(strict?5:8)||values.length<(strict?3:1)||values.some(v=>!v||v.length>80))return [strict?'关键词须为3～5个非空词，每词≤80字，总长≤160字':'关键词须为1～8个非空词，每词≤80字，总长≤160字'];
    if(new Set(values.map(keywordNorm)).size!==values.length)return ['关键词不可重复'];
    return [];
}
export function keywordCTE(expr) {
    return `${bodyCTE(expr)}, kd(s) AS (SELECT char(10)||s||char(10) FROM body_norm),
      kp(s,p,q) AS (SELECT s,instr(s,char(10)||'关键词:'),instr(s,char(10)||'适用范围:') FROM kd),
      kl(v) AS (SELECT substr(s,p+5,q-p-5) FROM kp WHERE p>0 AND q>p),
      kv(v) AS (SELECT replace(replace(replace(replace(v,'；',';'),'，',';'),',',';'),'|',';') FROM kl),
      parts(rest,term) AS (SELECT trim(v)||';',NULL FROM kv UNION ALL SELECT substr(rest,instr(rest,';')+1),trim(substr(rest,1,instr(rest,';')-1),char(9)||char(32)||char(160)||char(12288)||char(65279)) FROM parts WHERE instr(rest,';')>0)`;
}
export function keywordValidationSQL(expr,strict=false) {
    return `${keywordCTE(expr)}, ks(n,p,s) AS (SELECT (length(s)-length(replace(s,char(10)||'关键词:','')))/5,instr(s,char(10)||'关键词:'),s FROM kd)
      SELECT CASE WHEN ${strict?'NOT EXISTS(SELECT 1 FROM ks WHERE n=1) OR ':''}EXISTS(SELECT 1 FROM ks WHERE n>0 AND (n!=1 OR p<=instr(s,char(10)||'结论:') OR p>=instr(s,char(10)||'适用范围:')
       OR NOT EXISTS(SELECT 1 FROM kl) OR instr(trim((SELECT v FROM kl)),char(10))>0
       OR length(trim((SELECT v FROM kl)))>160 OR (SELECT count(*) FROM parts WHERE term IS NOT NULL)>${strict?5:8}
       OR (SELECT count(*) FROM parts WHERE term IS NOT NULL)<${strict?3:1}
       OR EXISTS(SELECT 1 FROM parts WHERE term IS NOT NULL AND (length(term)=0 OR length(term)>80))
       OR (SELECT count(*) FROM parts WHERE term IS NOT NULL)!=(SELECT count(DISTINCT lower(term)) FROM parts WHERE term IS NOT NULL))) THEN 0 ELSE 1 END`;
}
export function installKeywordIndex(db) {
    db.exec('SAVEPOINT keyword_index_install');
    try {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_keywords(
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      term_norm TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY(memory_id,term_norm));
      CREATE INDEX IF NOT EXISTS idx_memory_keywords_term ON memory_keywords(term_norm,memory_id);
      CREATE TABLE IF NOT EXISTS keyword_index_meta(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
      INSERT OR IGNORE INTO keyword_index_meta VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS keyword_epoch_insert AFTER INSERT ON memory_keywords BEGIN UPDATE keyword_index_meta SET epoch=epoch+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS keyword_epoch_delete AFTER DELETE ON memory_keywords BEGIN UPDATE keyword_index_meta SET epoch=epoch+1 WHERE id=1; END;`);
    db.exec('DROP TRIGGER IF EXISTS keyword_body_v1_insert; DROP TRIGGER IF EXISTS keyword_body_v1_update; DROP TRIGGER IF EXISTS keyword_body_v2_insert; DROP TRIGGER IF EXISTS keyword_body_v2_update;');
    for (const [suffix,event] of [['insert','INSERT'],['update','UPDATE OF content']]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS keyword_body_v2_${suffix} AFTER ${event} ON memories BEGIN
          DELETE FROM memory_keywords WHERE memory_id=NEW.id;
          INSERT OR IGNORE INTO memory_keywords(memory_id,term_norm,term)
            SELECT NEW.id,lower(term),term FROM (${keywordCTE('NEW.content')} SELECT term FROM parts WHERE term IS NOT NULL)
            WHERE length(term) BETWEEN 1 AND 80 AND (${keywordValidationSQL('NEW.content')})=1 LIMIT 8;
        END;`);
    }
    // foreign_keys may be off on legacy connections: delete invalidation must not depend on PRAGMA.
    db.exec(`CREATE TRIGGER IF NOT EXISTS keyword_body_v1_delete AFTER DELETE ON memories BEGIN DELETE FROM memory_keywords WHERE memory_id=OLD.id; END;`);
    db.exec('RELEASE keyword_index_install');
    } catch(e) { db.exec('ROLLBACK TO keyword_index_install; RELEASE keyword_index_install'); throw e; }
}
export function rebuildKeywordBatch(db, afterId = 0, limit = 200) {
    const rows = db.prepare('SELECT id,content FROM memories WHERE id>? ORDER BY id LIMIT ?').all(afterId, limit);
    db.exec('BEGIN IMMEDIATE');
    try {
        const del = db.prepare('DELETE FROM memory_keywords WHERE memory_id=?');
        const ins = db.prepare('INSERT INTO memory_keywords(memory_id,term_norm,term) VALUES(?,?,?)');
        for (const r of rows) {
            del.run(r.id);
            if (!keywordErrors(r.content).length) for (const t of parseKeywords(r.content)) ins.run(r.id, keywordNorm(t), t);
        }
        db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
    return { processed: rows.length, afterId: rows.at(-1)?.id ?? afterId, done: rows.length < limit };
}
export function keywordEpoch(db) { return db.prepare('SELECT epoch FROM keyword_index_meta WHERE id=1').get()?.epoch ?? 0; }
export function keywordCandidates(db, terms, project, limit = 40) {
    const normalized = [...new Set((terms || []).map(keywordNorm).filter(Boolean))].slice(0, 8);
    if (!normalized.length) return [];
    const marks = normalized.map(() => '?').join(',');
    return db.prepare(`SELECT m.id,COUNT(DISTINCT k.term_norm) hits,group_concat(k.term) matched
      FROM memory_keywords k JOIN memories m ON m.id=k.memory_id
      WHERE k.term_norm IN (${marks}) AND m.project COLLATE NOCASE IN (?, 'global')
      AND m.status='active' AND m.sensitivity!='secret'
      AND m.superseded_by IS NULL
      AND (m.valid_from IS NULL OR julianday(m.valid_from)<=julianday('now'))
      AND (m.valid_until IS NULL OR julianday(m.valid_until)>julianday('now'))
      GROUP BY m.id ORDER BY hits DESC,m.id DESC LIMIT ?`).all(...normalized,project,limit);
}
