import fs from 'node:fs';import crypto from 'node:crypto';
import {resolveAgentRuleTarget,SEG_START,SEG_END,currentRuleSegment} from './sync-rules.js';
import {publicEvent} from './feedback-events.js';
export function ruleFileStatus(a,expectedHash=null){
 const target=resolveAgentRuleTarget(a.id,a.configFile??a.configDir);
 if(!target)return {state:'unsupported',label:'规则入口未确认',file:null,loaded:false,loadLabel:'客户端加载未验证'};
 try{const text=fs.readFileSync(target.file,'utf8'),start=text.indexOf(SEG_START),end=text.indexOf(SEG_END,start);
  const complete=start>=0&&end>start,segment=complete?text.slice(start,end+SEG_END.length):'';
  const hash=complete?crypto.createHash('sha256').update(segment).digest('hex').slice(0,12):null,duplicate=text.indexOf(SEG_START,start+SEG_START.length)>=0,stale=!!(hash&&expectedHash&&hash!==expectedHash);
  return {state:duplicate?'duplicate':stale?'stale':complete?'written':'missing',label:duplicate?'存在重复规则段，需核对':stale?'规则文件版本落后，需同步':complete?'规则文件已有同步段':'尚无完整规则同步段',file:target.file,entryVerified:target.verified,hash,expectedHash,at:fs.statSync(target.file).mtime.toISOString(),loaded:false,loadLabel:'客户端加载未验证'};
 }catch{return {state:'missing',label:'规则文件未找到或不可读',file:target.file,loaded:false,loadLabel:'客户端加载未验证'};}
}
export function feedbackReport(db,snapshot,{agent='',kind='',status='',offset=0,limit=40,ruleStatus=ruleFileStatus}={}){
 const now=new Date(),since=new Date(now.getTime()-86400000).toISOString(),expectedRuleHash=crypto.createHash('sha256').update(currentRuleSegment(db)).digest('hex').slice(0,12);
 const names=new Set(db.prepare('SELECT DISTINCT agent FROM agent_feedback_events').all().map(r=>r.agent));
 const recentUsage=db.prepare("SELECT DISTINCT reader_agent agent FROM memory_usage WHERE created_at>=? AND reader_agent IS NOT NULL").all(since);for(const r of recentUsage)names.add(r.agent);
 const map=new Map((snapshot.agents??[]).map(a=>[a.id,a]));for(const name of names)if(!map.has(name))map.set(name,{id:name,name,installed:false,connectionState:'unreported'});
 const latest=db.prepare('SELECT * FROM agent_feedback_events WHERE agent=? AND kind=? ORDER BY created_at DESC,rowid DESC LIMIT 1');
 const history=db.prepare("SELECT memory_id,event,created_at FROM memory_usage WHERE reader_agent=? AND event=? ORDER BY id DESC LIMIT 1");
 const agents=[...map.values()].map(a=>{
  const last=k=>{const r=latest.get(a.id,k);if(r)return publicEvent(r);if(k==='rules')return null;const old=history.get(a.id,k==='write'?'write':k==='cite'?'cited':'returned');return old?{status:'historical',at:old.created_at,memoryId:old.memory_id>0?old.memory_id:null,source:'历史使用记录',message:k==='write'?'历史写入记录':'历史记忆返回记录'}:null;};
  const read=last('read'),write=last('write'),cite=last('cite'),rules=ruleStatus(a,expectedRuleHash),failure=db.prepare("SELECT * FROM agent_feedback_events WHERE agent=? AND status='failed' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(a.id);
  return {id:a.id,name:a.name,installed:!!a.installed,connectionState:a.connectionState,connected:!!a.connected,resolvedDb:a.resolvedDb??null,dbSource:a.dbSource??null,dbMatches:a.dbMatches??null,connectionError:a.connectionError??null,lastSeen:a.heartbeat?.at??null,rules:{...rules,lastSync:last('rules')},read,write,cite,lastFailure:failure?publicEvent(failure):null,needsAttention:!!(a.connectionError||a.dbMatches===false||[read,write,cite,last('rules')].some(r=>r?.status==='failed'))};
 });
 const conditions=[],params=[];if(agent){conditions.push('agent=?');params.push(agent);}if(kind){conditions.push('kind=?');params.push(kind);}if(status){conditions.push('status=?');params.push(status);}
 const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
 const total=db.prepare('SELECT count(*) n FROM agent_feedback_events'+where).get(...params).n;
 const events=db.prepare('SELECT * FROM agent_feedback_events'+where+' ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(...params,limit,offset).map(publicEvent);
 const counts=db.prepare('SELECT kind,status,count(*) n FROM agent_feedback_events WHERE created_at>=? GROUP BY kind,status').all(since);
 const count=(kind,status)=>counts.filter(r=>(!kind||r.kind===kind)&&(!status||r.status===status)).reduce((n,r)=>n+r.n,0);
 return {ok:true,updatedAt:now.toISOString(),agents,events,total,offset,limit,summary:{online:agents.filter(a=>a.connected).length,read24h:count('read','success'),write24h:count('write','success'),failed24h:count(null,'failed'),rulesUnverified:agents.filter(a=>a.installed&&!a.rules.loaded).length},coverage:'回执仅覆盖本次版本启用后到达当前内核的调用；旧会话或客户端本地拒绝无法观测。历史使用记录仅作参考。规则文件存在不等于客户端已加载。'};
}
