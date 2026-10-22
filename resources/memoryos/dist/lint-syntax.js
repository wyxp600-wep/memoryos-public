#!/usr/bin/env node
/**
 * MemoryOS — 全量语法门禁（A 分区维护；替代既往白名单式 node --check）
 *
 * 为何存在：既往 `npm run lint` 是**显式白名单**（25 个文件逐一手写 `node --check`），
 * 新文件只要不入白名单即逃过语法门禁——历史上 `dist/ingest.js`、`llm.js`、`embed.js`、
 * `skill-sync.js` 等产品模块都曾与此门禁失联，坏语法（如 `agent-stream.js` 半成品）
 * 可长期潜伏且 lint 仍全绿。
 *
 * 修法：枚举 `dist/*.js` 逐一 `node --check`，任何 .js 均不可逃出语法门禁，
 * 不再依赖手写白名单。属 §1 的 A 分区工具面。
 *
 * 用法：node dist/lint-syntax.js   退出码 0/1
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HEREDIR = path.dirname(fileURLToPath(import.meta.url));
const self = path.basename(import.meta.url);
const files = readdirSync(HEREDIR).filter((f) => f.endsWith(".js") && f !== self);

let pass = 0;
const fail = [];
for (const f of files.sort()) {
  const r = spawnSync(process.execPath, ["--check", path.join(HEREDIR, f)], { encoding: "utf8" });
  if (r.status === 0) {
    pass++;
  } else {
    const lines = (r.stderr || r.stdout || "").trim().split("\n");
    fail.push({ f, err: lines.filter(Boolean).pop() || "syntax error" });
  }
}

if (fail.length) {
  console.error(`lint-syntax: ${pass} PASS / ${fail.length} FAIL（覆盖 ${files.length} 个 dist/*.js）`);
  for (const { f, err } of fail) console.error(`  FAIL ${f} — ${err}`);
  process.exit(1);
}
console.log(`lint-syntax: 全覆盖 ${files.length} 个 dist/*.js，${pass} PASS / 0 FAIL`);
process.exit(0);