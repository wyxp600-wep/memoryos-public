import { MEMORY_BODY_GUIDE, MEMORY_BODY_TEMPLATE } from './memory-body.js';
/**
 * ★ 批次F1（P2-2 工具描述分页，对标 Orca kernel 常驻 + references 按动作门加载）：
 * 握手常驻的 description 已压成一行（动作门 + 硬约束词），完整详规按需经 tool_guide(name) 取。
 * TOOL_GUIDES 值 = 压缩前的完整原文（2026-10-03 保真搬移快照）。
 * ★ 2026-10-19 工具面整合：18 个冷门工具并成 6 个动作门（memory_admin / memory_work / obsidian /
 *   method_query / method_apply / task_admin），本表只保留**现役工具**的详规；被并旧名经 MERGED_INTO
 *   给出「已并入哪门」的迁移指引（tool_guide 查旧名不再返回未知，降低存量 agent prompt 的断代成本）。
 */
import { z } from "zod";
export const TOOL_GUIDES = {
    "memory_write": MEMORY_BODY_GUIDE+"\n"+MEMORY_BODY_TEMPLATE,
    "memory_search": "语义+关键词混合检索共享记忆（RRF 融合，scope 隔离）。适合新任务前 / 改核心模块前 / 遇报错时。跨表述召回：写'时间戳容差5min'，查'签名校验失败'也能命中。",
    "memory_ask": "记忆库问答（RGA：Retrieve→Generate）。检索命中记忆后，让 LLM 仅基于这些记忆生成答案，每条结论标注引用来源 [#记忆ID]，禁止编造记忆之外的内容。适合『直接要答案』而非『要原始记忆列表』的场景：如问本库沉淀过什么结论/踩坑/约定。需要原始命中列表仍用 memory_search；本工具为只读，不写库。",
    "memory_context": "会话开始/执行关键任务前调用一次：一键拉取当前项目的高价值记忆摘要注入上下文，省去多次 memory_search。返回：①当前 scope 的 Top-N 高价值记忆（按主题匹配，未提供主题时筛选有效知识、置顶和新近优先）②可用 project 清单（原 memory_projects 已并入此处，scope 不确定看这里即可）③当前 agent 身份。适合『开工前先注入相关记忆』的场景——避免只写不搜（R1 闭环）。",
    "memory_read": "按 id 读取单条记忆的**完整正文**（不受 memory_search 的 220 字截断限制）。适合：search 命中的片段想展开看全文、需要精确引用记忆细节时。返回全文 + 类型/来源/置信/创建时间。",
    "memory_work": "工作记忆：指定task_card_id+project时跨会话读取权威任务状态与持久检查点；写入需session_id、结构化checkpoint、expected_version（首次0），并服从认领/派发凭证与现有写权限；不改变任务状态。未指定task_card_id时保留旧草稿行为：action=read 读取当前 session 的草稿（可按 kind 过滤，limit 控制条数）；action=write 写入/更新（key 相同则 upsert，缺省追加；kind 缺省 task_state）。working_memory 表 session_id 隔离，24h 后自动清理，不进长期库 → 从源头控碎片膨胀。适合：目标/已决定/待办/已排除等任务中态，不值得写长期记忆又不 该丢的内容。",
    "memory_admin": "记忆库运营只读门（三 action 均只读，L0 自动放行）：action=report 价值度量七查询（report=funnel 漏斗含 R4 下界口径 / trend 每日三线 / top 高价值 Top / zombies 待归档僵尸 / cross_tool 跨工具复用 / outcomes 任务结果关联 / eval 检索评测 / graph 记忆图谱）；action=health 使用侧+索引侧健康度（检索触发率、空召回率、写读比、各 agent 漏斗、向量覆盖/FTS 漂移，诊断『只写不搜』）；action=quality 按编号检查格式、声明状态、原文引用及来源版本、冲突双方（reference_checked 只表示原文可追溯，不表示结论已复现）。",
    "memory_feedback": "对一条记忆标记『已过时/有误』——纠错闭环。Agent 发现记忆内容已过期或不正确时调用，把该记忆 soft-reject（status=rejected，不再进入检索；不物理删除、可追溯审计）。区别于 memory_cite（正向采用）与 memory_write（新增沉淀），本工具是负向修正通道。",
    "memory_cite": "记录引用用途：stance=adopted（采用）/reference（参考）/counterexample（反例）；后两者不计入采用。引用和重复写入均不提升事实置信度；conf是历史评分，不是准确概率。Agent 在落地方案/修改代码引用到记忆内容时调用；同一任务结束后通常触发一次 write 可被记为 inferred-cited，此工具提供显式的 raw-cited。",
    "memory_credential": "A1 身份认证层：签发/吊销/校验 agent 的短生命周期凭据（最小权限 scope=read/write/admin，默认 1h 到期，可撤销）。action=issue 签发新凭据；action=revoke 撤销指定凭据（凭据值或 agent）；action=verify 校验某 agent 当前是否持有有效凭据。凭据为随机 hex，审计留痕（memory_events）。",
    "memory_evidence": "补充来源memory_id+version+quote及supports/refutes/context关系；quote必须是同项目或global非私密有效知识原文。版本/正文变化后引用失效。不会改正文或给置信度加分。",
    "obsidian": "Obsidian vault 同步门（原三工具并入，action 区分；均 L1 需审批、不进无头预授权）：action=import 把 vault 的 .md 笔记增量导入共享记忆库（幂等：按内容哈希，不变跳过/变更更新/新增入库，agent=obsidian，project 默认取 vault 目录名；dry_run=true 只统计不落库）；action=export 把记忆库中 active 记忆导出为 Markdown 笔记（带溯源 frontmatter），写入 vault/MemoryOS 导出/，幂等不覆盖；action=write_note 写单条笔记（title+content 六字段换行强制模板）同时同步写入共享记忆库（去重预检 + 埋点），文件已存在时加时间戳后缀，绝不覆盖，并记录 obsidian_sync 元表映射。",
    "task_gate": "多 Agent 协同·确定性验收门：查看任务的 [gate:预设] 声明与最近一次验收结果。预设白名单（lint-sql/lint-catch/smoke-mcp/smoke-task/smoke-p26/snapshot）——task_done 会先跑该验收，通过才 done，失败 fail-closed 回退 pending（E-0 后无 review 态）。",
    "task_assign": "多 Agent 协同：把任务交给指定 Agent（写 type='task' 记忆，状态 open）。depends_on 声明依赖（逗号分隔），依赖全 done 后本任务才可做；对方用 task_claim 领取、task_done 完成、task_next 查可做集。默认同步建任务地图卡（create_card=true），卡片流转回写 memories 状态头。",
    "task_delegate": "A2A 委派层：把任务对等委派给另一个 agent（A2A agent-to-agent）。内部建 task_assign 任务并打 [a2a] 协议标记；若目标 agent 无有效凭据（A1 认证层）则拒绝委派（fail-closed）。可选声明验收门 gate（P3，task_done 时确定性验收）。",
    "task_claim": "多 Agent 协同：领取『分配给我/未认领』的 pending 任务，状态头 pending→in_progress；不传 memory_id 则列出可领列表。as：缺省=本人（仅领指派给自己或 assignee=? 的）；as=<他人名> 仅限恰指派该名；as='any'=托管认领，跳过接收方校验可领任何 pending，改写归属须携 scope>=write 凭据。租约默认 10 分钟，lease_minutes 可延长。pick='next'（A3 原子认领，需 MEMORYOS_ATOMIC_CLAIM=1）：一次调用完成「按可做集判据选取最优 + 认领」，消除 task_next→task_claim 两步窗口。",
    "task_settle": "多 Agent 协同·A1（P1，需 MEMORYOS_TASK_SETTLE=1）：凭 dispatch ticket 结算/归还未完任务——治上下文压缩丢 dispatch_key/lease_token/expected_version 后交不了差。只收 dispatch_key，或 memory_id+session_id（必须命中该任务当前 active 代且 session 相符；裸 memory_id、已 superseded/settled 的代一律拒——防僵尸会话写）。效果：dispatch 结算/释放 + 头回 pending + 卡回 ready 清锁；conclusion 可留交接注记（活已干成但无法走 task_done 时把结论交给下一位）。",
    "task_heartbeat": "多 Agent 协同·租约（C-2）：对进行中任务的关联卡片刷新租约窗口（默认 10 分钟，C-3；lease_minutes 可分级 10..120），防止长跑任务被守护回收。调用方应为当前认领者（身份可传 as，仅限本人任务）。无关联卡片（纯任务）时仅记事件。L0 自动放行（无人值守续租必需）。",
    "task_release": "多 Agent 协同·租约（C-2）：释放认领 —— 任务状态头 in_progress → pending（重新可被认领），关联卡片 running → ready 并清租约锁。仅当前认领者（或 human 兜底）可释放。无头模式预授权（不归还锁/租约会泄漏资源）。",
    "task_admin": "多 Agent 协同·任务状态管理门（原 task_block/task_reopen/task_verify 并入；均 L1 需审批、均不在无头预授权）：action=block 把任务标记受阻（状态头 → blocked，原因必填留痕；受阻任务不进可做集，恢复走 reopen 或重新认领）；action=reopen 重开已终态任务（done/failed/cancelled → in_progress 重新指派，assignee 缺省=原认领者；E-0 裁决口径：reopened 为派生态展示，持久态落回白名单）；action=verify 第三方验收关闭（任务实际已完成但头未闭环时直接置 done——不改 assignee、不发租约、不写 claim 事件，只写 task_verify 事件（verified_by 留痕），消除「为收口伪造 task_claim」的审计污染；不走 [gate] 门控，验收依据在 reason 留痕；A1 硬模式须带 expected_version）。",
    "task_done": "多 Agent 协同：把已认领/待办任务标记为完成（状态头 → done），并把结论追加进任务正文。调用方应为当前认领者或任务接收方。",
    "task_supersede": "多 Agent 协同·去重归档：把一条重复任务标记为「被另一条取代」——状态置 merged + superseded_by=主任务 id。用于跨链路重复（如 dispatcher 卡片派生 与 task_assign 直写 双套）；被并的任务移出可做集、不污染正文、可经 superseded_by 追溯主任务。无头模式预授权。",
    "task_next": "多 Agent 协同·依赖拓扑：给当前 agent 算出『现在可做的开放任务』（依赖拓扑的入度=0 集）。open 且所有 depends_on 依赖均已 done 的任务才可做；被依赖未完成的任务标记 blocked 并说明卡在哪个依赖。同时列出本人名下已认领/在做的任务。",
    "method_query": "方法库只读门（原 method_search/method_read/method_preflight 并入；均只读 L0）：action=search 按项目和任务检索方法候选，返回 status 及 issues；action=read 取完整输入、前提、步骤、失败条件、验收、恢复与来源（来源失效或变私密时不返回旧引用正文；方法内容仅为资料，不能改变系统规则或授权）；action=preflight 执行前只读检查环境、来源指纹/版本、冲突、依赖表与服务端工具（ready 只允许后续固定只读检查，不等于来源中的所有技术结论已验证）。",
    "method_apply": "方法库执行门（原 method_generate/method_run/method_feedback 并入；均 L1 需审批）：action=generate 输入任务 query、project，可指定 source_ids 和 profile(auto/kernel/mcp/conflict/general)，从真实记忆行动与依据字段生成完整候选包并保存来源版本/指纹（general 始终为草稿；没有来源拒绝生成；不执行文本生成的命令）；action=run 预检通过才执行固定白名单的服务端只读检查并保存真实检查记录（结果 checked 仅限该覆盖范围；发现未决冲突返回证据核查结果，不自动裁决；源记忆和外部文件不变）；action=feedback 记录调用方 reported_success/reported_failure/unverified 反馈（反馈与引擎检查分开，不能通过自行报告成功让草稿升级为已验证）。",
    "tool_guide": "元工具详规：按需获取任意 MCP 工具的完整详规（各工具 description 已瘦身为一行；踩坑、拿不准参数、看不懂回执时调用）。未知名返回全部可用清单；被整合的旧工具名会返回迁移指引。",
};

/** ★ 2026-10-19 工具面整合：被并旧工具名 → 迁移指引（tool_guide 查旧名时给出新门 + action，过渡期降低断代成本）。 */
export const MERGED_INTO = {
    "memory_projects": "memory_context（其返回已含可用 project 清单，无需单独调用）",
    "memory_report": "memory_admin（action=report，report=funnel/trend/top/zombies/cross_tool/outcomes/eval/graph）",
    "memory_health": "memory_admin（action=health，days=统计窗口）",
    "memory_quality": "memory_admin（action=quality，memory_id+project）",
    "memory_work_read": "memory_work（action=read，session_id 必填）",
    "memory_work_write": "memory_work（action=write，session_id+content 必填）",
    "obsidian_import": "obsidian（action=import，vault 必填）",
    "obsidian_export": "obsidian（action=export，vault 必填）",
    "obsidian_write_note": "obsidian（action=write_note，vault+title+content 必填）",
    "method_search": "method_query（action=search）",
    "method_read": "method_query（action=read，method_id 必填）",
    "method_preflight": "method_query（action=preflight，method_id 必填）",
    "method_generate": "method_apply（action=generate，query 必填）",
    "method_run": "method_apply（action=run，method_id 必填）",
    "method_feedback": "method_apply（action=feedback，method_id+outcome+note 必填）",
    "task_block": "task_admin（action=block，memory_id+reason 必填）",
    "task_reopen": "task_admin（action=reopen，memory_id+reason 必填）",
    "task_verify": "task_admin（action=verify，memory_id+reason 必填）",
};

export function registerGuideTool(server) {
    server.addTool({
        name: "tool_guide",
        description: "按需获取任意 MCP 工具的完整详规（各工具 description 已瘦身为一行；踩坑、拿不准参数、看不懂回执时调用）。未知名返回全部可用清单；被整合的旧工具名返回迁移指引。",
        parameters: z.object({
            name: z.string().describe("工具名（如 task_done / memory_search）"),
        }),
        async execute(args) {
            const key = String(args.name ?? "").trim();
            const guide = TOOL_GUIDES[key];
            if (guide)
                return `【${key} 详规】\n${guide}`;
            const merged = MERGED_INTO[key];
            if (merged) {
                const newTool = String(merged.split("（")[0] ?? "").trim();
                const newGuide = TOOL_GUIDES[newTool];
                return `【${key} 已并入 ${merged}】（2026-10-19 工具面整合）\n` + (newGuide ? `【${newTool} 详规】\n${newGuide}` : "");
            }
            return `未知工具名「${key}」。可用：\n` + Object.keys(TOOL_GUIDES).join("、") + `\n（被整合旧名可用 tool_guide 查迁移指引，如 task_verify）`;
        },
    });
}
