/** ★ 2026-10-15 启动加速：skills/status 的重扫盘执行体（worker 线程版）。
 *
 * 背景：/api/skills/status 的 computeStatus()（同步 fs 扫盘 ~2.3s）+ detectSkillTargets()
 *   （→ scanAgents() spawnSync 全机探测 ~2.1s）在 dashboard 主线程里同步执行时，
 *   独占事件循环 ~4-5s，把首屏并发请求潮里排后的请求（含阻塞 load 事件的
 *   /echarts.min.js 同步脚本）全部堵到 10s+（CDP timeline 实证 load 事件 11.5s）。
 *
 * 原则：本 worker **只跑 computeStatus 的纯 fs 扫描**；detected 的 scanAgents 探测
 *   改由主线程 await scan.js 共享扫描（scanAgentsAsync）获得——探测 burst（几十个
 *   spawnSync 子进程）收敛到单独一个 scan worker，三流并发曾被实测拖慢主线程
 *   socket 传输（echarts 4590ms vs 无 burst 时 31ms）。
 */
import { parentPort } from "node:worker_threads";
import { computeStatus } from "./skill-sync.js";
try {
    parentPort?.postMessage(computeStatus());
}
catch (e) {
    // 扫盘异常 → 回 null，调用方走同步兜底
    parentPort?.postMessage(null);
}
