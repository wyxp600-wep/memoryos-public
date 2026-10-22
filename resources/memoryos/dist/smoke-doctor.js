import { openDb } from "./db.js";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

let PASS = 0,
    FAIL = 0;
const ok = (n, cond, extra = "") => {
    if (cond) {
        PASS++;
        console.log(`  ✅ ${n}${extra ? "  " + extra : ""}`);
    } else {
        FAIL++;
        console.error(`  ❌ ${n}${extra ? "  " + extra : ""}`);
    }
};

const tmp = path.join(os.tmpdir(), `memdoctor-${process.pid}.db`);
const script = fileURLToPath(new URL("./doctor.js", import.meta.url));
const runDoctor = (extraArgs = []) =>
    spawnSync(process.execPath, [script, ...extraArgs], {
        env: { ...process.env, MEMORY_DB: tmp },
        encoding: "utf8",
    });

fs.rmSync(tmp, { force: true });
const db = openDb(tmp);
// 造一条记忆（最小列集）；随后 doctor 的 checkProvenance 应读到 0 条向量或已就位列结构
db.prepare(
    `INSERT INTO memories(id, content, project, status, agent, created_at) VALUES (1, 't', 'global', 'active', 'test', '2026-10-15T00:00:00Z')`
).run();
db.close();

// D1：--json 输出可解析 + 6 项体检全在
const j1 = runDoctor(["--json"]);
let parsed = null;
try {
    parsed = JSON.parse(j1.stdout);
} catch (e) {
    /* 空 stdout 也容忍 */
}
ok("D1.1 doctor --json 可解析", j1.status === 0 && parsed && Array.isArray(parsed.checks), `status=${j1.status}`);
ok("D1.2 体检项数=6", parsed?.checks?.length === 6, `(${parsed?.checks?.length})`);
const labels = parsed?.checks?.map((c) => c.label) ?? [];
ok(
    "D1.3 六项标签齐全",
    ["嵌入模式", "库实例 ID", "向量出处", "对账滞后", "daemon/采集最近活动", "内核重启次数"].every((l) =>
        labels.includes(l)
    ),
    `(${labels.join("/")})`
);

// D2：--fix 写入实例 ID 后，重跑应消除「库实例 ID」WARN
runDoctor(["--fix"]);
const j2 = runDoctor(["--json"]);
let parsed2 = null;
try {
    parsed2 = JSON.parse(j2.stdout);
} catch (e) {}
const inst = parsed2?.checks?.find((c) => c.label === "库实例 ID");
ok("D2.1 --fix 后实例 ID 项转 PASS", inst?.level === "pass", `(${inst?.level})`);

// D3：人类可读模式退出码 0（非交互体检不判 FAIL 时应可干净退出）
const human = runDoctor([]);
ok("D3.1 人类可读模式运行成功", human.status === 0 && /MemoryOS doctor/.test(human.stdout), `(status=${human.status})`);

fs.rmSync(tmp, { force: true });
console.log(`\n[smoke-doctor] PASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL ? 1 : 0);
