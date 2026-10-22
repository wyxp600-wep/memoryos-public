/** 六字段跨层契约：真实工具、SQLite旧连接、派生索引、历史读取、规则同步幂等。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bodyFixture } from './memory-body-fixture.js';
import { memoryBodyErrors, installMemoryBodyGuard } from './memory-body.js';
import { installKeywordIndex, parseKeywords, keywordCandidates, rebuildKeywordBatch } from './memory-keywords.js';
import { bodyFields } from './proposition.js';
import { memoryPreview,fmtReadLine } from './format.js';
process.env.EMBED_MODE='fake';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sixfields-'));
process.env.MEMORY_DB=path.join(tmp,'test.db');
const {openDb}=await import('./db.js');
const db=openDb(process.env.MEMORY_DB),old=new DatabaseSync(process.env.MEMORY_DB);
const insert=old.prepare("INSERT INTO memories(content,type,agent,project,source) VALUES(?,'experience','sixfields','test',?)");
const valid=bodyFixture('在隔离库发生格式错位时，六字段解析能够保留字段内容。');
let n=0;function check(name,fn){fn();n++;console.log('通过 '+name);}
const bads=[
 ['缺字段',valid.replace(/依据：\n[^\n]*\n\n/,'')],
 ['缺关键词',valid.replace(/关键词：\n[^\n]*\n\n/,'')],
 ['空字段',valid.replace(/行动：\n[^\n]*/,'行动：')],
 ['重复字段',valid+'\n结论：\n重复'],
 ['字段乱序',valid.replace('依据：','临时：').replace('行动：','依据：').replace('临时：','行动：')],
 ['旧行内格式',valid.replace(/：\n/g,'：')],
 ['关键词2个',valid.replace('MemoryOS；隔离测试；模板探针','SQLite；SQLITE_BUSY')],
 ['关键词6个',valid.replace('MemoryOS；隔离测试；模板探针','a；b；c；d；e；f')],
 ['关键词重复',valid.replace('MemoryOS；隔离测试；模板探针','SQLite；sqlite；BUSY')],
 ['关键词空项',valid.replace('MemoryOS；隔离测试；模板探针','a；；c')],
 ['关键词跨行',valid.replace('MemoryOS；隔离测试；模板探针','a；b；c\n其它无关词')],
 ['关键词位置',valid.replace('关键词：','临时：').replace('依据：','关键词：').replace('临时：','依据：')],
 ['关键词过长',valid.replace('MemoryOS；隔离测试；模板探针','a'.repeat(81)+'；b；c')],
 ['占位符',valid.replace(/依据：\n[^\n]*/,'依据：\nTODO')],
 ['模板占位',valid.replace(/依据：\n[^\n]*/,'依据：\n〔日志位置〕')],
 ['无日期',valid.replace('最后核验日期：2026-10-21。','')],
 ['未来日期',valid.replace('2026-10-21','2999-01-01')],
 ['日期多一位',valid.replace('2026-10-21','2026-10-211')],
 ['无效日期',valid.replace('2026-10-21','2026-02-30')],
 ['错误状态',valid.replace('待验证','已完成')],
 ['无关前缀','前缀\n'+valid]
];
try{
 installMemoryBodyGuard(db);installMemoryBodyGuard(db);installKeywordIndex(db);installKeywordIndex(db);
 for(const [name,body] of [['标准格式',valid],['半角CRLF',valid.replace(/：/g,':').replace(/\n/g,'\r\n')],['CR换行',valid.replace(/\n/g,'\r')],['全角缩进',valid.split('\n').map(s=>'　'+s+'　').join('\n')],['粗体字段',valid.replace(/^(结论|关键词|适用范围|依据|行动|状态)：/gm,'**$1：**')]]){
  check('JS接收'+name,()=>assert.deepEqual(memoryBodyErrors(body),[]));
  check('旧SQLite连接接收'+name,()=>insert.run(body,'agent'));
 }
 for(const [name,body] of bads){
  check('JS拒绝'+name,()=>assert.ok(memoryBodyErrors(body).length));
  check('SQLite拒绝'+name,()=>assert.throws(()=>insert.run(body,'agent'),/MEMORY_BODY_FORMAT/));
 }
 const id=Number(insert.run(valid,'agent').lastInsertRowid);
 check('正文逐字保存',()=>assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').get(id).content,valid));
 check('关键词读取完整',()=>assert.deepEqual(parseKeywords(valid),['MemoryOS','隔离测试','模板探针']));
 check('SQL派生索引3词',()=>assert.equal(db.prepare('SELECT count(*) n FROM memory_keywords WHERE memory_id=?').get(id).n,3));
 check('关键词召回',()=>assert.ok(keywordCandidates(db,['隔离测试'],'test').some(r=>r.id===id)));
 check('字段解析不吞入关键词',()=>assert.equal(bodyFields(valid).head,'在隔离库发生格式错位时，六字段解析能够保留字段内容。'));
 check('摘要含条件与状态',()=>assert.match(memoryPreview(valid,220),/条件:隔离测试环境.*待验证/));
 check('全文显示换行',()=>assert.ok(fmtReadLine({id,content:valid}).endsWith(valid)));
 const changed=valid.replace('模板探针','新格式探针');old.prepare('UPDATE memories SET content=? WHERE id=?').run(changed,id);
 check('正文修订自动更新索引',()=>assert.equal(db.prepare("SELECT count(*) n FROM memory_keywords WHERE memory_id=? AND term='新格式探针'").get(id).n,1));
 check('非法修订被拒',()=>assert.throws(()=>old.prepare('UPDATE memories SET content=? WHERE id=?').run('旧格式',id),/MEMORY_BODY_FORMAT/));
 const legacy='结论：旧正文\n适用范围：旧版\n依据：原日志\n行动：原步骤\n状态：待验证；最后核验日期：2026-10-18。';
 const legacyId=Number(insert.run(legacy,'ingest').lastInsertRowid);old.prepare("UPDATE memories SET source='agent',hit_count=1 WHERE id=?").run(legacyId);
 check('旧正文可读不变',()=>assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').get(legacyId).content,legacy));
 check('旧正文命题解析',()=>assert.equal(bodyFields(legacy).head,'旧正文'));
 const legacyKW=legacy.replace('适用范围：','关键词：SQLite；BUSY\n适用范围：');const lid=Number(insert.run(legacyKW,'ingest').lastInsertRowid);
 check('旧关键词索引兼容',()=>assert.equal(db.prepare('SELECT count(*) n FROM memory_keywords WHERE memory_id=?').get(lid).n,2));
 rebuildKeywordBatch(db,0,200);
 check('批次回填保留旧新索引',()=>assert.equal(db.prepare('SELECT count(*) n FROM memory_keywords WHERE memory_id=?').get(id).n,3));
 const tools=new Map();const {registerMemoryTools}=await import('./server-reg-memory.js');registerMemoryTools({addTool:t=>tools.set(t.name,t)},{db,stateReceipt:()=>'',runTaskTx:(_d,fn)=>{fn();return null;},isCredentialValid:()=>true,nowIso:()=>new Date().toISOString(),plusHoursIso:()=>new Date().toISOString()});
 for(const agent of ['codex','claude','workbuddy','trae','opencode','qoder','unknown'])check('共享工具拒绝旧格式/'+agent,()=>assert.equal(tools.get('memory_write').parameters.safeParse({content:legacy,project:'test'}).success,false));
 const call=tools.get('memory_write');const result=await call.execute(call.parameters.parse({content:valid,project:'protocol',idempotency_key:'sixfields'}));check('实际工具写入',()=>assert.match(result,/已写入记忆/));
 const {syncProjectRules}=await import('./sync-rules.js');const project=path.join(tmp,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'AGENTS.md'),'用户原有规则\n');syncProjectRules(db,project);const first=fs.readFileSync(path.join(project,'AGENTS.md'),'utf8');syncProjectRules(db,project);
 check('规则同步字节幂等',()=>assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),first));
 check('原有规则保留与新模板注入',()=>{assert.match(first,/用户原有规则/);assert.ok(first.includes('结论：\n在〔具体条件〕下'));assert.match(first,/关键词3～5个/);});
 console.log(`总计 ${n} 项通过；隔离库 ${tmp}`);
}finally{old.close();db.close();}
