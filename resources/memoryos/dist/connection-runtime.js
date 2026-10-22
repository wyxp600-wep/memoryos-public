/** 每个真实MCP进程一条状态记录；协议测试使用PROBE标记，不伪装成客户端在线。 */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
export function databaseFile(db){return db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file||':memory:';}
export function configHash(file){try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch{return null;}}
export function installConnectionState(db){db.exec(`CREATE TABLE IF NOT EXISTS mcp_client_connections(
 connection_id TEXT PRIMARY KEY,agent TEXT NOT NULL,client_pid INTEGER NOT NULL,transport TEXT NOT NULL,
 config_file TEXT,config_hash TEXT,db_path TEXT,phase TEXT NOT NULL,last_seen TEXT NOT NULL,last_call_at TEXT,last_tool TEXT,started_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_mcp_connections_agent ON mcp_client_connections(agent,last_seen);`);}
export function saveConnectionPulse(db,p){
 installConnectionState(db);if(!p||typeof p.connectionId!=='string'||!/^[a-f0-9-]{16,64}$/i.test(p.connectionId)||typeof p.agent!=='string'||p.agent.length>120||!Number.isInteger(p.pid)||p.pid<=0)throw Error('连接回报字段无效');
 const phase=['starting','ready','closed'].includes(p.phase)?p.phase:'starting';
 db.prepare(`INSERT INTO mcp_client_connections(connection_id,agent,client_pid,transport,config_file,config_hash,db_path,phase,last_seen,last_call_at,last_tool,started_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET phase=excluded.phase,last_seen=excluded.last_seen,last_call_at=coalesce(excluded.last_call_at,last_call_at),last_tool=coalesce(excluded.last_tool,last_tool),db_path=excluded.db_path`).run(p.connectionId,p.agent,p.pid,p.transport==='direct'?'direct':'shim',typeof p.configFile==='string'?p.configFile.slice(0,2048):null,/^[a-f0-9]{64}$/.test(p.configHash??'')?p.configHash:null,p.dbPath??databaseFile(db),phase,new Date().toISOString(),p.lastCallAt??null,typeof p.lastTool==='string'?p.lastTool.slice(0,100):null,p.startedAt??new Date().toISOString());
}
export function runtimeFor(db,a){
 installConnectionState(db);const rows=db.prepare('SELECT * FROM mcp_client_connections WHERE agent=? ORDER BY last_seen DESC LIMIT 20').all(a.id);
 const now=Date.now();for(const r of rows){let alive=false;try{process.kill(r.client_pid,0);alive=true;}catch{}r.live=alive&&r.phase!=='closed'&&now-Date.parse(r.last_seen)<45000;r.configChanged=!!(r.config_file&&r.config_hash&&configHash(r.config_file)!==r.config_hash);}
 const live=rows.find(r=>r.live),recent=live??rows[0]??null;
 // 旧版本无持续回报，仅显示近期真实使用记录，不将一次启动留痕当作当前在线。
 const legacy=db.prepare("SELECT max(created_at) at FROM memory_usage WHERE reader_agent=? AND created_at>=datetime('now','-10 minutes')").get(a.id)?.at??null;
 return {online:!!live,phase:live?.phase??(recent?'offline':'unreported'),lastSeen:recent?.last_seen??null,lastCallAt:recent?.last_call_at??legacy,lastTool:recent?.last_tool??null,dbPath:live?.db_path??null,configChanged:!!live?.configChanged,clientPid:live?.client_pid??null,legacyActivity:!!(!live&&legacy),instances:rows.filter(r=>r.live).length};
}
export function startClientReporting(server,{db,agent,agentFpath,dbPath,mode}){
 if(process.env.MEMORYOS_CONNECTION_PROBE==='1')return;
 const startedAt=new Date().toISOString(),connectionId=crypto.randomUUID(),fingerprint=configHash(agentFpath);let phase='starting',lastTool=null,lastCallAt=null,busy=false,closed=false,buf='';
 async function pulse(){if(busy)return;busy=true;try{const p={connectionId,agent,pid:process.pid,transport:mode,configFile:agentFpath,configHash:fingerprint,dbPath:db?databaseFile(db):dbPath,phase,lastTool,lastCallAt,startedAt};
  if(db)saveConnectionPulse(db,p);else{const base=process.env.MEMORYOS_DATA_DIR||path.dirname(path.dirname(dbPath));const info=JSON.parse(fs.readFileSync(path.join(base,'core.json'),'utf8'));const token=process.env.MEMORY_TOKEN||fs.readFileSync(path.join(base,'data/token'),'utf8').trim();await fetch(`http://127.0.0.1:${info.port}/api/mcp/heartbeat`,{method:'POST',headers:{'x-memory-token':token,'content-type':'application/json'},body:JSON.stringify(p),signal:AbortSignal.timeout(4000)});}
 }catch{/* 核心重启期间允许下一心跳重连，不打印令牌或原配置。 */}finally{busy=false;}}
 server.on('connect',()=>{void pulse();});server.on('disconnect',()=>{phase='closed';void pulse();});
 const listener=chunk=>{buf+=chunk.toString();if(buf.length>1024*1024)buf=buf.slice(-65536);let at;while((at=buf.indexOf('\n'))>=0){const line=buf.slice(0,at);buf=buf.slice(at+1);try{const p=JSON.parse(line);if(p.method==='notifications/initialized'){phase='ready';void pulse();}if(p.method==='tools/call'){lastCallAt=new Date().toISOString();lastTool=String(p.params?.name||'').slice(0,100);void pulse();}}catch{}}};
 process.stdin.on('data',listener);const timer=setInterval(()=>void pulse(),15000);timer.unref();
 const stop=()=>{if(closed)return;closed=true;clearInterval(timer);phase='closed';void pulse();};process.stdin.once('end',stop);process.stdin.once('close',stop);if(db)process.once('exit',()=>{try{saveConnectionPulse(db,{connectionId,agent,pid:process.pid,transport:mode,phase:'closed',dbPath:databaseFile(db),startedAt});}catch{}});
 void pulse();
}
