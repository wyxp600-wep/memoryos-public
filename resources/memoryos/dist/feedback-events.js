/** 运行回执只存白名单字段；不保存查询、正文、返回原文、凭据或异常堆栈。 */
import crypto from 'node:crypto';
export const FEEDBACK_TOOLS={memory_context:'read',memory_search:'read',memory_read:'read',memory_write:'write',memory_cite:'cite',rule_sync:'rules'};
export function installFeedback(db){db.exec(`CREATE TABLE IF NOT EXISTS agent_feedback_events(
 id TEXT PRIMARY KEY,agent TEXT NOT NULL,tool TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
 code TEXT NOT NULL,memory_id INTEGER,duration_ms INTEGER,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_feedback_agent_time ON agent_feedback_events(agent,created_at DESC);
 CREATE INDEX IF NOT EXISTS idx_feedback_time ON agent_feedback_events(created_at DESC);`);}
export function resultReceipt(tool,result,args={}){
 const text=typeof result==='string'?result:(result?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
 let state=null;try{state=JSON.parse([...text.matchAll(/^⟨state⟩ (\{[^\n]+\})$/gm)].at(-1)?.[1]??'null');}catch{}
 let status='success',code='completed';
 if(result?.isError){status='failed';code=/SQLITE_BUSY|database is locked/i.test(text)?'database_busy':/MEMORY_BODY_FORMAT/.test(text)?'body_format':'execution_failed';}
 else if(tool==='memory_write'){
  if(state?.id&&/^memory_write/.test(state.op??''))code=/idempotent/.test(state.op)?'already_exists':/merged/.test(state.op)?'merged':'written';
  else {status='unverified';code='write_unconfirmed';}
 }else if(tool==='memory_read'&&/^记忆 #\d+ (?:不存在。|为私密记忆)/.test(text)){status='failed';code=/为私密记忆/.test(text)?'private_memory':'memory_missing';}
 else if(tool==='memory_cite'&&!/^已记录记忆/.test(text)){status='failed';code='cite_unconfirmed';}
 else if(!text){status='unverified';code='empty_result';}
 else if(tool==='memory_search'&&/^(?:未找到|记忆库中未找到|命中 0 条)/.test(text))code='no_matches';
 const id=Number(state?.id??(['memory_read','memory_cite'].includes(tool)?args.memory_id:null));
 return {status,code,memoryId:Number.isSafeInteger(id)&&id>0?id:null};
}
export function recordFeedback(db,{agent,tool,result,args,durationMs,status,code,memoryId}){
 if(!db||!FEEDBACK_TOOLS[tool]||process.env.MEMORYOS_CONNECTION_PROBE==='1')return;
 const r=status?{status,code,memoryId}:resultReceipt(tool,result,args);
 try{db.prepare('INSERT INTO agent_feedback_events(id,agent,tool,kind,status,code,memory_id,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),String(agent||'unknown').slice(0,120),tool,FEEDBACK_TOOLS[tool],r.status,r.code||'execution_failed',r.memoryId??null,Math.max(0,Math.round(durationMs||0)),new Date().toISOString());}
 catch{console.error('[feedback] 回执记录失败；工具结果未改变');}
}
export const FEEDBACK_MESSAGES={rules_written:'规则同步文件已写入；客户端加载未验证',rules_failed:'规则文件同步失败，检查入口与文件权限',completed:'调用已完成',written:'记忆已写入',already_exists:'记忆已存在，本次未重复写入',merged:'重复内容已合并',write_unconfirmed:'未取得可核验的写入编号',database_busy:'数据库繁忙，操作未完成',body_format:'记忆格式校验未通过',execution_failed:'工具执行失败',schema_rejected:'参数校验未通过，未执行',memory_missing:'记忆不存在',private_memory:'私密记忆未向工具返回',cite_unconfirmed:'引用未确认',empty_result:'未取得结果回执',no_matches:'检索完成，未找到相关记忆'};
export function publicEvent(r){return {id:r.id,agent:r.agent,tool:r.tool,kind:r.kind,status:r.status,code:r.code,message:FEEDBACK_MESSAGES[r.code]||'结果待核对',memoryId:r.memory_id??null,durationMs:r.duration_ms??null,at:r.created_at,source:'内核执行回执'};}
