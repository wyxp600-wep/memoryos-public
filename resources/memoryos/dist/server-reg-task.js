/**
 * P2-④（2026-09-22，A 分区接管 B 分区）：server.js MCP 工具面按域拆分 —— 任务域（数量以 `--list-tools` 为准）。
 *
 * ★ Step 0（2026-10-18，架构收敛）：本文件已收敛为**纯传输层** ——
 *   领域逻辑（任务头解析 / 状态机 / CAS 认领 / 门控 / dispatch 语义 / 卡片投影 / 回执文案）
 *   全部逐字搬至 task-domain.js（导出 `*TaskDomain` 执行体与共享 helper），本文件只保留：
 *     ① zod 入参声明（工具面契约，冒烟 smoke-mcp 逐字节断言）；
 *     ② D1 幂等包装（request_id 重放，addTool 单点覆写）；
 *     ③ 薄适配：execute → 领域函数（ctx 注入调用时身份/取消信号/杀树）。
 *   收益：探针/其他传输可直接 import 领域函数调用真实代码（此前窝在闭包里只能复述行号）。
 *   硬口径：`node dist/server.js --list-tools` 逐字节不变 + smoke-mcp / smoke-p26 / smoke-macp 全绿。
 * 共享顶层名经 ctx 注入：db / isCredentialValid / nowIso；身份访问器（agentName 等）从 server-tools.js import。
 * 门禁：npm test（smoke-task / smoke-p26-lifecycle / smoke-macp）+ npm run lint 全绿。
 */
import { z } from "zod";
import { readRequestReceipt, saveRequestReceipt } from "./db.js"; // ★ D1：写类 task_* 请求幂等（request_id 回执）
import { agentName, agentFpath, envCredential, requestAbortSignal } from "./server-tools.js"; // ★ 1b：调用方身份访问器 + 请求取消信号
import { killTree } from "./exec-tools.js"; // ★ 1b：验收子进程被取消时复用同一套「杀进程树」实现（不留孤儿）
import { invokeOp } from "./ops-registry.js"; // ★ 批次 B：task_next 领域计算经注册表派发
import {
    gateToolDomain, assignTaskDomain, delegateTaskDomain, claimTaskDomain, heartbeatTaskDomain,
    releaseTaskDomain, blockTaskDomain, reopenTaskDomain, doneTaskDomain, verifyTaskDomain, supersedeTaskDomain,
    settleTaskDomain, taskSettleOn,
    readTaskState, taskBody,
} from "./task-domain.js"; // ★ Step 0：领域核心（执行体 + 供 task.next ctx 注入的解析 helper）
import { renderTaskNextText } from "./task-domain.js";

export function registerTaskTools(server, ctx) {
    const { db, isCredentialValid, nowIso } = ctx;
    /** ★ Step 0：领域 ctx（调用时解析，严禁注册期冻成常量——1b 刚修掉的坑）。 */
    const dctx = { db, agentName, agentFpath, envCredential, isCredentialValid, nowIso, requestAbortSignal, killTree };
    /* ── ★ 批次 D1（2026-10-03，对标 orca `--retry-request <id>`）：写类 task_* 请求幂等 ──
     * 场景：agent 网络超时后无法判定「是否已生效」，只能重试 → 重复 done / 重复 release。
     * 做法：写类工具可选入参 `request_id`（客户端生成、全局唯一）。
     *   · 首达：正常执行 → 落 request_receipts 回执（原始返回串）；
     *   · 重放（同 id 再达）：**不执行**，原样返回首次回执 + 前缀标注 → 副作用只发生一次；
     *   · 错配（同 id 用在别的工具）：拒绝复用，防串号。
     * 语义边界：本表只证「该 id 已处理过」；**无记录 ≠ 未发生**——不带 request_id 的调用一律不查不落。
     * 实现：**单点包裹 addTool**（按工具名白名单）+ zod `.extend()` 注入参数声明。 */
    const IDEMPOTENT_TASK_TOOLS = new Set(["task_assign", "task_delegate", "task_claim", "task_heartbeat", "task_release", "task_admin", "task_done", "task_supersede", "task_settle"]);
    const REQUEST_ID_DESC = "★ D1 幂等键：网络超时重试时带同一 id → 已处理过则复用首次回执、不重复执行副作用。不传 = 行为与改动前一致。";
    const rawAddTool = server.addTool.bind(server);
    server = {
        addTool: (tool) => {
            if (!tool || !IDEMPOTENT_TASK_TOOLS.has(tool.name) || typeof tool.execute !== "function")
                return rawAddTool(tool);
            const inner = tool.execute.bind(tool);
            return rawAddTool({
                ...tool,
                parameters: tool.parameters?.extend ? tool.parameters.extend({ request_id: z.string().min(1).max(200).optional().describe(REQUEST_ID_DESC) }) : tool.parameters,
                async execute(args) {
                    const rid = args?.request_id ? String(args.request_id) : "";
                    if (!rid)
                        return inner(args); // 未带幂等键 → 原路径，零开销
                    const hit = readRequestReceipt(db, rid);
                    if (hit) {
                        if (hit.tool !== tool.name)
                            return `request_id「${rid}」此前已用于 ${hit.tool}，与本次 ${tool.name} 不符：拒绝复用（防串号）。如需重试本工具，请换新的 request_id。`;
                        return `♻️ 幂等重放（request_id「${rid}」已于 ${hit.created_at} 由 ${hit.tool} 处理，本次未重复执行）：\n${hit.result}`;
                    }
                    const out = await inner(args);
                    // 只缓存字符串回执（本域工具均返回字符串）；非字符串不回缓存，避免类型往返失真。
                    if (typeof out === "string")
                        saveRequestReceipt(db, { requestId: rid, tool: tool.name, agent: agentName(), memoryId: Number.isInteger(args?.memory_id) ? args.memory_id : null, result: out });
                    return out;
                },
            });
        },
    };
    server.addTool({
        name: "task_gate",
        description: "查看任务 [gate:预设] 验收声明与结果（task_done 先跑验收，失败 fail-closed 回 pending）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要查看验收门的任务记忆 id"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return gateToolDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_assign",
        description: "把任务交给指定 Agent（depends_on 拓扑；对方 claim 领取/done 完成/next 查可做）。详规:tool_guide。",
        parameters: z.object({
            content: z.string().describe("任务描述（不含状态头，工具自动加）"),
            assignee: z.string().describe("接收方 agent 名（如 codex/trae/zcode/claude）"),
            depends_on: z.string().optional().describe("依赖的任务 id，逗号分隔（如 '12,15'）；依赖全 done 后本任务才可做"),
            project: z.string().default("global").describe("任务 scope"),
            create_card: z.boolean().default(true).describe("是否在任务地图同步建卡（默认开）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return assignTaskDomain(dctx, args);
        },
    });
    /**
     * ★ 协议层·A2A 委派（融合架构「A2A 智能体对等协作」的落地映射）：
     * task_delegate = 跨 agent 委派一次任务，内部走既有 task_assign 的租约式任务流，
     * 但任务头打 [a2a:caller→target] 标记 + 校验目标 agent 是否持有有效凭据（A1 认证层联动）。
     * 不引入新协议栈：复用 task_* 状态机（pending/in_progress/done）+ 确定性门控（P3）+ 凭据校验（A1）。
     */
    server.addTool({
        name: "task_delegate",
        description: "A2A 对等委派（目标无有效凭据 fail-closed 拒绝；可选声明验收门）。",
        parameters: z.object({
            content: z.string().describe("委派的任务描述"),
            to: z.string().describe("目标 agent（如 codex/claude/trae/workbuddy/zcode）"),
            from: z.string().optional().describe("发起方 agent（缺省=当前 AGENT）"),
            gate: z.string().optional().describe("确定性验收门预设（lint-sql/lint-catch/smoke-mcp/smoke-task/smoke-p26/snapshot），写入任务头 [gate:预设]"),
            require_credential: z.boolean().default(true).describe("是否要求目标 agent 持有有效凭据（A1 认证层，默认开；fail-closed）"),
            project: z.string().default("global"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return delegateTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_claim",
        description: "领取 pending 任务（租约 10 分钟可延长；as=any 托管；takeover 接管须凭据）。详规:tool_guide。",
        parameters: z.object({
            as: z.string().optional().describe("以谁的身份领取（缺省=当前 agent）；传 'any' 托管认领（跳过接收方校验）——语义见工具描述"),
            project: z.string().default("global").describe("任务 scope"),
            memory_id: z.number().int().optional().describe("指定领取某条任务 id；不填则列出当前可领的 pending 任务"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：任务记忆乐观版本（你上次读到的 version）；不一致 → 拒绝陈旧领取"),
            lease_token: z.string().optional().describe("P2-6 fencing：你持有的租约锁（若卡片已被他人接管 → 拒绝僵尸领取）"),
            lease_minutes: z.number().int().min(10).max(120).optional().describe("租约分钟数（10..120，默认 10）；长任务自声明更长租约，超时由 dispatcher 回收"),
            pick: z.enum(["next"]).optional().describe("★ A3（P1）：原子认领——一次调用完成「按可做集判据选取最优 + 认领」，消除 task_next→task_claim 两步窗口（多 agent 下输家白跑）。选取判据同 task_next（pending + 归属匹配 + 依赖满足；卡片 priority 降序、创建时间升序）。需 MEMORYOS_ATOMIC_CLAIM=1；未开时传 pick 返回提示、行为不变。"),
            takeover: z.boolean().optional().describe("★ 2026-10-03 批次 B1（G2 裁决心跳）：显式接管「待裁决」任务 —— 仅当任务头 in_progress 且其 active dispatch 已 stale（原持有者失联、被 reaper 标记）时生效；会生成新一代 dispatch（旧 stale 置 superseded）。须携带 scope>=write 凭据（改写归属）。不传 = 普通认领，行为不变。"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属认领者）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return claimTaskDomain(dctx, args);
        },
    });
    // ★ A1（P1）：task_settle 凭 ticket 结算/归还——开关 MEMORYOS_TASK_SETTLE=1 才注册（默认关 = 工具面逐字节不变）。
    //   治 #2：上下文压缩丢令牌后交不了差。归属纪律：只收 dispatch_key 或 memory_id+session_id（命中 active 代）；
    //   裸 memory_id / 已 superseded 的代一律拒。
    if (taskSettleOn()) {
        server.addTool({
            name: "task_settle",
            description: "凭 dispatch ticket 结算/归还未完任务（治上下文压缩丢令牌后交不了差；服务端反查票据，agent 无需记住令牌）。",
            parameters: z.object({
                dispatch_key: z.string().optional().describe("task_claim 回执的票据（lease_token 同值）；与 memory_id+session_id 二选一"),
                memory_id: z.number().int().optional().describe("配合 session_id 定位该任务当前 active 代（不接受裸 memory_id——谁都能传=围栏失效）"),
                session_id: z.string().optional().describe("调用方会话 id——必须与 active dispatch 的 session_id 相符（同名 agent 多会话防串号）"),
                conclusion: z.string().optional().describe("交接注记（留痕任务正文）：活已干成但无法走 task_done 时，把结论交给下一位（防重试放弃/乱试）"),
                outcome: z.enum(["succeeded", "failed"]).optional().describe("attempt 结局标注；不传=归还（release 语义）"),
                task_hint: z.string().optional(),
            }),
            async execute(args) {
                return settleTaskDomain(dctx, args);
            },
        });
    }
    server.addTool({
        name: "task_heartbeat",
        description: "刷新在办任务租约（默认 10 分钟，防守护回收；无关联卡时仅记事件）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            as: z.string().optional().describe("以谁的身份续租（缺省=当前 agent）；须与任务认领者一致"),
            lease_minutes: z.number().int().min(10).max(120).optional().describe("续租分钟数（10..120，默认 10）；与 task_claim 的租约分级同口径"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：task_claim 返回的 dispatch_key（与 lease_token 同值）；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return heartbeatTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_release",
        description: "释放认领（in_progress→pending 清锁；仅当前认领者或 human 兜底）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            reason: z.string().optional().describe("释放原因（留痕 card_events/事件流）"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：task_claim 返回的 dispatch_key；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return releaseTaskDomain(dctx, args);
        },
    });
    // ★ 2026-10-19 工具面整合：task_block / task_reopen / task_verify 并门（三者均 L1/required、均不在无头预授权，
    //   风险与审批语义逐字不变；审计事件名 task_block/task_reopen/task_verify 在 task-domain.js 保留不变）。
    server.addTool({
        name: "task_admin",
        description: "任务状态管理门（action=block 标记受阻 / reopen 重开终态 / verify 第三方验收关闭）。详规:tool_guide。",
        parameters: z.object({
            action: z.enum(["block", "reopen", "verify"]).describe("子操作：block=受阻（不进可做集）；reopen=终态重开重派；verify=验收关闭（不改归属/不发租约）"),
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            reason: z.string().describe("原因/依据（必填，留痕）：受阻原因 / 重开原因 / 验收依据（对应提交/冒烟结果/证据位置）"),
            assignee: z.string().optional().describe("action=reopen：重开后指派给谁（缺省=原认领者）"),
            as: z.string().optional().describe("action=verify：验收方身份（缺省=当前 agent）"),
            user_rewritten: z.string().optional().describe("action=verify（P2⑦ 反馈回流）：用户改写过验收结论时，把改写后的版本填这里；不改写则不传"),
            expected_version: z.number().int().optional().describe("action=verify（P2-6 fencing）：任务记忆乐观版本；不一致 → 拒绝陈旧验收写；A1 硬模式必填"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent/验收方）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：task_claim 返回的 dispatch_key（verify 为验收方持有的，若有）；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            if (args.action === "block")
                return blockTaskDomain(dctx, args);
            if (args.action === "reopen")
                return reopenTaskDomain(dctx, args);
            return verifyTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_done",
        description: "完成任务（→done 结论回写；有 [gate] 先验收，失败回 pending）。详规:tool_guide。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要完成的记忆 id"),
            conclusion: z.string().describe("完成结论/结果摘要（追加进任务正文）"),
            lease_token: z.string().optional().describe("P2-6 fencing：task_claim 返回的租约锁；与卡片当前锁不符 → 拒绝过期完成写"),
            dispatch_key: z.string().optional().describe("★ 2026-10-02 Dispatch 语义：task_claim 返回的 dispatch_key（与 lease_token 同值）。传了即强制「权威只来自 active dispatch」——已 settled/released/superseded、或任务/归属不符一律拒绝。软模式可省略。"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：任务记忆乐观版本；不一致 → 拒绝陈旧完成写"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
            evidence_memory_ids: z.string().optional().describe("P2⑳（证据约束）：支撑本结论的记忆 id（逗号分隔，如 '12,45'）；无来源的结论应留空并自知风险。不传 = 标记 unverified"),
        }),
        async execute(args) {
            return doneTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_supersede",
        description: "重复任务归档（merged+superseded_by 指向主任务，移出可做集）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要归档的重复任务记忆 id（loser）"),
            superseded_by: z.number().int().min(1).describe("保留的主任务记忆 id（winner）"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：调用方持有的 dispatch_key（loser 任务上的）；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return supersedeTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_next",
        description: "算当前可做任务（依赖拓扑入度 0）+ 本人在办 + 待决策段。",
        parameters: z.object({
            project: z.string().default("global").describe("任务 scope"),
            as: z.string().optional().describe("以谁的身份查（缺省=当前 agent）；传 '' 或 'any' 查全部可做集"),
            domain: z.boolean().default(false).describe("只返回依赖链中当前可做链路的路径提示（A→B→C）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            // ★ 批次 B：领域计算在 task-domain.js::nextTasks（经 ops-registry 派发），本处只做薄适配；
            //   身份在**调用时**经 agentName accessor 解析；readTaskState / taskBody 经 ctx 注入（现自 task-domain.js import）。
            const structured = await invokeOp("task.next", args, { db, agentName, readTaskState, taskBody });
            return renderTaskNextText(structured);
        },
    });
}
