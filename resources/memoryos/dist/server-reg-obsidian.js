/**
 * P2-④（2026-09-22，A 分区接管 B 分区）：server.js MCP 工具面按域拆分 —— Obsidian 域（数量以 `--list-tools` 为准）。
 * ★ 2026-10-19 工具面整合：obsidian_import / obsidian_export / obsidian_write_note 三工具并成 obsidian 合并门
 *   （action=import/export/write_note；三者原均 L1/required、均不进无头预授权 —— 风险与审批语义逐字不变）。
 *   三分支返回文案与原工具逐字一致（错误前缀 obsidian_<action> 失败： 亦与原三串逐字对齐）。
 * 共享顶层名经 ctx 注入：db / agentName() / agentFpath()。
 */
import { z } from "zod";
import { memoryBodySchema } from "./memory-body.js";
import { importVault, exportMemories, writeNoteToVault } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";
import { agentName, agentFpath, envCredential } from "./server-tools.js"; // ★ 1b：调用方身份访问器（取代注册期冻结的进程常量）

export function registerObsidianTools(server, ctx) {
    const { db } = ctx;
    server.addTool({
        name: "obsidian",
        description: "Obsidian vault 同步门（action=import 增量导入 / export 导出 active 记忆 / write_note 写单条笔记并同步记忆库）。详规:tool_guide。",
        parameters: z.object({
            action: z.enum(["import", "export", "write_note"]).describe("子操作：import=vault .md 增量导入（幂等按内容哈希）；export=active 记忆导出为笔记（幂等不覆盖）；write_note=写单条笔记并同步记忆库（去重预检，绝不覆盖）"),
            vault: z.string().describe("Obsidian vault 绝对路径（import=含 .md 笔记的根目录；export=导出目录 = vault/MemoryOS 导出）"),
            title: z.string().optional().describe("action=write_note 必填：笔记标题（同时用作文件名）"),
            content: memoryBodySchema().optional().describe("action=write_note 必填：六字段换行正文（结论/关键词/适用范围/依据/行动/状态；关键词必填3～5项）"),
            type: z
                .enum(["decision", "experience", "pitfall", "convention"])
                .optional()
                .describe("action=write_note：记忆类型（默认 experience）；action=export：类型过滤"),
            project: z.string().optional().describe("import：project scope（默认取 vault 目录名）；export：scope 过滤（缺省=全部）；write_note：记忆库 scope（默认 global，所有 Agent 可检索）"),
            folder: z
                .string()
                .optional()
                .describe("action=write_note：vault 内子文件夹（默认 MemoryOS 写入；相对目录名，禁止 .. 穿越/绝对路径/盘符/UNC）")
                .refine((f) => !/\.\./.test(String(f)) && !/^[A-Za-z]:[\\/]/.test(String(f)) && !/^\\\\/.test(String(f)), { message: "folder 非法：禁止路径穿越（..）、绝对路径、盘符或 UNC" }),
            dry_run: z.boolean().default(false).describe("action=import：预演，只统计不落库"),
            limit: z.number().int().min(1).max(500).optional().describe("action=export：导出条数上限（按 id 升序）"),
        }),
        async execute(args) {
            try {
                if (args.action === "import") {
                    const embedder = await getEmbedder();
                    const stats = await importVault(db, embedder, {
                        vaultPath: args.vault,
                        project: args.project,
                        dryRun: args.dry_run,
                        agent: "obsidian",
                    });
                    return `扫描 ${stats.scanned} 个笔记 → 新增 ${stats.added} / 更新 ${stats.updated} / 去重合并 ${stats.merged} / 跳过 ${stats.skipped} / 失败 ${stats.failed}（project=${stats.project}${stats.dryRun ? "，dry-run 未落库" : ""}）`;
                }
                if (args.action === "export") {
                    const stats = exportMemories(db, {
                        vaultPath: args.vault,
                        project: args.project,
                        type: args.type,
                        limit: args.limit,
                    });
                    return `导出到 ${stats.dir}：写入 ${stats.written} / 跳过(已存在) ${stats.skipped} / 失败 ${stats.failed}`;
                }
                // action === "write_note"
                if (!args.title || !args.content)
                    return "obsidian_write_note 失败：action=write_note 需要 title 与 content。";
                const embedder = await getEmbedder();
                const result = await writeNoteToVault(db, embedder, {
                    vaultPath: args.vault,
                    title: args.title,
                    content: args.content,
                    type: args.type ?? "experience",
                    project: args.project ?? "global",
                    folder: args.folder,
                    agent: agentName(),
                    agent_fpath: agentFpath(),
                });
                return `已写入笔记 → ${result.notePath}（记忆 #${result.memoryId}，${result.created ? "新建" : "已存在→加时间戳后缀"}，project=${args.project ?? "global"}）`;
            }
            catch (e) {
                return `obsidian_${args.action} 失败：${e instanceof Error ? e.message : String(e)}`;
            }
        },
    });
}
