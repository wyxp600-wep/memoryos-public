/**
 * MemoryOS v0.3 — 冲突仲裁 TUI（M-2.4）
 * 处理 possible-conflict 队列（status=active 且 conflict_with 非空）。
 * 键：1 保留新 / 2 保留旧 / 3 合并 / 4 不冲突 / u 撤销 / s 跳过 / q 退出。
 * 所有裁决写 memory_events（before 快照），`u` 按快照完整还原。
 * R1 一致性：裁决只改状态、不动旧行，旧值不再出现由检索 `status='active'` 过滤保证。
 * 用法：node dist/arbitrate.js [--json]（--json=只列队列不交互）
 */
import { openDb, pendingConflicts, applyArbitration, undoLastArbitration } from "./db.js";
import { recordRegression } from "./regress.js";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url)); // fileURLToPath 正确 decode 中文路径
const db = openDb(dbPath);
const REGRESSION_JSONL = process.env.MEMORY_REGRESSION ?? path.join(path.dirname(dbPath), "regression_cases.jsonl");
function paint(q) {
    const p = q.pending;
    return [
        `[#${p.id}] ${p.type}|${p.agent}  conf=${p.confidence}   "${p.content}"`,
        `   ↳ 疑似与旧 #${q.old?.id ?? "?"}: ${q.old?.content ?? ""}`.slice(0, 200),
    ].join("\n");
}
function runQueue() {
    let queue = pendingConflicts(db);
    if (!queue.length) {
        console.log("当前无可仲裁的 possible-conflict 队列。");
        return;
    }
    let i = 0;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const step = () => {
        const q = queue[i];
        console.log(`\n[${i + 1}/${queue.length}] ${paint(q)}`);
        rl.question("操作 (1保留新 2保留旧 3合并 4不冲突 u撤销 s跳过 q退出) > ", (ans) => {
            const k = ans.trim().toLowerCase();
            if (k === "q")
                return rl.close();
            if (k === "u") {
                console.log("· " + undoLastArbitration(db));
                queue = pendingConflicts(db); // 撤销可能让已仲裁项回到队列
                if (i >= queue.length)
                    i = Math.max(0, queue.length - 1);
                return step();
            }
            if (k === "1" || k === "2" || k === "3" || k === "4") {
                // 先沉淀回归集（读仲裁前快照：conflict_with 尚未被清），再落库仲裁
                console.log("· " + recordRegression(db, REGRESSION_JSONL, q.pending.id, k));
                console.log("· " + applyArbitration(db, q.pending.id, k));
                i++;
                return i < queue.length ? step() : rl.close();
            }
            if (k === "s") {
                i++;
                return i < queue.length ? step() : rl.close();
            }
            console.log("  无效键，请重试。");
            return step();
        });
    };
    step();
}
const args = process.argv.slice(2);
if (args.includes("--json")) {
    const queue = pendingConflicts(db);
    console.log(JSON.stringify({ count: queue.length, items: queue.map((q) => ({ pending: q.pending.id, old: q.old?.id ?? null })) }));
}
else {
    runQueue();
}
