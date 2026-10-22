import {spawn} from 'node:child_process';import fs from 'node:fs';import crypto from 'node:crypto';
import {carrierFor,readCarrier,samePath} from './agent-adapters.js';
const probes=new Map(),pending=new Map();
export function probeStatus(a){const file=carrierFor(a).file;const old=probes.get(a.id);if(!old)return null;let hash=null;try{hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{}return hash===old.configHash?old:null;}
export async function probeConnection(a,{timeoutMs=12000,expectedDb}={}){
 if(pending.has(a.id))return pending.get(a.id);
 const work=(async()=>{const started=Date.now(),file=carrierFor(a).file,f=file?readCarrier(file,{},carrierFor(a).kind):null;let result;
  if(!f?.declares||f.parseError||f.disabled||f.legacyFlat)result={ok:false,error:f?.disabled?'客户端已禁用MemoryOS':f?.legacyFlat?'配置是旧裸映射，须先迁移到客户端支持的mcpServers结构':f?.parseError||'未找到MemoryOS配置',stage:'configuration'};
  else if(f.carrierDb&&expectedDb&&!samePath(f.carrierDb,expectedDb))result={ok:false,error:'配置明确指向其他库，未启动探测进程；请先核对目标库',stage:'database',dbPath:f.carrierDb,dbMatches:false};
  else{
   let command=f.command,args=f.args??[];
   // Windows旧载体的cmd /c node包装按同一argv还原，避免shell拼接；不执行任意命令文本。
   if(/^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(command??'')&&/^\/[ck]$/i.test(args[0]??'')&&/^(?:.*[\\/])?node(?:\.exe)?$/i.test(args[1]??'')){command=args[1];args=args.slice(2);}
   if(!/^(?:.*[\\/])?node(?:\.exe)?$/i.test(command??'')||!f.serverPath||!fs.existsSync(f.serverPath))result={ok:false,error:'MemoryOS启动命令或server.js路径无效；未启动无关程序',stage:'launch'};
   else{
    result=await new Promise(resolve=>{let child,buf='',next=0,done=false;const waiting=new Map();const finish=r=>{if(done)return;done=true;clearTimeout(timer);try{child?.stdin.end();child?.kill();}catch{}resolve(r);};const timer=setTimeout(()=>finish({ok:false,stage:'timeout',error:'MCP握手或工具调用超时'}),timeoutMs);
     function send(method,params){const id=++next;return new Promise((ok,bad)=>{waiting.set(id,m=>m.error?bad(Error('MCP协议返回错误')):ok(m.result));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
     try{child=spawn(command,args,{env:{...process.env,...f.env,MEMORYOS_CONNECTION_PROBE:'1'},stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.on('data',()=>{});child.on('error',()=>finish({ok:false,stage:'launch',error:'无法启动配置指定的Node进程'}));child.on('exit',()=>{if(!done)finish({ok:false,stage:'protocol',error:'MCP进程在握手完成前退出'});});child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{buf+=chunk.toString();if(buf.length>4*1024*1024)return finish({ok:false,stage:'protocol',error:'MCP输出超限'});let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{const m=JSON.parse(line);if(waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}}catch{}}});
      (async()=>{try{await send('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'memoryos-connection-probe',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');const list=await send('tools/list',{});if(!list.tools?.some(t=>t.name==='memory_admin'))throw Error('未发现MemoryOS运营工具');const r=await send('tools/call',{name:'memory_admin',arguments:{action:'connection'}});if(r.isError)throw Error('MemoryOS连接信息调用失败');const text=r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');const info=JSON.parse(text);if(!info.dbPath)throw Error('服务未回报数据库路径');finish({ok:!expectedDb||samePath(info.dbPath,expectedDb),stage:'complete',dbPath:info.dbPath,dbMatches:expectedDb?samePath(info.dbPath,expectedDb):null,error:expectedDb&&!samePath(info.dbPath,expectedDb)?'协议可用，但实际连接的是其他数据库':null,toolCount:list.tools.length,tools:list.tools.slice(0,8).map(t=>t.name),protocolVerified:true,actualClient:false});}catch{finish({ok:false,stage:'tool-call',error:'MCP工具调用未通过：请检查载体schema、内核版本及核心服务；服务未提供可核验的库路径'});}})();
     }catch{finish({ok:false,stage:'launch',error:'启动配置失败'});}
    });
   }
  }
  let hash=null;try{hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{}
  const value={...result,agentId:a.id,checkedAt:new Date().toISOString(),durationMs:Date.now()-started,configHash:hash};probes.set(a.id,value);return value;
 })();pending.set(a.id,work);try{return await work;}finally{pending.delete(a.id);}
}
