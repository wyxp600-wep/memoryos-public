/** 安装证据与配置分开；不将备份、技能目录当作已安装客户端。 */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {carrierFor,adapterIds,readCarrier,publicFacts} from './agent-adapters.js';
export const AGENT_CATALOG=[
 ['codex','Codex','codex',/^(?:codex|openai[ .-]*codex)$/i],['claude','Claude Code','claude',/^claude[ -]*code$/i],['claude-desktop','Claude 桌面版',null,/^claude$/i],
 ['workbuddy','WorkBuddy',null,/^workbuddy$/i],['workbuddy-ai','WorkBuddy AI',null,/^workbuddy[ -]*ai$/i],['zcode','ZCode',null,/^zcode$/i],
 ['traecode','Trae CN',null,/^trae(?: cn)?$/i],['traework','TRAE SOLO CN',null,/^trae solo(?: cn)?$/i],['qoder','Qoder','qoder',/^qoder$/i],
 ['opencode','OpenCode','opencode',/^(?:@opencode(?:desktop)?|opencode)$/i],['vscode','VS Code','code',/^(?:microsoft )?(?:visual studio code|vs code)$/i],
 ['cursor','Cursor','cursor',/^cursor$/i],['windsurf','Windsurf','windsurf',/^windsurf$/i],['minimax','MiniMax Code',null,/^minimax code$/i],
 ['dsh','DeepSeek Harness','dsh',/^(?:deepseek harness|dsh desktop)$/i],['commandcode','Command Code',null,/^command code$/i],['mimo','Xiaomi MiMo','mimo',/^xiaomi mimo$/i],
 ['pi-agent','Pi Agent','pi',/^pi agent(?: desktop)?$/i],['qwen','Qwen Code','qwen',/^qwen(?: code)?$/i],['gemini','Gemini CLI','gemini',/^gemini(?: cli)?$/i],
 ['codebuddy','CodeBuddy','codebuddy',/^codebuddy$/i],['antigravity','Antigravity',null,/^antigravity$/i],['copilot','GitHub Copilot','copilot',/^github copilot$/i],
 ['zhipu','智谱清言',null,/^智谱清言$/],['codexpp','Codex++',null,/^codex\+\+$/i]
];
const EXCLUDE=/(?:backup|delete|archive|pending|\.bak|uninstall|updater|sandbox|code-mode-host|computer-use|repair|credential|crashpad)/i;
function exeIn(dir){try{const names=fs.readdirSync(dir);const exes=names.filter(n=>/\.exe$/i.test(n)&&!EXCLUDE.test(n)&&!/helper|crashpad|notification|setup|launcher/i.test(n));if(exes.length)return path.join(dir,exes[0]);for(const sub of ['app','bin']){const f=path.join(dir,sub);if(fs.existsSync(f)){const hit=fs.readdirSync(f).find(n=>/\.exe$/i.test(n)&&!EXCLUDE.test(n));if(hit)return path.join(f,hit);}}}catch{}return null;}
function windowsInventory(){
 const script="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $ErrorActionPreference='SilentlyContinue'; $items=@(); Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'codex|claude|workbuddy|trae|qoder|opencode|cursor|windsurf|mimo|zcode|Code.exe' -and $_.ExecutablePath } | ForEach-Object { $items+=@{label=[IO.Path]::GetFileNameWithoutExtension($_.ExecutablePath);path=$_.ExecutablePath;source='运行进程'} }; Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -match 'codex|claude|workbuddy|trae|qoder|opencode|cursor|windsurf|mimo|deepseek|zcode|visual studio code' } | ForEach-Object { $items+=@{label=$_.DisplayName;path=$_.InstallLocation;icon=$_.DisplayIcon;source='系统安装登记'} }; @((Get-AppxPackage -Name '*Codex*');(Get-AppxPackage -Name '*Claude*')) | ForEach-Object { $items+=@{label=$_.Name;path=$_.InstallLocation;source='系统应用包'} }; $lnkShell=New-Object -ComObject WScript.Shell; @([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu')) | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -Recurse -Depth 3 | Where-Object { $_.BaseName -match 'codex|claude|workbuddy|trae|qoder|opencode|cursor|windsurf|mimo|deepseek|zcode|visual studio code|Command Code|Pi Agent|Antigravity|Copilot' } | ForEach-Object { $target=$lnkShell.CreateShortcut($_.FullName).TargetPath; if($target -match '^[A-Za-z]:') { $items+=@{label=$_.BaseName;path=$target;source='开始菜单快捷方式'} } } }; ConvertTo-Json -InputObject @($items) -Compress";
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:1024*1024});
 try{const items=JSON.parse(String(r.stdout||'[]').replace(/^\uFEFF/,''));return {items:Array.isArray(items)?items:[],error:r.error?'系统安装信息读取超时或失败':null};}catch{return {items:[],error:'系统安装信息未返回有效结果'};}
}
export function discoverInstalledAgents({home=os.homedir(),platform=process.platform,systemInventory=null,commands=null,custom=[]}={}){
 const found=new Map(),errors=[];
 function add(id,evidence){const def=AGENT_CATALOG.find(a=>a[0]===id);if(!def)return;let a=found.get(id);if(!a){a={id,name:def[1],type:'本机智能体',version:null,path:null,installed:false,installations:[],evidence:[],connected:false};found.set(id,a);}if(evidence.path&&fs.existsSync(evidence.path)){a.installed=true;a.path??=evidence.path;if(!a.installations.some(i=>i.path===evidence.path))a.installations.push(evidence);}a.evidence.push(evidence.source);}
 const programs=path.join(home,'AppData/Local/Programs');try{for(const e of fs.readdirSync(programs,{withFileTypes:true})){if(!e.isDirectory()||EXCLUDE.test(e.name))continue;const def=AGENT_CATALOG.find(a=>a[3].test(e.name));if(!def)continue;const dir=path.join(programs,e.name),exe=exeIn(dir);if(exe)add(def[0],{path:exe,source:'安装目录中的可执行文件',variant:'桌面版'});}}catch{}
 if(platform==='win32'){
  const inventory=systemInventory??windowsInventory();if(inventory.error)errors.push(inventory.error);
  for(const item of inventory.items??[]){if(EXCLUDE.test(item.label||'')||EXCLUDE.test(path.basename(item.path||'')))continue;let label=item.label||'';
   let id=/openai.codex|[\\/]WindowsApps[\\/]OpenAI.Codex|[\\/]OpenAI[\\/]Codex/.test(item.path||'')?'codex':/WorkBuddyAI/i.test(item.path||'')?'workbuddy-ai':null;
   const def=id?AGENT_CATALOG.find(a=>a[0]===id):AGENT_CATALOG.find(a=>a[3].test(label));if(!def)continue;let exe=item.path;
   if(exe&&fs.existsSync(exe)&&fs.statSync(exe).isDirectory())exe=exeIn(exe);
   if((!exe||!fs.existsSync(exe))&&item.icon){const icon=item.icon.replace(/^"(.*?)".*$/,'$1').replace(/,\d+$/,'');if(fs.existsSync(icon))exe=icon;}
   if(exe&&/\.exe$/i.test(exe)&&!EXCLUDE.test(path.basename(exe)))add(def[0],{path:exe,source:item.source,variant:'桌面版'});
  }
 }
 for(const def of AGENT_CATALOG){if(!def[2])continue;let cmd=commands?.[def[2]];
  if(commands==null){const r=spawnSync(platform==='win32'?'where.exe':'which',[def[2]],{encoding:'utf8',timeout:1500,windowsHide:true});cmd=String(r.stdout||'').split(/\r?\n/).map(s=>s.trim()).find(Boolean);}
  if(cmd&&fs.existsSync(cmd))add(def[0],{path:cmd,source:'PATH命令',variant:'CLI'});
 }
 for(const [id,rel] of [['zhipu','AppData/Local/ZP/chatglm/智谱清言.exe'],['copilot','AppData/Local/Programs/GitHub Copilot/github.exe']]){const file=path.join(home,rel);if(fs.existsSync(file))add(id,{path:file,source:'已核验的安装可执行文件',variant:'桌面版'});}
 for(const id of adapterIds){const c=carrierFor({id},home);if(c.file&&fs.existsSync(c.file)){let a=found.get(id);if(!a){const def=AGENT_CATALOG.find(d=>d[0]===id);a={id,name:def?.[1]??id,type:'仅发现配置',installed:false,path:null,installations:[],evidence:['发现客户端配置，未确认安装'],connected:false};found.set(id,a);}a.configFile=c.file;}}
 for(const a of found.values()){const c=carrierFor(a,home);if(c.file)a.configFile=c.file;a.type=a.installed?(a.installations.some(i=>i.variant==='CLI')?'CLI / 桌面智能体':'桌面智能体'):'仅发现配置';a.evidence=[...new Set(a.evidence)].join('；');a.configured=c.file?readCarrier(c.file,{},c.kind).declares:false;}
 for(const c of custom){const id=String(c.id||c.name||'').toLowerCase().replace(/[^a-z0-9-]/g,'')||'custom-'+Buffer.from(c.name).toString('hex').slice(0,20);if(found.has(id))continue;const configFile=c.configFile||findCarrier(c.configDir);found.set(id,{id,name:c.name,type:'手动登记',installed:!!(c.path&&fs.existsSync(c.path)),path:c.path||null,configFile,configDir:c.configDir,connected:false,evidence:'用户登记'});}
 return {agents:[...found.values()],total:found.size,connected:0,scannedAt:new Date().toISOString(),errors};
}
export function findCarrier(dir){if(!dir)return null;for(const name of ['config.toml','mcp.json','.mcp.json','settings.json','opencode.json','opencode.jsonc','config.json','cli/config.json']){const file=path.join(dir,name);if(!fs.existsSync(file))continue;const f=readCarrier(file);if(f.declares||f.cfg?.mcpServers||f.cfg?.mcp?.servers||f.cfg?.servers)return file;}try{for(const sub of fs.readdirSync(path.join(dir,'connectors'))){const f=path.join(dir,'connectors',sub,'mcp.json');if(fs.existsSync(f)&&readCarrier(f).declares)return f;}}catch{}return null;}
