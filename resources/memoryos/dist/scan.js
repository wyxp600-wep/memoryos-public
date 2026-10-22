/** 客户端发现与连接统一入口；所有耗时系统探测均在worker内执行。 */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {Worker} from 'node:worker_threads';
import {discoverInstalledAgents,findCarrier} from './agent-discovery.js';
import {connectGuide,writeConnection,readCarrier,publicFacts,carrierFor,DATABASE_PATH} from './agent-adapters.js';
export const MEMORYOS_DB_PATH=DATABASE_PATH;
function customPath(){return path.join(process.env.APPDATA||path.join(os.homedir(),'AppData/Roaming'),'MemoryOS/agents.custom.json');}
export function loadCustomAgents(){try{const r=JSON.parse(fs.readFileSync(customPath(),'utf8'));return Array.isArray(r)?r.filter(a=>a&&typeof a.name==='string'&&a.name.trim()):[];}catch{return [];}}
export function saveCustomAgents(rows){fs.mkdirSync(path.dirname(customPath()),{recursive:true});fs.writeFileSync(customPath(),JSON.stringify(rows,null,2));}
export function probeCarrier(dir){const file=findCarrier(dir);return file?{file,connected:readCarrier(file).declares}:null;}
export function discoverCarrierAgents(home=os.homedir()){return discoverInstalledAgents({home,commands:{},systemInventory:{items:[]}}).agents.filter(a=>a.configFile);}
export function readCarrierFacts(file,svc){return publicFacts(readCarrier(file,svc));}
export function connectGuideFor(a,svc,opts){return connectGuide(a,svc,opts);}
export function applyConnectWrite(a,opts,svc){return writeConnection(a,opts,svc);}
export function scanAgents(opts={}){return discoverInstalledAgents({...opts,custom:opts.custom??loadCustomAgents()});}
let cache=null,at=0,inflight=null,epoch=0;
export function getScanCachedShared(){return cache&&Date.now()-at<60000?cache:null;}
function workerScan(){return new Promise((resolve,reject)=>{const w=new Worker(new URL('./scan-worker.js',import.meta.url));const timer=setTimeout(()=>{w.terminate();reject(Error('本机扫描超过25秒，保留上次结果'));},25000);let settled=false;
 const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);w.terminate();err?reject(err):resolve(value);};w.once('message',v=>v?finish(null,v):finish(Error('本机扫描未返回结果')));w.once('error',e=>finish(e));w.once('exit',code=>{if(!settled)finish(Error('扫描线程提前退出：'+code));});});}
export async function scanAgentsAsync(){const hit=getScanCachedShared();if(hit)return hit;if(inflight){await inflight.promise;return getScanCachedShared()??scanAgentsAsync();}const version=epoch;const promise=workerScan().then(v=>{if(version===epoch){cache=v;at=Date.now();}return v;});inflight={promise};try{return await promise;}finally{if(inflight?.promise===promise)inflight=null;}}
export function primeScanAgentsInWorker(){if(getScanCachedShared()||inflight)return;void scanAgentsAsync().catch(()=>{});}
export function clearScanCache(){epoch++;at=0;cache=null;}
