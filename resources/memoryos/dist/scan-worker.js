/** ★ 2026-10-15 启动加速：scanAgents 探测的 worker 执行体。
 *
 * scanAgents() 的 CLI 版本探测走 spawnSync（本机冷启动 ~2.1s 独占事件循环），
 * dashboard listen 后由 spawn 方（scan.js::primeScanAgentsInWorker）以 worker
 * 线程预热：spawnSync/同步 fs 在 worker 内执行不阻塞主事件循环，结果经
 * postMessage 回主线程写入共享缓存（cards/plans/desktop 三域共用）。
 * 失败/异常 → postMessage(null)，由调用方同步兜底。
 */
import { parentPort } from "node:worker_threads";
import { scanAgents } from "./scan.js";
try {
    parentPort?.postMessage(scanAgents());
}
catch {
    parentPort?.postMessage(null);
}
