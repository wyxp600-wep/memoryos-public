/**
 * 接入向导单测（connectGuideFor + applyConnectWrite，注入内存 fsx，不碰真实配置）
 * G1 codex：可自动写 + TOML 片段为 [mcp_servers.memoryos] 键表风格（对齐本机工作实配，20261005）
 * G2 zcode（未实证载体）：canAutoWrite=false + 手动步骤非空，绝不自动写
 * G3 applyConnectWrite dry-run：返回预览（target/dbPath/preview）但不落盘
 * G4 applyConnectWrite 实际写：JSON 合并保键 / TOML 键表追加、备份、返回 backupPath；未实证 agent 返回 error
 * G5（20261005）坏 JSON 载体拒绝自动写（防覆盖坏文件）；已连接且库对齐拒绝重复写
 * 用法：node dist/smoke-guide.js
 */
import { connectGuideFor, applyConnectWrite } from "./scan.js";
import path from "node:path";
import os from "node:os";
const CODEX_TOML = path.join(os.homedir(), ".codex", "config.toml");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
function fakeAgent(id, name = id) {
    return { id, name, type: "CLI Agent", version: null, connected: false, path: null };
}
/** 内存文件系统（记录 writes / copies） */
function memFsx() {
    const files = {};
    const writes = [];
    const copies = [];
    return {
        fsx: {
            read: (p) => files[p] ?? "",
            exists: (p) => p in files,
            mkdir: () => { },
            copy: (p, d) => { copies.push(`copy:${p}->${d}`); files[d] = files[p] ?? "backup"; },
            write: (p, c) => { writes.push(p); files[p] = c; },
            rename: (p, d) => { if (!(p in files)) throw new Error("rename source missing"); files[d] = files[p]; delete files[p]; },
            unlink: (p) => { delete files[p]; },
        },
        files, writes, copies,
    };
}
// G1 codex：可自动写
const codexA = fakeAgent("codex", "OpenAI Codex CLI");
const m1 = memFsx();
const g1 = connectGuideFor(codexA, { read: (p) => m1.fsx.read(p) });
check("G1.codex canAutoWrite=true", g1.canAutoWrite === true, `auto=${g1.canAutoWrite}`);
check("G1.codex TOML 片段为键表 [mcp_servers.memoryos]（对齐实配）", (g1.attachSnippet || "").includes("[mcp_servers.memoryos]") && !(g1.attachSnippet || "").includes("[[mcp_servers]]"), (g1.attachSnippet || "").split("\n")[0]);
check("G1.codex 片段 env 含 MEMORY_DB+MEMORY_AGENT+EMBED_MODE（20261005 补全）", (g1.attachSnippet || "").includes("MEMORY_DB") && (g1.attachSnippet || "").includes('MEMORY_AGENT = "codex"') && (g1.attachSnippet || "").includes('MEMORYOS_MCP_MODE = "shim"'));
check("G1.codex guide 携带 dbMatches/importSnippet 新字段", "dbMatches" in g1 && !!g1.importSnippet && !!g1.fileSnippet, `shape=${g1.carrierShape}`);
// G2 未实证（zcode）→ 手动
const zcodeA = fakeAgent("unsupported-client", "未知客户端");
const g2 = connectGuideFor(zcodeA, { read: () => "" });
check("G2.zcode canAutoWrite=false", g2.canAutoWrite === false);
check("G2.zcode manualSteps 非空", !!g2.manualSteps && g2.manualSteps.length > 0, `steps=${g2.manualSteps?.length}`);
check("未知客户端不返回猜测JSON",g2.manualSnippet===null&&!g2.importSnippet);
check("未知客户端明确说明配置入口未确认",g2.manualSteps?.some(s=>s.includes("未确认")));
check("未知客户端没有伪造的双格式",!g2.importSnippet&&!g2.importSnippetDoc);
check("未知客户端不提供错误mcpServers模板",!g2.importSnippetDoc);
// G3 dry-run：codex 返回预览但不落盘（20261005 契约：返回 target/dbPath/preview）
const m3 = memFsx();
m3.files[CODEX_TOML] = ""; // 已存在空 config
const r3 = applyConnectWrite(codexA, { dryRun: true }, m3.fsx);
check("G3.dry-run ok", r3.ok === true);
check("G3.dry-run 返回 target/dbPath/preview", !!r3.target && !!r3.dbPath && typeof r3.preview === "string", `mode=${r3.mode}`);
check("G3.dry-run 未落盘（无 rename 落定）", m3.writes.length === 0, `writes=${m3.writes.length}`);
// G4 实际写：JSON 载体解析合并保键（claude 载体 round-trip，20261005）
const m4 = memFsx();
m4.files[CLAUDE_JSON] = JSON.stringify({ version: 1, mcpServers: { other: { command: "x" } }, projects: { a: {} } });
const claudeA = fakeAgent("claude", "Claude Code");
const r4 = applyConnectWrite(claudeA, {}, m4.fsx);
const after = JSON.parse(m4.files[CLAUDE_JSON]);
check("G4.claude 合并写 ok + backup", r4.ok === true && !!r4.backupPath, `mode=${r4.mode}`);
check("G4.claude 保留既有键（version/projects/other）", after.version === 1 && !!after.projects && !!after.mcpServers.other, Object.keys(after).join(","));
check("新配置默认使用共享内核shim",after.mcpServers.memoryos?.env?.MEMORYOS_MCP_MODE === "shim");
check("G4.claude 写前备份(copy)", m4.copies.length === 1, `copies=${m4.copies.length}`);
// G4b 坏 JSON 拒绝自动写（防覆盖坏文件，20261005）
const m4b = memFsx();
m4b.files[CLAUDE_JSON] = '{"a":1}{"mcpServers":{}}';
const r4b = applyConnectWrite(claudeA, {}, m4b.fsx);
check("G4b.坏 JSON 拒绝自动写", r4b.ok === false && r4b.carrierInvalid === true, `err=${(r4b.error || "").slice(0, 40)}`);
check("G4b.坏 JSON 原文件未被覆盖", m4b.files[CLAUDE_JSON] === '{"a":1}{"mcpServers":{}}');
// G4c TOML 载体键表化追加（对齐本机工作实配，20261005）
const m4c = memFsx();
m4c.files[CODEX_TOML] = "model = \"gpt-5\"\n[sandbox_workspace_write]\nnetwork_access = true\n";
const r4c = applyConnectWrite(codexA, {}, m4c.fsx);
check("G4c.codex TOML 追加键表段 ok", r4c.ok === true && r4c.mode === "append", `mode=${r4c.mode}`);
check("G4c.codex TOML 含键表段且无数组表", (m4c.files[CODEX_TOML] || "").includes("[mcp_servers.memoryos]") && !(m4c.files[CODEX_TOML] || "").includes("[[mcp_servers]]"));
check("G4c.codex 原 TOML 内容保留", (m4c.files[CODEX_TOML] || "").includes("model = \"gpt-5\""));
// G4d 已连接且库对齐 → 拒绝重复写；库不一致 → 允许改库（修复「改库按钮永远无效」，20261005）
const m4d = memFsx();
m4d.files[CLAUDE_JSON] = JSON.stringify({ mcpServers: { memoryos: { command: "node", args: ["C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/dist/server.js"], env: { MEMORY_DB: path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "MemoryOS", "data", "memory.db").split(path.sep).join("/") } } } });
const r4d = applyConnectWrite(claudeA, {}, m4d.fsx);
check("旧配置缺少身份元数据时可修复",r4d.ok===true);
const m4e = memFsx();
m4e.files[CLAUDE_JSON] = JSON.stringify({ mcpServers: { memoryos: { command: "node", args: ["C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/dist/server.js"], env: { MEMORY_DB: "C:/somewhere/else.db" } } } });
const r4e = applyConnectWrite(claudeA, {}, m4e.fsx);
check("G4e.库不一致允许修复性重写", r4e.ok === true, `err=${(r4e.error || "").slice(0, 40)}`);
const afterE = JSON.parse(m4e.files[CLAUDE_JSON]);
check("G4e.改库后 MEMORY_DB 指向生产库", String(afterE.mcpServers.memoryos?.env?.MEMORY_DB || "").toLowerCase().includes("memoryos"), String(afterE.mcpServers.memoryos?.env?.MEMORY_DB || "").slice(-40));
const r5 = applyConnectWrite(zcodeA, {}, m4.fsx);
check("G4.zcode 拒绝自动写(error)", r5.ok === false && !!r5.error, `err=${(r5.error || "").slice(0, 30)}`);
// G6（20261005）qoder：settings.json 载体可自动写（合并保留 enabledPlugins）+ 整份文档片段形状正确
const qoderA = fakeAgent("qoder", "Qoder");
const m6 = memFsx();
m6.files[CODEX_TOML.replace(".codex\\config.toml", ".qoder\\settings.json")] = JSON.stringify({ enabledPlugins: { "qoder-context@qoderapp-bundler": true } });
const r6 = applyConnectWrite(qoderA, {}, m6.fsx);
check("G6.qoder settings.json 合并写 ok", r6.ok === true, `mode=${r6.mode}`);
const g6 = connectGuideFor(qoderA, { read: (p) => m6.fsx.read(p) });
check("G6.qoder guide 双格式", !!g6.importSnippet && !!g6.importSnippetDoc, `doc-has-mcpServers=${(g6.importSnippetDoc || "").includes("mcpServers")}`);
check("G6.qoder 整份文档顶层为 mcpServers 对象", (() => { try { const d = JSON.parse(g6.importSnippetDoc); return typeof d.mcpServers === "object" && !!d.mcpServers.memoryos; } catch { return false; } })());
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
