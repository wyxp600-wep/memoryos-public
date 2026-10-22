/** 知识质量元数据：引用校验不等于事实核验；不改历史正文。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryBodyErrors } from './memory-body.js';
export const evidenceSchema=z.array(z.object({memory_id:z.number().int().positive(),version:z.number().int().positive(),quote:z.string().min(8).max(2000),relation:z.enum(['supports','refutes','context']).default('supports')})).max(12).default([]);
export const contentHash=s=>createHash('sha256').update(String(s)).digest('hex');
export function ensureKnowledgeSchema(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS knowledge_evidence (
  id INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL, source_id INTEGER NOT NULL, source_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL, quote TEXT NOT NULL, relation TEXT NOT NULL, operator TEXT NOT NULL, resolution TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(memory_id,source_id,source_version,source_hash,relation,quote));
  CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_target ON knowledge_evidence(memory_id);
  CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_source ON knowledge_evidence(source_id);
  CREATE TABLE IF NOT EXISTS knowledge_methods (
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, profile TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE, body TEXT NOT NULL, source_snapshot TEXT NOT NULL, operator TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  CREATE TABLE IF NOT EXISTS knowledge_method_runs (
  id INTEGER PRIMARY KEY, method_id INTEGER NOT NULL, method_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL, checks TEXT NOT NULL, evidence_snapshot TEXT NOT NULL, operator TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'engine', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  CREATE INDEX IF NOT EXISTS idx_knowledge_runs_method ON knowledge_method_runs(method_id);`);
 if(!db.prepare('PRAGMA table_info(knowledge_evidence)').all().some(c=>c.name==='resolution'))db.exec("ALTER TABLE knowledge_evidence ADD COLUMN resolution TEXT NOT NULL DEFAULT 'pending'");
}
function hasEvidence(db) {return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_evidence'").get());}
export function publicMemory(db,id,project=null,{active=false}={}) {
 const r=db.prepare('SELECT * FROM memories WHERE id=?').get(id);
 if(!r||r.sensitivity==='secret'||r.type==='task')throw new Error('记忆不存在或不属于可访问知识');
 if(project&&![String(project).toLowerCase(),'global'].includes(String(r.project).toLowerCase()))throw new Error('来源不在本项目或global范围内');
 if(active&&(r.status!=='active'||r.superseded_by||(r.valid_from&&Date.parse(r.valid_from)>Date.now())||(r.valid_until&&Date.parse(r.valid_until)<=Date.now())))throw new Error('来源已失效或被替代，请重新检索');
 return r;
}
export function resolveEvidence(db,project,refs=[]) {
 return refs.map(ref=>{
  const r=publicMemory(db,ref.memory_id,project,{active:ref.relation!=='context'});
  if(r.version!==ref.version)throw new Error(`证据版本已变化：#${ref.memory_id}`);
  if(!r.content.includes(ref.quote))throw new Error(`引用不是#${ref.memory_id}原文片段`);
  return {...ref,hash:contentHash(r.content)};
 });
}
export function attachEvidence(db,targetId,refs,operator) {
 if(!refs.length)return;
 ensureKnowledgeSchema(db);
 const target=publicMemory(db,targetId);
 const current=resolveEvidence(db,target.project,refs);
 for(const r of current){
  if(r.memory_id===targetId)throw new Error('证据不能自我引用');
  if(refs.find(x=>x.memory_id===r.memory_id)?.hash!==r.hash)throw new Error('证据正文在写入前已改变');
  const prior=db.prepare('SELECT resolution FROM knowledge_evidence WHERE memory_id=? AND source_id=? AND source_version=? AND source_hash=? AND relation=? AND quote=?').get(targetId,r.memory_id,r.version,r.hash,r.relation,r.quote);
  if(prior?.resolution==='reviewed_no_conflict')continue;
  if(r.relation==='refutes'){
   const active=db.prepare('SELECT conflict_with FROM memories WHERE id=?').get(targetId).conflict_with;
   if(active&&active!==r.memory_id)throw new Error('已有另一条待仲裁关系，先核查现有冲突后再追加反驳');
  }
  db.prepare('INSERT OR IGNORE INTO knowledge_evidence(memory_id,source_id,source_version,source_hash,quote,relation,operator) VALUES(?,?,?,?,?,?,?)').run(targetId,r.memory_id,r.version,r.hash,r.quote,r.relation,operator);
  if(r.relation==='refutes')db.prepare('UPDATE memories SET conflict_with=? WHERE id=? AND conflict_with IS NULL').run(r.memory_id,targetId);
  db.prepare('INSERT INTO memory_events(memory_id,op,payload,operator) VALUES(?,?,?,?)').run(targetId,'evidence_attached',JSON.stringify({source_id:r.memory_id,source_version:r.version,relation:r.relation}),operator);
 }
}
/** 任一方向未决冲突均返回；来源不能跨项目、不能泄露secret。旧指针指向终态记录仍提示待复核。 */
export function conflictMap(db,ids) {
 const map=new Map(ids.map(id=>[Number(id),new Set()]));if(!ids.length)return new Map();
 // 分块避免SQLite变量上限；通常候选数不到数百。
 for(let start=0;start<ids.length;start+=300){
  const slice=ids.slice(start,start+300),qs=slice.map(()=>'?').join(',');
  const rows=db.prepare(`SELECT a.id a,b.id b FROM memories a JOIN memories b ON b.id=a.conflict_with
   WHERE (a.id IN (${qs}) OR b.id IN (${qs})) AND a.status='active' AND a.superseded_by IS NULL
   AND a.sensitivity!='secret' AND b.sensitivity!='secret'
   AND (lower(a.project)=lower(b.project) OR lower(a.project)='global' OR lower(b.project)='global')`).all(...slice,...slice);
  for(const r of rows){map.get(Number(r.a))?.add(Number(r.b));map.get(Number(r.b))?.add(Number(r.a));}
  if(hasEvidence(db)){
   const refs=db.prepare(`SELECT e.memory_id a,e.source_id b,e.source_hash,b.content source_content FROM knowledge_evidence e
    JOIN memories a ON a.id=e.memory_id JOIN memories b ON b.id=e.source_id
    WHERE e.relation='refutes' AND e.resolution='pending' AND (e.memory_id IN (${qs}) OR e.source_id IN (${qs}))
    AND a.status='active' AND b.status='active' AND a.superseded_by IS NULL AND b.superseded_by IS NULL
    AND a.sensitivity!='secret' AND b.sensitivity!='secret' AND b.version=e.source_version
    AND (lower(a.project)=lower(b.project) OR lower(a.project)='global' OR lower(b.project)='global')`).all(...slice,...slice);
   for(const r of refs){if(contentHash(r.source_content)!==r.source_hash)continue;map.get(Number(r.a))?.add(Number(r.b));map.get(Number(r.b))?.add(Number(r.a));}
  }
 }
 return new Map([...map].map(([id,s])=>[id,[...s].sort((a,b)=>a-b)]));
}
export function annotateConflicts(db,rows) {
 const map=conflictMap(db,rows.map(r=>r.id));return rows.map(r=>({...r,conflict_peers:map.get(Number(r.id))??[]}));
}
export function qualityOf(db,id,project=null) {
 const r=publicMemory(db,id,project),issues=memoryBodyErrors(r.content);
 const refs=hasEvidence(db)?db.prepare('SELECT * FROM knowledge_evidence WHERE memory_id=? ORDER BY id').all(id):[];
 const evidence=refs.map(e=>{
  try{const s=publicMemory(db,e.source_id,r.project,{active:e.relation!=='context'});return {id:e.id,memory_id:e.source_id,version:e.source_version,relation:e.relation,resolution:e.resolution,quote:e.quote,state:s.version===e.source_version&&contentHash(s.content)===e.source_hash&&s.content.includes(e.quote)?(e.relation==='context'&&s.status!=='active'?'historical_context':'reference_checked'):'stale'};}
  catch{return {id:e.id,relation:e.relation,state:'unavailable'};}
 });
 const declared=r.content.match(/(?:^|\n)(?:\*\*)?状态[：:]\**\s*([^\n]+)/)?.[1]??null;
 return {id:r.id,version:r.version,content_hash:contentHash(r.content),project:r.project,status:r.status,
  format_valid:!issues.length,format_issues:issues,declared_status:declared,
  verification:evidence.some(e=>e.state==='reference_checked')?'reference_checked':'unverified',
  notice:'原文引用可回查不等于结论已复现实证；声明状态不作系统认证。',evidence,
  unresolved_with:conflictMap(db,[r.id]).get(Number(r.id))??[],superseded_by:r.superseded_by??null};
}

export function qualityEpoch(db) {
 const pointers=db.prepare("SELECT id,conflict_with,status,superseded_by,version FROM memories WHERE conflict_with IS NOT NULL ORDER BY id").all();
 const refs=hasEvidence(db)?db.prepare('SELECT COUNT(*) n,MAX(id) last FROM knowledge_evidence').get():null;
 return contentHash(JSON.stringify([pointers,refs]));
}
