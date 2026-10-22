/** 客户端载体适配：解析、预览、写入共用同一规范，原凭据只留在原配置。 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
export const SERVER_PATH=process.env.MEMORYOS_SERVER?.trim()||fileURLToPath(new URL('./server.js',import.meta.url));
export const DATABASE_PATH=process.env.MEMORY_DB||path.join(process.env.APPDATA||path.join(os.homedir(),'AppData/Roaming'),'MemoryOS/data/memory.db');
const definitions={
 codex:['.codex/config.toml','toml'],claude:['.claude.json','mcpServers'],'claude-desktop':['AppData/Roaming/Claude/claude_desktop_config.json','mcpServers'],
 workbuddy:['.workbuddy/mcp.json','mcpServers'],'workbuddy-ai':['.workbuddy-ai/mcp.json','mcpServers'],qoder:['.qoder/settings.json','mcpServers'],
 zcode:['.zcode/cli/config.json','mcp.servers'],minimax:['.minimax/mcp.json','mcpServers'],opencode:['.config/opencode/opencode.json','opencode'],
 vscode:['AppData/Roaming/Code/User/mcp.json','servers'],cursor:['.cursor/mcp.json','mcpServers'],windsurf:['.codeium/windsurf/mcp_config.json','mcpServers'],
 gemini:['.gemini/settings.json','mcpServers'],qwen:['.qwen/settings.json','mcpServers'],codebuddy:['.codebuddy/mcp.json','mcpServers'],
 traecode:['AppData/Roaming/Trae CN/User/mcp.json','mcpServers'],traework:['AppData/Roaming/TRAE SOLO CN/User/mcp.json','mcpServers'],
 copilot:['.copilot/mcp-config.json','mcpServers'],'pi-agent':['.pi/agent/mcp.json','mcpServers'],commandcode:['.commandcode/mcp.json','mcpServers'],
 antigravity:['.gemini/config/mcp_config.json','mcpServers'],mimo:['.config/mimocode/mimocode.jsonc','opencode']
};
export const adapterIds=Object.keys(definitions);
export function carrierFor(a,home=os.homedir()){
 const def=definitions[a.id];let file=a.configFile||(def?path.join(home,...def[0].split('/')):null),kind=def?.[1]??null;
 if(!def&&file&&fs.existsSync(file)){const f=readCarrier(file);if(f.declares&&['mcpServers','mcp.servers','servers'].includes(f.shape))kind=f.shape;}
 return {file,kind};
}
export function samePath(a,b){return !!a&&!!b&&path.resolve(a).replaceAll('\\','/').toLowerCase()===path.resolve(b).replaceAll('\\','/').toLowerCase();}
function jsonTokens(text){
 const tokens=[];let i=0;
 while(i<text.length){const c=text[i];if(/\s/.test(c)){i++;continue;}if(text.startsWith('//',i)){const n=text.indexOf('\n',i);i=n<0?text.length:n;continue;}if(text.startsWith('/*',i)){const n=text.indexOf('*/',i+2);if(n<0)throw Error('配置注释未闭合');i=n+2;continue;}const start=i;
  if(c==='"'){i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')break;}const raw=text.slice(start,i);tokens.push({v:JSON.parse(raw),raw,start,end:i});}
  else if('{}[]:,'.includes(c)){tokens.push({v:c,raw:c,start,end:++i});}
  else{while(i<text.length&&!/[\s{}\[\]:,]/.test(text[i]))i++;const raw=text.slice(start,i);if(!raw)throw Error('无效配置');tokens.push({v:JSON.parse(raw),raw,start,end:i});}
 }
 return tokens;
}
function jsonTree(text){const ts=jsonTokens(text);let n=0;function value(){const t=ts[n++];if(!t)throw Error('配置内容不完整');if(t.raw==='{'){const props=[];while(ts[n]?.raw!=='}'){const k=ts[n++];if(!k||!k.raw.startsWith('"')||ts[n++]?.raw!==':')throw Error('配置对象字段无效');const val=value();props.push({key:k.v,node:val});if(ts[n]?.raw===','){n++;if(ts[n]?.raw==='}')break;}else break;}const end=ts[n++];if(end?.raw!=='}')throw Error('配置对象未闭合');return {start:t.start,end:end.end,props};}if(t.raw==='['){const items=[];while(ts[n]?.raw!==']'){items.push(value());if(ts[n]?.raw===','){n++;if(ts[n]?.raw===']')break;}else break;}const end=ts[n++];if(end?.raw!==']')throw Error('配置数组未闭合');return {start:t.start,end:end.end,items};}return {start:t.start,end:t.end,v:t.v};}const root=value();if(n!==ts.length)throw Error('配置包含多份文档');return root;}
export function parseJsonConfig(text){const root=jsonTree(text);function val(n){if(n.props){const o={};for(const p of n.props){if(Object.hasOwn(o,p.key))throw Error('配置字段重复：'+p.key);Object.defineProperty(o,p.key,{value:val(p.node),enumerable:true,writable:true,configurable:true});}return o;}if(n.items)return n.items.map(val);return n.v;}return val(root);}
function editJson(text,keys,value){
 if(!text.trim())text='{}\n';const tree=jsonTree(text);let node=tree;
 for(let i=0;i<keys.length;i++){if(!node.props)throw Error('配置容器不是对象，拒绝覆盖');const prop=node.props.find(p=>p.key===keys[i]);if(prop){if(i===keys.length-1)return text.slice(0,prop.node.start)+JSON.stringify(value,null,2)+text.slice(prop.node.end);node=prop.node;}
  else{let obj=value;for(let j=keys.length-1;j>i;j--)obj={[keys[j]]:obj};const last=node.props.at(-1)?.node;const between=last?text.slice(last.end,node.end-1):'';const comma=last&&!jsonTokens(between).some(t=>t.raw===',')?',':'';return text.slice(0,last?.end??node.start+1)+comma+text.slice(last?.end??node.start+1,node.end-1)+'\n'+JSON.stringify(keys[i])+': '+JSON.stringify(obj,null,2)+'\n'+text.slice(node.end-1);}
 }throw Error('配置路径为空');
}
function tomlSections(text){const rows=text.split(/\r?\n/),out=[];let current=null;for(let i=0;i<rows.length;i++){const m=rows[i].match(/^\s*(\[\[?)(.*)(\]\]?)\s*(?:#.*)?$/);if(m){if(current)current.end=i;current={name:(m[1].length===2?'array:':'')+m[2].replace(/\]$/,'').replace(/["']/g,''),start:i,end:rows.length,lines:[]};out.push(current);}else if(current)current.lines.push(rows[i]);}return {rows,sections:out};}
function tomlKey(s){return s.startsWith('"')?JSON.parse(s):s.startsWith("'")?s.slice(1,-1):s;}
function tomlValue(text){let i=0;function skip(){while(i<text.length){if(/\s/.test(text[i]))i++;else if(text[i]==='#'){while(i<text.length&&text[i]!=='\n')i++;}else break;}}function parse(){skip();const c=text[i++];if(c==='"'||c==="'"){const start=i-1;while(i<text.length){if(c==='"'&&text[i]==='\\'){i+=2;continue;}if(text[i++]===c)return c==='"'?JSON.parse(text.slice(start,i)):text.slice(start+1,i-1);}throw Error('TOML字符串未闭合');}if(c==='['){const arr=[];skip();while(text[i]!==']'){arr.push(parse());skip();if(text[i]===','){i++;skip();}else break;}if(text[i++]!==']')throw Error('TOML数组未闭合');return arr;}if(c==='{'){const o={};skip();while(text[i]!=='}'){const m=text.slice(i).match(/^("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/);if(!m)throw Error('TOML环境变量格式无效');i+=m[0].length;o[tomlKey(m[1])]=parse();skip();if(text[i]===','){i++;skip();}else break;}if(text[i++]!=='}')throw Error('TOML内联表未闭合');return o;}i--;const m=text.slice(i).match(/^(true|false|-?\d+(?:\.\d+)?)/);if(!m)throw Error('不支持的TOML连接字段');i+=m[0].length;return m[1]==='true'?true:m[1]==='false'?false:Number(m[1]);}return parse();}
function tomlPairs(lines){const result={};for(let i=0;i<lines.length;i++){const m=lines[i].match(/^\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/);if(!m)continue;let raw=m[2];for(;;){try{result[tomlKey(m[1])]=tomlValue(raw);break;}catch(e){if(i+1>=lines.length)throw e;raw+='\n'+lines[++i];}}}return result;}
function parseTomlEntry(text){const {sections}=tomlSections(text);const candidates=sections.filter(s=>/^mcp_servers\.(memoryos|memoryhub)$/.test(s.name)).sort((a,b)=>a.name.includes('memoryos')?-1:b.name.includes('memoryos')?1:0);if(!candidates.length)return {entry:null,key:'memoryos'};const s=candidates[0],entry=tomlPairs(s.lines);const env=sections.find(e=>e.name===s.name+'.env');if(env)entry.env={...(entry.env||{}),...tomlPairs(env.lines)};return {entry,key:s.name.split('.')[1]};}
function locate(cfg,kind){
 if(kind==='opencode')return cfg.mcp?.servers?{keys:['mcp','servers'],map:cfg.mcp.servers}:{keys:['mcp'],map:cfg.mcp};
 if(kind==='servers')return {keys:['servers'],map:cfg.servers};
 if(kind==='mcp.servers')return {keys:['mcp','servers'],map:cfg.mcp?.servers};
 if(cfg.mcpServers)return {keys:['mcpServers'],map:cfg.mcpServers};if(cfg.mcp?.servers)return {keys:['mcp','servers'],map:cfg.mcp.servers};if(cfg.servers)return {keys:['servers'],map:cfg.servers};
 if((cfg.memoryos||cfg.memoryhub)&&Object.values(cfg).every(v=>v&&typeof v==='object'&&(v.command||v.url)))return {keys:['mcpServers'],map:cfg,legacyFlat:true};
 if(kind==='mcp.servers')return {keys:['mcp','servers'],map:null};if(kind==='servers')return {keys:['servers'],map:null};return {keys:['mcpServers'],map:null};
}
export function readCarrier(file,svc={},kind=null){
 if(!kind&&/(?:opencode|mimocode)\.jsonc?$/i.test(file))kind='opencode';
 const exists=svc.exists||fs.existsSync,read=svc.read||(p=>fs.readFileSync(p,'utf8'));let text='';
 try{text=read(file)||'';}catch(e){if(!exists(file))return {exists:false,shape:'missing',declares:false,entry:null};return {exists:true,shape:'unreadable',declares:false,parseError:'配置文件不可读',entry:null};}
 if(!text.trim())return {exists:exists(file),shape:'missing',declares:false,entry:null,text};
 try{let entry,key='memoryos',shape,keys,cfg;
  if(/\.toml$/i.test(file)){({entry,key}=parseTomlEntry(text));shape='toml';}
  else{cfg=parseJsonConfig(text);if(!cfg||typeof cfg!=='object'||Array.isArray(cfg))throw Error('配置顶层须为对象');const found=locate(cfg,kind);keys=found.keys;key=found.map?.memoryos?'memoryos':found.map?.memoryhub?'memoryhub':'memoryos';entry=found.map?.[key]??null;shape=found.legacyFlat?'flat':kind==='opencode'?'opencode':keys.join('.');}
  const cmd=Array.isArray(entry?.command)?entry.command[0]:entry?.command;
  const args=Array.isArray(entry?.command)?entry.command.slice(1):Array.isArray(entry?.args)?entry.args:[];
  const env=entry?.environment??entry?.env??{};
  const serverPath=args.find(v=>typeof v==='string'&&/[\\/]server\.js$/i.test(v))??null;
  const disabled=entry?.enabled===false||entry?.disabled===true;
  return {exists:true,shape,declares:!!entry,entry,key,keys,cfg,text,command:cmd,args,env,serverPath,carrierDb:env.MEMORY_DB??null,disabled,parseError:null,legacyFlat:shape==='flat'};
 }catch{return {exists:true,shape:'invalid',declares:false,entry:null,parseError:'配置语法无效或不支持的MCP字段；未修改原文件'};}
}
export function publicFacts(f){return {exists:!!f.exists,shape:f.shape,declares:!!f.declares,serverPath:f.serverPath??null,carrierDb:f.carrierDb??null,parseError:f.parseError??null,disabled:!!f.disabled};}
export function canonicalEntry(a,{home=os.homedir(),dbPath=DATABASE_PATH,serverPath=SERVER_PATH,nodePath=process.execPath}={}){
 const carrier=carrierFor(a,home);const env={MEMORY_AGENT:a.id,MEMORY_AGENT_FPATH:carrier.file||'',MEMORY_DB:dbPath,MEMORYOS_MCP_MODE:'shim'};
 return carrier.kind==='opencode'?{type:'local',command:[nodePath,serverPath],environment:env,enabled:true}:{command:nodePath,args:[serverPath],env};
}
function tomlBlock(key,entry){const env=Object.entries(entry.env).map(([k,v])=>`${k} = ${JSON.stringify(String(v))}`).join(', ');const extra=Object.entries(entry).filter(([k])=>!['command','args','env'].includes(k)).map(([k,v])=>`${k} = ${JSON.stringify(v)}`).join('\n');return `[mcp_servers.${key}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nenv = { ${env} }\n${extra?extra+'\n':''}`;}
export function connectGuide(a,svc={},opts={}){
 const c=carrierFor(a,opts.home),f=c.file?readCarrier(c.file,svc,c.kind):{shape:'unsupported'};
 const entry=canonicalEntry(a,opts),key=f.key||'memoryos';let snippet='';
 if(c.kind==='toml')snippet=tomlBlock(key,entry);else{const keys=f.keys??(c.kind==='opencode'?['mcp']:c.kind==='mcp.servers'?['mcp','servers']:c.kind==='servers'?['servers']:['mcpServers']);let o={[key]:entry};for(let i=keys.length-1;i>=0;i--)o={[keys[i]]:o};snippet=JSON.stringify(o,null,2);}
 if(!c.kind)snippet='';
 const dbPath=opts.dbPath||DATABASE_PATH,server=opts.serverPath||SERVER_PATH;
 const explicit=f.carrierDb;const resolved=explicit||(f.declares&&samePath(f.serverPath,server)?dbPath:null);
 const remote=!!(f.entry?.url||f.entry?.serverUrl||f.entry?.httpUrl);const known=!!c.kind,invalid=f.shape==='invalid'||f.shape==='unreadable';
 const needsRepair=!!(f.declares&&!f.disabled&&(f.legacyFlat||/^(?:node|cmd)(?:\.exe)?$/i.test(f.command??'')||!f.env?.MEMORY_AGENT_FPATH||!f.env?.MEMORY_DB||!f.serverPath||(f.serverPath&&!fs.existsSync(f.serverPath))));
 return {agentId:a.id,name:a.name,configured:!!f.declares,connected:false,canAutoWrite:known&&!invalid&&!remote,autoWriteFile:c.file,carrierShape:f.shape,carrierDb:explicit??null,resolvedDb:resolved,dbSource:explicit?'配置MEMORY_DB':resolved?'当前MemoryOS内核默认值':'尚未配置或无法解析',dbMatches:resolved?samePath(resolved,dbPath):null,targetDb:dbPath,serverPath:f.serverPath??null,staleServer:!!(f.declares&&f.serverPath&&!fs.existsSync(f.serverPath)),needsDbFix:!!(explicit&&!samePath(explicit,dbPath)),needsRepair,disabled:!!f.disabled,parseError:f.parseError??null,serverName:key,
 attachSnippet:snippet,fileSnippet:snippet,fileSnippetLabel:'合并到 '+(c.file||'尚未确认的客户端配置'),importSnippet:snippet,importSnippetDoc:snippet,importSnippetDocLabel:c.kind==='toml'?'Codex TOML配置':'该客户端的完整MCP配置片段',manualSnippet:known?snippet:null,
 manualSteps:known?['配置文件：'+c.file,'系统将备份原文件并仅合并MemoryOS条目；保存配置后等待客户端重载。','点击协议测试验证实际配置；只有收到该客户端回报后才显示连接在线。']:['已发现安装，但尚未确认该版本支持的MCP配置入口；不提供猜测JSON，不自动覆盖配置。'],
 reason:invalid?f.parseError:remote?'当前为远程MCP配置，保留既有连接；不自动替换成本地服务':known?null:'该客户端的MCP配置入口未确认'};
}
const defaultFs={read:p=>fs.readFileSync(p,'utf8'),exists:fs.existsSync,mkdir:p=>fs.mkdirSync(p,{recursive:true}),copy:fs.copyFileSync,write:(p,s)=>fs.writeFileSync(p,s,'utf8'),rename:fs.renameSync,unlink:fs.unlinkSync};
export function writeConnection(a,opts={},svc=defaultFs){
 const guide=connectGuide(a,svc,opts);if(!guide.canAutoWrite)return {ok:false,carrierInvalid:guide.carrierShape==='invalid',error:guide.reason||'配置入口未确认，不自动写入'};
 const target=guide.autoWriteFile,c=carrierFor(a,opts.home),f=readCarrier(target,svc,c.kind);if(opts.automatic&&(guide.disabled||guide.needsDbFix))return {ok:false,skipped:true,error:guide.disabled?'用户已禁用，保留设置':'已明确指向其他库，保留设置'};
 const desired=canonicalEntry(a,opts),key=f.key||'memoryos';const desiredEnv=desired.environment??desired.env;
 const previous=f.entry??{};const merged={...previous,...desired};if(c.kind==='opencode')merged.environment={...(previous.environment??previous.env??{}),...desiredEnv};else merged.env={...(previous.env??previous.environment??{}),...desiredEnv};
 // 修复旧错误格式时仅移除已被本适配器替代的连接字段，其余选项与凭据保留。
 if(c.kind==='opencode'){delete merged.args;delete merged.env;}else delete merged.environment;
 if(previous.disabled===true)delete merged.disabled;
 const oldText=f.text??'',current=svc.exists(target)?svc.read(target):'';let next,mode;
 if(c.kind==='toml'){
  const {rows,sections}=tomlSections(oldText),matching=sections.filter(s=>s.name===`mcp_servers.${key}`||s.name===`mcp_servers.${key}.env`),block=tomlBlock(key,merged);
  const indexes=new Set(matching.flatMap(s=>Array.from({length:s.end-s.start},(_,i)=>s.start+i)));
  next=rows.filter((_,i)=>!indexes.has(i)).join('\n').trimEnd()+'\n\n'+block;mode=matching.length?'replace':'append';
 }else{const keys=f.keys??(c.kind==='opencode'?['mcp']:c.kind==='mcp.servers'?['mcp','servers']:c.kind==='servers'?['servers']:['mcpServers']);let text=oldText||'{}\n';if(f.legacyFlat){const tree=jsonTree(text);text=text.slice(0,tree.start)+'{"mcpServers":'+text.slice(tree.start,tree.end)+'}'+text.slice(tree.end);}next=editJson(text,[...keys,key],merged);mode=f.legacyFlat?'migrate':f.exists?'merge':'create';}
 if(f.entry&&JSON.stringify(f.entry)===JSON.stringify(merged))return {ok:true,unchanged:true,mode:'unchanged',target,dbPath:opts.dbPath||DATABASE_PATH};
 if(opts.dryRun)return {ok:true,mode,target,dbPath:opts.dbPath||DATABASE_PATH,preview:guide.fileSnippet,needsDbFix:guide.needsDbFix,staleServer:guide.staleServer};
 // 乐观核对：副本修改并验证后才替换；预览不返回完整原配置，避免泄露其它server的凭据。
 if((svc.exists(target)?svc.read(target):'')!==current)return {ok:false,error:'配置被其他进程修改，请重新扫描'};
 svc.mkdir(path.dirname(target));const bakDir=opts.backupDir||path.join(os.homedir(),'_pending-delete/connect-backup');svc.mkdir(bakDir);
 const backupPath=path.join(bakDir,`${a.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bak`),tmp=target+'.mos-'+crypto.randomBytes(4).toString('hex')+'.tmp';
 if(svc.exists(target))svc.copy(target,backupPath);svc.write(tmp,next);
 const check=readCarrier(tmp,{...svc,read:()=>next,exists:()=>true},c.kind==='toml'?'toml':c.kind); // TOML临时后缀另行校验
 if(c.kind!=='toml'&&(!check.declares||check.parseError)){svc.unlink(tmp);return {ok:false,error:'生成配置未通过回读验证，未替换原文件'};}
 if(c.kind==='toml'){const parsed=parseTomlEntry(next);if(!parsed.entry){svc.unlink(tmp);return {ok:false,error:'TOML回读失败，未替换原文件'};}}
 try{if((svc.exists(target)?svc.read(target):'')!==current)throw Error('配置写入期间发生并行修改');svc.rename(tmp,target);}catch(e){try{svc.unlink(tmp);}catch{}return {ok:false,error:e.message};}
 return {ok:true,mode,target,backupPath:f.exists?backupPath:null,dbPath:opts.dbPath||DATABASE_PATH,reloadRequired:true};
}
