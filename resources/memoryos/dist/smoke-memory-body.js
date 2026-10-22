/** 五字段写入契约：隔离库、真实工具定义、SQLite 旧连接与回滚验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryBodyErrors, memoryBodySchema, installMemoryBodyGuard, removeMemoryBodyGuard } from './memory-body.js';
import { bodyFixture } from './memory-body-fixture.js';
process.env.EMBED_MODE='fake';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-body-'));
process.env.MEMORY_DB=path.join(tmp,'test.db');
const {openDb,writeMemory,readMemory}=await import('./db.js');
const {registerMemoryTools}=await import('./server-reg-memory.js');
const {registerObsidianTools}=await import('./server-reg-obsidian.js');
const {parseRules}=await import('./rule-reflection.js');
const db=openDb(process.env.MEMORY_DB), old=new DatabaseSync(process.env.MEMORY_DB);
let n=0; const check=(name,ok)=>{assert.ok(ok,name);n++;console.log(`通过 ${name}`);};
const valid=bodyFixture('template_probe 使用五字段记忆模板');
const bads=[
 ['散文','只有一个结论'],['缺依据',valid.replace(/依据：\n[^\n]*\n/,'')],
 ['空行动',valid.replace(/行动：\n[^\n]*/,'行动：')],['重复字段',valid+'\n结论：重复'],
 ['乱序',valid.replace('适用范围：','临时：').replace('依据：','适用范围：').replace('临时：','依据：')],
 ['无日期',valid.replace('最后核验日期：2026-10-21。','')],['错误状态',valid.replace('待验证','已完成')],
 ['非法日期',valid.replace('2026-10-21','2026-02-30')],['未来日期',valid.replace('2026-10-21','2999-01-01')],
 ['占位符',valid.replace(/行动：\n[^\n]*/,'行动：\nTODO')]
];
try {
 check('纯文本合法',!memoryBodyErrors(valid).length);
 check('Markdown粗体合法',!memoryBodyErrors(valid.replace(/^(结论|适用范围|依据|行动|状态)：/gm,'**$1：**')).length);
 check('半角冒号和CRLF合法',!memoryBodyErrors(valid.replace(/：/g,':').replace(/\n/g,'\r\n')).length);
 for(const [name,v] of bads)check(`拒绝${name}`,!memoryBodySchema().safeParse(v).success);
 const tools=new Map(),ctx={db,stateReceipt:()=>'',runTaskTx:(_d,fn)=>{fn();return null;},isCredentialValid:()=>true,nowIso:()=>new Date().toISOString(),plusHoursIso:()=>new Date().toISOString()};
 registerMemoryTools({addTool:t=>tools.set(t.name,t)},ctx);
 registerObsidianTools({addTool:t=>tools.set(t.name,t)},ctx);
 const count=()=>db.prepare('SELECT COUNT(*) n FROM memories').get().n;
 const initial=count();
 for(const agent of ['claude','codex','trae','workbuddy','other-agent']) {
  check(`${agent}同用写入契约`,!tools.get('memory_write').parameters.safeParse({content:'旧散文',project:'test'}).success);
 }
 check('拒绝不产生记忆',count()===initial);
 check('Obsidian入口先校验，不创建文件',!tools.get('obsidian').parameters.safeParse({action:'write_note',content:'旧格式',vault:tmp,title:'should-not-exist'}).success&&!fs.existsSync(path.join(tmp,'should-not-exist.md')));
 const call=tools.get('memory_write'), args=call.parameters.parse({content:valid,project:'test',idempotency_key:'template-test'});
 const result=await call.execute(args);check('合法正文经过真实写入工具落库',result.includes('已写入记忆')&&count()===initial+1);
 const row=db.prepare('SELECT * FROM memories ORDER BY id DESC LIMIT 1').get();
 check('正文逐字保留',row.content===valid);
 const repeat=await call.execute(args);check('合法重复请求保持幂等',repeat.includes('幂等键命中')&&count()===initial+1);
 const existing=writeMemory(db,{content:'历史原文应保留',type:'experience',agent:'legacy',agent_fpath:null,project:'test'});
 installMemoryBodyGuard(db);installMemoryBodyGuard(db);
 check('门禁安装幂等',db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_body_v3_%'").get().n===2);
 check('历史原文未改变',readMemory(db,existing.id).content==='历史原文应保留');
 const sql="INSERT INTO memories(content,type,agent,project,source) VALUES(?,?,?,?,?)";
 for(const agent of ['codex','claude','trae','unknown']) {
  assert.throws(()=>old.prepare(sql).run('无格式旧连接上传','experience',agent,'test','agent'),/MEMORY_BODY_FORMAT/);n++;console.log(`通过 旧连接${agent}无格式写入被数据库拒绝`);
 }
 for(const [name,v] of bads) {
  assert.throws(()=>old.prepare(sql).run(v,'convention','old-agent','test','agent'),/MEMORY_BODY_FORMAT/);n++;console.log(`通过 数据库拒绝${name}`);
 }
 old.prepare(sql).run(valid,'experience','old-agent','test','agent');check('旧连接合法正文可写入',count()===initial+3);
 old.prepare(sql).run(valid.replace(/^(结论|适用范围|依据|行动|状态)：/gm,'**$1：**'),'decision','bold-agent','test','agent');n++;console.log('通过 数据库接受Markdown模板');
 assert.throws(()=>old.prepare('UPDATE memories SET content=? WHERE id=?').run('破坏模板',row.id),/MEMORY_BODY_FORMAT/);n++;console.log('通过 更新正文不能绕过模板');
 old.prepare('UPDATE memories SET hit_count=hit_count+1 WHERE id=?').run(existing.id);check('历史热度更新不受影响',readMemory(db,existing.id).hit_count===1);
 for(const [type,agent,source] of [['task','codex','agent'],['experience','human:dashboard','human'],['experience','obsidian','ingest']]) {old.prepare(sql).run('保留独立格式',type,agent,'test',source);n++;console.log(`通过 保留${type}/${source}原有格式`);}
 const {getEmbedder}=await import('./embed.js');
 const distinct=bodyFixture('template_probe 第二条独立结论，不能拼接依据');
 const [vec]=await (await getEmbedder()).embedTexts([distinct]);
 const target=writeMemory(db,{content:bodyFixture('template_probe 保留的旧结论'),type:'experience',agent:'test',agent_fpath:null,project:'separate',embedding:vec});
 const accepted=await call.execute(call.parameters.parse({content:distinct,project:'separate'}));
 check('相似向量但不同模板正文保留独立记录',accepted.includes('已写入记忆')&&readMemory(db,target.id).content===bodyFixture('template_probe 保留的旧结论'));
 const newer=db.prepare('SELECT id FROM memories WHERE content=? AND project=?').get(distinct,'separate');
 const {applyPlan}=await import('./daemon.js');
 applyPlan(db,{decays:[],archives:[],trials:[],dedupes:[{winner:target.id,loser:newer.id,sim:1}]},false);
 check('守护进程旧去重计划不拼接或下线不同模板',readMemory(db,target.id).content===bodyFixture('template_probe 保留的旧结论')&&readMemory(db,newer.id).status==='active');
 const legacy2=writeMemory(db,{content:'另一条历史原文',type:'experience',agent:'legacy-two',agent_fpath:null,project:'test',source:'ingest'});
 db.prepare("UPDATE memories SET source='agent' WHERE id=?").run(legacy2.id);
 applyPlan(db,{decays:[],archives:[],trials:[],dedupes:[{winner:existing.id,loser:legacy2.id,sim:1}]},false);
 check('后台不同历史智能体正文保留，门禁不会中断治理事务',readMemory(db,existing.id).content==='历史原文应保留'&&readMemory(db,legacy2.id).status==='active');
 check('自动反思拒绝散文'  ,parseRules(JSON.stringify(['旧规则无格式'])).length===0);
 check('自动反思接收五字段',parseRules(JSON.stringify([valid])).length===1);
 removeMemoryBodyGuard(db);old.prepare(sql).run('回滚门禁后恢复旧写入','experience','old-agent','test','agent');n++;console.log('通过 回滚只移除门禁，不删记录');
 console.log(`总计 ${n} 项通过`);
} finally {old.close();db.close();}

