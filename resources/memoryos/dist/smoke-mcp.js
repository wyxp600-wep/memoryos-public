import { bodyFixture } from "./memory-body-fixture.js";
/**
 * MemoryOS v0.1 MCP 协议级冒烟（stdio JSON-RPC）
 * 走完: initialize -> notifications/initialized -> tools/list
 *     -> tools/call memory_write -> tools/call memory_search
 * 验证 "MCP 工具可被 Agent 真实验证调用"（非仅 db 层可用）
 * 用法：node dist/smoke-mcp.js
 */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite"; // P2-6o：直接读终态判定早退路径的归档不变量
import path from "node:path";
import fs from "node:fs";
const DB_PATH = path.join(process.cwd(), "data", "memory-mcp-smoke.db");
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    try {
        fs.rmSync(p, { force: true });
    }
    catch { }
}
const proc = spawn(process.execPath, [path.join(process.cwd(), "dist", "server.js")], {
    env: {
        ...process.env,
        MEMORY_DB: DB_PATH,
        MEMORY_AGENT: "codex",
        MEMORY_AGENT_FPATH: "C:/Users/zhang/.codex/config.toml",
    },
});
let buf = "";
const responses = {};
let lastId = 0;
const pending = new Map();
function send(method, params) {
    if (method === "tools/call" && params?.name === "memory_write") params = { ...params, arguments: { ...params.arguments, content: bodyFixture(params.arguments.content) } };
    const id = ++lastId;
    return new Promise((resolve) => {
        pending.set(id, { resolve, name: method });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            responses[msg.id] = msg;
            p.resolve(msg);
        }
    }
});
const failed = [];
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed.push(name);
}
try {
    const init = (await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.1.0" },
    }));
    check("initialize 返回", !!(init.result && init.result.serverInfo), JSON.stringify(init.result?.serverInfo));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const lst = (await send("tools/list", {}));
    const tools = lst.result?.tools ?? [];
    // ★ P0 修复（F16）：原断言 tools.length === 17 且白名单漏 task_supersede（与自身标题「task×4」也矛盾），
    //   且 `&&` 短路使「只改计数」仍然 FAIL。改为：显式期望清单 + 分别报告缺项，避免计数与名单互相掩盖。
    const EXPECT_TOOLS = [
        "memory_write", "memory_search", "memory_read", "memory_context", "memory_work",
        "memory_cite", "memory_feedback", "memory_ask", "memory_admin", "memory_credential",
        "memory_evidence", "method_query", "method_apply", "tool_guide",
        "task_assign", "task_claim", "task_done", "task_next", "task_supersede",
        "task_gate", "task_delegate", "task_heartbeat", "task_release", "task_admin",
        "obsidian",
    ];
    const missing = EXPECT_TOOLS.filter((n) => !tools.some((t) => t.name === n));
    check(
        `tools/list 记忆/任务/obsidian 工具齐全（必备 ${EXPECT_TOOLS.length} 个全部在列）`,
        missing.length === 0, // ★ 超集断言：不锁死总数——执行面工具上线是增量，精确计数会让套件一上线就变红（F16 病根）
        `count=${tools.length}${missing.length ? " missing=" + missing.join(",") : ""}`,
    );
    // ── 批次F1（P2-2）：tool_guide 按需详规（description 已一行化）——知名返回详规 / 未知名返回清单 ──
    const gOK = (await send("tools/call", { name: "tool_guide", arguments: { name: "task_done" } })).result?.content?.[0]?.text ?? "";
    check("F1.tool_guide 知名返回详规", gOK.includes("【task_done 详规】") && gOK.includes("状态头 → done"), JSON.stringify(gOK.slice(0, 80)));
    const gMiss = (await send("tools/call", { name: "tool_guide", arguments: { name: "no_such_tool" } })).result?.content?.[0]?.text ?? "";
    check("F1.tool_guide 未知名返回清单", gMiss.includes("未知工具名") && gMiss.includes("memory_write") && gMiss.includes("task_next"), JSON.stringify(gMiss.slice(0, 80)));
    const gOneLine = tools.find((t) => t.name === "task_done")?.description ?? "";
    check("F1.工具 description 已一行化（不含详规全文）", gOneLine.length < 120 && gOneLine.includes("tool_guide"), JSON.stringify(gOneLine.slice(0, 80)));
    const w = (await send("tools/call", {
        name: "memory_write",
        arguments: {
            content: "微信回调时间戳容差需设5分钟（签名校验常因时钟偏差误报超时）",
            type: "experience",
            project: "ecommerce",
        },
    }));
    const wtext = w.result?.content?.[0]?.text ?? "";
    check("tools/call memory_write 返回", wtext.includes("已写入记忆 #1"), JSON.stringify(wtext.slice(0, 60)));
    // ★ 一致性④（2026-09-19）：memory_write 幂等键 —— 同键同文不重写 / 同键异文拒绝（端到端走 MCP 协议）
    const idem1 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "一致性④ 幂等键样本：网关重试不重复落账", type: "experience", project: "ecommerce", idempotency_key: "smoke-idem-1" },
    }));
    const idem1t = idem1.result?.content?.[0]?.text ?? "";
    const idem1id = (idem1t.match(/#(\d+)/) || [])[1];
    check("一致性④a.幂等键首写正常入库", idem1t.includes("已写入记忆") && !!idem1id, JSON.stringify(idem1t.slice(0, 60)));
    const idem2 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "一致性④ 幂等键样本：网关重试不重复落账", type: "experience", project: "ecommerce", idempotency_key: "smoke-idem-1" },
    }));
    const idem2t = idem2.result?.content?.[0]?.text ?? "";
    check("一致性④b.同键同文命中幂等（不产生新记忆）", idem2t.includes("幂等键命中") && idem2t.includes(`#${idem1id}`), JSON.stringify(idem2t.slice(0, 70)));
    const idem3 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "一致性④ 幂等键样本：内容被换成另一个结论", type: "experience", project: "ecommerce", idempotency_key: "smoke-idem-1" },
    }));
    const idem3t = idem3.result?.content?.[0]?.text ?? "";
    check("一致性④c.同键异文拒绝写入", idem3t.includes("写入拒绝"), JSON.stringify(idem3t.slice(0, 70)));
    const s = (await send("tools/call", {
        name: "memory_search",
        arguments: { query: "时间戳", project: "ecommerce" },
    }));
    const stext = s.result?.content?.[0]?.text ?? "";
    check("tools/call memory_search 命中并带 agent=codex", stext.includes("[experience|codex"), JSON.stringify(stext.slice(0, 80)));
    // memory_read：按 id 读完整正文（不受 220 截断）
    const rd = (await send("tools/call", {
        name: "memory_read",
        arguments: { memory_id: 1 },
    }));
    const rdtext = rd.result?.content?.[0]?.text ?? "";
    check("tools/call memory_read 返回完整正文", rdtext.includes("完整正文") && rdtext.includes("微信回调"), JSON.stringify(rdtext.slice(0, 50)));
    // ── 批次C3/C4（P1-10/P1-12）：memory_search cursor 分页 + 证据/向量三态 ──
    // 设计：6 条共享前缀长探针（fake-embed 会因向量相似被去重合并成 1~2 条——不影响断言，关键是「第 1 页有超长命中」
    //   供 P1-12 证据窗口/向量三态断言）+ 2 条无共享前缀的独立探针 A/B（保证独立可召回，总命中 ≥3 稳定）。
    // 分页断言用 limit=2：满页签发 cursor → 逐页推进 → 末页必见「已到末尾」（Orca 显式截断契约：有/无下一页必须可区分）。
    const c34Pad = "分页探针填充文字〇一二三四五六七八九甲乙丙丁戊己庚辛";
    const c34Query = "C3PROBE 探针分页";
    for (let i = 1; i <= 6; i++) {
        await send("tools/call", {
            name: "memory_write",
            arguments: {
                content: `C3PROBE 探针分页 第 ${i} 号 ${c34Pad.repeat(8)} 尾部唯一锚词 probe-anchor-${i} 尾C3PROBE`,
                type: "experience",
                project: "ecommerce",
            },
        });
    }
    await send("tools/call", {
        name: "memory_write",
        arguments: {
            content: "C3PROBE 探针分页 试验 A 唯一锚词 alpha-unique-a-001 beta gamma delta epsilon 甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥",
            type: "experience",
            project: "ecommerce",
        },
    });
    await send("tools/call", {
        name: "memory_write",
        arguments: {
            content: "C3PROBE 探针分页 试验 B 唯一锚词 beta-unique-b-990 zeta eta theta iota 子丑寅卯辰巳午未申酉戌亥甲乙丙丁",
            type: "experience",
            project: "ecommerce",
        },
    });
    const c34Call = (args) => send("tools/call", { name: "memory_search", arguments: { query: c34Query, project: "ecommerce", ...args } });
    const c34Pages = [];
    const c34pg1 = (await c34Call({ limit: 2 })).result?.content?.[0]?.text ?? "";
    c34Pages.push(c34pg1);
    check("C3.满页回执签发 cursor（第 1 页）", c34pg1.includes("第 1 页") && c34pg1.includes("cursor="), JSON.stringify(c34pg1.slice(-160)));
    const c34c1 = (c34pg1.match(/cursor=([A-Za-z0-9+/=]+)/) || [])[1];
    let c34cur = c34c1;
    let c34pgN = "";
    let c34EndSeen = false;
    for (let page = 2; c34cur && page <= 8; page++) {
        c34pgN = (await c34Call({ limit: 2, cursor: c34cur })).result?.content?.[0]?.text ?? "";
        c34Pages.push(c34pgN);
        check(`C3.cursor 翻到第 ${page} 页`, c34pgN.includes(`第 ${page} 页`), JSON.stringify(c34pgN.slice(-120)));
        if (c34pgN.includes("已到末尾")) {
            c34EndSeen = true;
            break;
        }
        c34cur = (c34pgN.match(/cursor=([A-Za-z0-9+/=]+)/) || [])[1];
    }
    check("C3.末页回执「已到末尾」（有/无下一页可区分）", c34EndSeen, "");
    const c34stale = Buffer.from(JSON.stringify({ o: 5, h: "0000dead" })).toString("base64");
    const c34pgStale = (await c34Call({ limit: 2, cursor: c34stale })).result?.content?.[0]?.text ?? "";
    check("C3.stale cursor 回第 1 页", c34pgStale.includes("cursor 与当前 query/scope 不匹配") && c34pgStale.includes("第 1 页"), "");
    const c34pgF = (await c34Call({ limit: 2, type: "experience", cursor: c34c1 })).result?.content?.[0]?.text ?? "";
    check("C3.过滤激活时 cursor 被忽略（回执显式告知）", c34pgF.includes("cursor 被忽略"), "");
    check("C4.命中带 via/vec 元信息（尾部区块）", c34pg1.includes("via/vec：") && /#\d+=(lexical|semantic|hybrid)\//.test(c34pg1), JSON.stringify((c34pg1.match(/via\/vec：[^\n]*/g) || []).slice(0, 1)));
    const c34All = c34Pages.join("\n");
    check("C4.超长正文带「证据」窗口（任一页）", c34All.includes("↳ 证据 #") && /证据 #[^\n]*C3PROBE/.test(c34All), JSON.stringify((c34All.match(/↳ 证据 #[^\n]*/g) || []).slice(0, 1)));
    // task 交接：assign → claim → done（MVP 协同闭环，真实 MCP 链路）
    const ta = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: "排查 Ozon scope 未开通", assignee: "codex", project: "global" },
    }));
    const tat = ta.result?.content?.[0]?.text ?? "";
    const tid = (tat.match(/#(\d+)/) ?? [])[1];
    check("task_assign 分派并返回任务号", /已分派任务 #\d+/.test(tat) && !!tid, JSON.stringify(tat.slice(0, 60)));
    const tcl = (await send("tools/call", {
        name: "task_claim",
        arguments: { as: "codex", memory_id: Number(tid) },
    }));
    const tclt = tcl.result?.content?.[0]?.text ?? "";
    check("task_claim 认领 claimed", tclt.includes("已认领") && tclt.includes("in_progress by codex"), JSON.stringify(tclt.slice(0, 60)));
    const tdn = (await send("tools/call", {
        name: "task_done",
        arguments: { memory_id: Number(tid), conclusion: "需要向平台申请 order/read scope" },
    }));
    const tdnt = tdn.result?.content?.[0]?.text ?? "";
    check("task_done 完成 done", tdnt.includes("已完成") && tdnt.includes("status=done"), JSON.stringify(tdnt.slice(0, 60)));
    // ★ 批次 D1（2026-10-03，对标 orca `--retry-request <id>`）：写类 task_* 的 request_id 幂等重放（真实 MCP 链路）
    //   断言口径（对应计划 D1「同 request_id 重放两次 → 结果与副作用一致」）：
    //     a. 首达带 id → 正常执行；b. 同 id 重放 → 复用首次回执、不重复执行（副作用只一次，以 DB 终态计数判定）；
    //     c. 同 id 换工具 → 拒绝复用（防串号）；d. 回执表只记首办工具；e. 不带 id → 不查不落、零回归。
    const D1RID = "smoke-d1-req-1";
    const D1MARK = "D1-IDEM-MARKER-7f3a"; // 唯一串：用于按正文计数（task_assign 会加状态头，故用 LIKE 而非等值）
    const D1BODY = `D1 幂等样本（${D1MARK}）：网关超时重试不应重复建任务`;
    const d1a = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: D1BODY, assignee: "codex", project: "global", request_id: D1RID },
    }));
    const d1at = d1a.result?.content?.[0]?.text ?? "";
    const d1tid = (d1at.match(/#(\d+)/) || [])[1];
    check("D1a.首达带 request_id 正常执行（回执落库）", /已分派任务 #\d+/.test(d1at) && !!d1tid, JSON.stringify(d1at.slice(0, 60)));
    const d1b = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: D1BODY, assignee: "codex", project: "global", request_id: D1RID },
    }));
    const d1bt = d1b.result?.content?.[0]?.text ?? "";
    check("D1b.同 request_id 重放 → 复用首次回执、不重复执行", d1bt.includes("♻️ 幂等重放") && d1bt.includes(`已分派任务 #${d1tid}`), JSON.stringify(d1bt.slice(0, 70)));
    const d1c = (await send("tools/call", {
        name: "task_claim",
        arguments: { as: "codex", memory_id: Number(d1tid), request_id: D1RID },
    }));
    const d1ct = d1c.result?.content?.[0]?.text ?? "";
    check("D1c.同 request_id 换工具 → 拒绝复用（防串号）", d1ct.includes("拒绝复用") && d1ct.includes("task_assign"), JSON.stringify(d1ct.slice(0, 70)));
    // ★ 副作用只一次：以 DB 终态判定（若重放真执行了，同正文任务记忆会变成 2 条）——与文案无关
    const d1db = new DatabaseSync(DB_PATH, { readOnly: true });
    const d1cnt = d1db.prepare(`SELECT COUNT(*) c FROM memories WHERE content LIKE '%' || ? || '%'`).get(D1MARK).c;
    const d1rec = d1db.prepare(`SELECT tool, COUNT(*) c FROM request_receipts GROUP BY tool`).all();
    d1db.close();
    check("D1d.副作用只发生一次（重放未新建任务记忆）", Number(d1cnt) === 1, `memories=${d1cnt}（期望 1）`);
    check("D1e.回执表只记首办工具（无串号污染）", d1rec.length === 1 && d1rec[0].tool === "task_assign" && Number(d1rec[0].c) === 1, JSON.stringify(d1rec));
    // ★ 零回归：不带 request_id 的写类调用行为不变（同工具可再次正常执行）
    const d1f = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: "D1 零回归对照：不带幂等键仍可正常调用", assignee: "codex", project: "global" },
    }));
    const d1ft = d1f.result?.content?.[0]?.text ?? "";
    check("D1f.不带 request_id → 不查不落、行为与改动前一致", /已分派任务 #\d+/.test(d1ft), JSON.stringify(d1ft.slice(0, 60)));
    // ★ 可发现性：MCP 握手下发的 task_assign 入参声明里必须含 request_id（否则 agent 无从知晓）
    const d1props = tools.find((t) => t.name === "task_assign")?.inputSchema?.properties ?? {};
    check("D1g.MCP 握手已下发 request_id 参数声明", !!d1props.request_id, `props=${Object.keys(d1props).join(",")}`);
    // task_next：依赖拓扑可做集（真实 MCP 链路）
    const tn = (await send("tools/call", {
        name: "task_next",
        arguments: { project: "global" },
    }));
    const tnt = tn.result?.content?.[0]?.text ?? "";
    check("task_next 返回可做/阻塞/在做三段", tnt.includes("可做") && tnt.includes("阻塞") && tnt.includes("我在做"), JSON.stringify(tnt.slice(0, 60)));
    // memory_context：一键注入高价值记忆（步骤3 自动检索注入）
    const cx = (await send("tools/call", {
        name: "memory_context",
        arguments: { project: "ecommerce", limit: 3 },
    }));
    const cxt = cx.result?.content?.[0]?.text ?? "";
    check("tools/call memory_context 注入高价值记忆 + agent 标注", cxt.includes("MemoryContext 注入") && cxt.includes("agent="), JSON.stringify(cxt.slice(0, 60)));
    // memory_context + focus：按任务主题召回（而非全库曝光榜）
    const cxf = (await send("tools/call", {
        name: "memory_context",
        arguments: { project: "ecommerce", limit: 3, focus: "时间戳" },
    }));
    const cxft = cxf.result?.content?.[0]?.text ?? "";
    check("memory_context + focus 按主题召回（命中时间戳记忆 + 标注主题排序）", cxft.includes("时间戳") && cxft.includes("『时间戳』主题相关度排序"), JSON.stringify(cxft.slice(0, 80)));
    // M-1.5/1.6: cite + report 通过 MCP 全链路
    const c = (await send("tools/call", {
        name: "memory_cite",
        arguments: { memory_id: 1, session_id: "S-mcp", task_hint: "smoke" },
    }));
    const ctext = c.result?.content?.[0]?.text ?? "";
    check("tools/call memory_cite 返回", ctext.includes("已记录记忆 #1") && ctext.includes("置信度保持不变"), JSON.stringify(ctext.slice(0, 60)));
    const r = (await send("tools/call", {
        name: "memory_admin",
        arguments: { action: "report", report: "funnel", project: "ecommerce" },
    }));
    const rtext = r.result?.content?.[0]?.text ?? "";
    check("tools/call memory_admin(action=report) funnel 含 raw_cited 与 inferred_cited 两行", rtext.includes("raw_cited") && rtext.includes("inferred_cited"), JSON.stringify(rtext.slice(0, 80)));
    // memory_feedback：纠错闭环（soft-reject，不进检索）
    const fb = (await send("tools/call", {
        name: "memory_feedback",
        arguments: { memory_id: 1, reason: "smoke: 该结论已过时" },
    }));
    const fbtext = fb.result?.content?.[0]?.text ?? "";
    check("tools/call memory_feedback soft-reject 记忆", fbtext.includes("已标记记忆 #1") && fbtext.includes("rejected"), JSON.stringify(fbtext.slice(0, 50)));

    // ★ P2-6（C-2/C-4）生命周期工具 + fencing + memory_write 版本化（端到端）
    const ta2 = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: "P2-6 生命周期样本：验证 heartbeat/release/block/reopen 与 fencing", assignee: "codex" },
    }));
    const ta2t = ta2.result?.content?.[0]?.text ?? "";
    const tid2 = (ta2t.match(/#(\d+)/) || [])[1];
    check("P2-6a.task_assign 建立样本任务", !!tid2, JSON.stringify(ta2t.slice(0, 50)));
    const tcl2 = (await send("tools/call", {
        name: "task_claim",
        arguments: { memory_id: Number(tid2), as: "codex" },
    }));
    const tcl2t = tcl2.result?.content?.[0]?.text ?? "";
    const lease = (tcl2t.match(/lease_token=([0-9a-f]+)/) || [])[1];
    check("P2-6b.task_claim 发放租约锁（lease_token）", !!lease, JSON.stringify(tcl2t.slice(0, 70)));
    const tdnBad = (await send("tools/call", {
        name: "task_done",
        arguments: { memory_id: Number(tid2), conclusion: "伪造租约的完成写", lease_token: "bogus-lock" },
    }));
    const tdnBadt = tdnBad.result?.content?.[0]?.text ?? "";
    check("P2-6c.过期/伪造租约被 fencing 拒绝", tdnBadt.includes("租约已被接管"), JSON.stringify(tdnBadt.slice(0, 60)));
    const thb = (await send("tools/call", {
        name: "task_heartbeat",
        arguments: { memory_id: Number(tid2), as: "codex" },
    }));
    const thbt = thb.result?.content?.[0]?.text ?? "";
    check("P2-6d.task_heartbeat 续租成功", thbt.includes("续租成功"), JSON.stringify(thbt.slice(0, 60)));
    const tdnOk = (await send("tools/call", {
        name: "task_done",
        arguments: { memory_id: Number(tid2), conclusion: "P2-6 生命周期样本完成", lease_token: lease },
    }));
    const tdnOkt = tdnOk.result?.content?.[0]?.text ?? "";
    check("P2-6e.持有效租约可完成（fencing 不误杀）", tdnOkt.includes("已完成"), JSON.stringify(tdnOkt.slice(0, 60)));
    const trp = (await send("tools/call", {
        name: "task_admin",
        arguments: { action: "reopen", memory_id: Number(tid2), reason: "冒烟：验证重开路径" },
    }));
    const trpt = trp.result?.content?.[0]?.text ?? "";
    check("P2-6f.task_admin(action=reopen) 终态重开（done → in_progress）", trpt.includes("已重开"), JSON.stringify(trpt.slice(0, 60)));
    const trl = (await send("tools/call", {
        name: "task_release",
        arguments: { memory_id: Number(tid2), reason: "冒烟：释放认领" },
    }));
    const trlt = trl.result?.content?.[0]?.text ?? "";
    check("P2-6g.task_release 释放回 pending", trlt.includes("已释放"), JSON.stringify(trlt.slice(0, 60)));
    const tcl3 = (await send("tools/call", {
        name: "task_claim",
        arguments: { memory_id: Number(tid2), as: "codex", expected_version: 99 },
    }));
    const tcl3t = tcl3.result?.content?.[0]?.text ?? "";
    check("P2-6h.陈旧版本领取被拒（乐观版本 fencing）", tcl3t.includes("版本漂移"), JSON.stringify(tcl3t.slice(0, 70)));
    const tcl4 = (await send("tools/call", {
        name: "task_claim",
        arguments: { memory_id: Number(tid2), as: "codex" },
    }));
    const tcl4t = tcl4.result?.content?.[0]?.text ?? "";
    check("P2-6i.释放后可重新认领（pending → in_progress）", tcl4t.includes("已认领"), JSON.stringify(tcl4t.slice(0, 60)));
    const tblk = (await send("tools/call", {
        name: "task_admin",
        arguments: { action: "block", memory_id: Number(tid2), reason: "冒烟：验证受阻态" },
    }));
    const tblkt = tblk.result?.content?.[0]?.text ?? "";
    check("P2-6j.task_admin(action=block) 标记受阻（in_progress → blocked）", tblkt.includes("已标记受阻"), JSON.stringify(tblkt.slice(0, 60)));
    const thb2 = (await send("tools/call", {
        name: "task_heartbeat",
        arguments: { memory_id: Number(tid2), as: "codex" },
    }));
    const thb2t = thb2.result?.content?.[0]?.text ?? "";
    check("P2-6k.受阻态续租被拒（状态守卫）", thb2t.includes("无需续租"), JSON.stringify(thb2t.slice(0, 50)));
    const trl2 = (await send("tools/call", {
        name: "task_release",
        arguments: { memory_id: Number(tid2), reason: "冒烟：受阻态释放应被拒" },
    }));
    const trl2t = trl2.result?.content?.[0]?.text ?? "";
    check("P2-6l.受阻态释放被拒（仅进行中可释放）", trl2t.includes("仅进行中任务可释放"), JSON.stringify(trl2t.slice(0, 60)));
    // C-4：memory_write 版本化（supersedes + version 乐观校验）
    const mw1 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "C-4 样本 v1：乐观修订基线", type: "decision", confidence: 0.6, source_task_id: Number(tid2) },
    }));
    const mw1t = mw1.result?.content?.[0]?.text ?? "";
    const mid1 = (mw1t.match(/#(\d+)/) || [])[1];
    const mw2 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "C-4 样本 v2：替代 v1 结论", type: "decision", supersedes: Number(mid1), version: 1 },
    }));
    const mw2t = mw2.result?.content?.[0]?.text ?? "";
    check("P2-6m.memory_write 版本化修订（归档旧条 + 因果链）", mw2t.includes("已替代并归档"), JSON.stringify(mw2t.slice(0, 70)));
    const mid2 = (mw2t.match(/#(\d+)/) || [])[1];
    const mw3 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "C-4 样本 v3：陈旧版本修订（应被拒）", type: "decision", supersedes: Number(mid2), version: 99 },
    }));
    const mw3t = mw3.result?.content?.[0]?.text ?? "";
    check("P2-6n.陈旧版本修订被拒（乐观版本 fencing）", mw3t.includes("版本漂移"), JSON.stringify(mw3t.slice(0, 70)));
    // ★ P2-6o（2026-09-18 缺陷回归）：去重/冲突**早退路径**同样必须执行 supersedes 归档。
    //   缺陷：修订写块曾位于 dedupeDecisionFast 预检之后，而预检命中 merge/conflict 时提前 return
    //   ⇒ supersedes 被静默丢弃（旧条不归档、无 superseded 事件、causal_parent 丢失）。
    //   本断言走**确定性的 merge 分支**（同 project 内写入与 #mid4 完全一致的正文 → sim=1.0 ≥ 0.92），
    //   并以 DB 终态判定，故与文案无关。
    const mw4 = await send("tools/call", {
        name: "memory_write",
        arguments: { content: "P2-6o 哨兵基线：ALPHA-7 的唯一判据是 X", type: "decision" },
    });
    const mid4 = ((mw4.result?.content?.[0]?.text ?? "").match(/#(\d+)/) || [])[1];
    const mw4b = await send("tools/call", {
        name: "memory_write",
        arguments: { content: "P2-6o 无关对照：BETA-9 的唯一判据是 Y（与哨兵无语义重叠）", type: "decision" },
    });
    const mid4b = ((mw4b.result?.content?.[0]?.text ?? "").match(/#(\d+)/) || [])[1];
    // 正文与 #mid4 逐字一致 ⇒ 必落 merge 早退分支；supersedes 指向无关的 #mid4b ⇒ 承接者 ≠ 被替代者
    const mw5 = await send("tools/call", {
        name: "memory_write",
        arguments: { content: "P2-6o 哨兵基线：ALPHA-7 的唯一判据是 X", type: "decision", supersedes: Number(mid4b), version: 1 },
    });
    const mw5t = mw5.result?.content?.[0]?.text ?? "";
    const sdb = new DatabaseSync(DB_PATH, { readOnly: true });
    const oldRow = sdb.prepare(`SELECT status,superseded_by FROM memories WHERE id=?`).get(Number(mid4b));
    const supEv = sdb.prepare(`SELECT COUNT(*) c FROM memory_events WHERE memory_id=? AND op='superseded'`).get(Number(mid4b)).c;
    sdb.close();
    check(
        "P2-6o.合并早退路径仍执行 supersedes 归档（已合并 + 旧条 archived + superseded_by + 事件）",
        mw5t.includes("已合并") && !!oldRow && oldRow.status === "archived" && Number(oldRow.superseded_by) === Number(mid4) && supEv > 0,
        `merged=${mw5t.includes("已合并")} status=${oldRow?.status} superseded_by=${oldRow?.superseded_by}(期望 ${mid4}) events=${supEv}`,
    );
    // 写入正常知识记录以建立中文 gram 索引，然后归档；替代记录仍必须被排除。
    let qualityColdId;
    {
        const { openDb, writeMemory } = await import('./db.js');
        const d = openDb(DB_PATH);
        const legacy = d.prepare('SELECT content FROM memories WHERE id=?').get(mid1);
        const added = writeMemory(d, { content: legacy.content + ' 独立归档样本', type: 'experience', agent: 'smoke', agent_fpath: null, project: 'global' });
        qualityColdId = added.id;
        d.prepare("UPDATE memories SET status='archived' WHERE id=?").run(added.id);
        d.close();
    }
    const coldHit = (await send("tools/call", {
        name: "memory_search",
        arguments: { query: "乐观修订基线", project: "global", limit: 10 },
    })).result?.content?.[0]?.text ?? "";
    check("冷层a.归档条经 memory_search 冷层召回（排后 + 📦[归档区] 标注）", coldHit.includes("📦[归档区]") && coldHit.includes(`#${qualityColdId} [`) && !coldHit.includes(`#${mid1} [`), JSON.stringify(coldHit.slice(0, 140)));
    check("冷层b.回执汇总「来自归档区」（显式告知来源）", coldHit.includes("来自归档区"), JSON.stringify((coldHit.match(/ℹ 其中[^\n]*/) || [])[0] ?? ""));
    // memory_admin(action=health)：使用侧健康（P2 效果监控）
    const h = (await send("tools/call", {
        name: "memory_admin",
        arguments: { action: "health", days: 30 },
    }));
    const htext = h.result?.content?.[0]?.text ?? "";
    check("tools/call memory_admin(action=health) 返回触发率/写读比", htext.includes("检索触发率") && htext.includes("写读比"), JSON.stringify(htext.slice(0, 50)));

    // ★ 融合架构增量：A1 身份认证（短生命周期凭据）+ P3 确定性门控 + 协议层 A2A 委派
    const EXPECT_TOOLS_V2 = ["memory_credential", "task_gate", "task_delegate"];
    const missingV2 = EXPECT_TOOLS_V2.filter((n) => !tools.some((t) => t.name === n));
    check(
        `V2 工具齐全（A1 凭据 + P3 门控 + A2A 委派 共 ${EXPECT_TOOLS_V2.length} 个）`,
        missingV2.length === 0,
        `count=${tools.length}${missingV2.length ? " missing=" + missingV2.join(",") : ""}`,
    );
    // A1：签发凭据 → verify 有效
    const iss = (await send("tools/call", {
        name: "memory_credential",
        arguments: { action: "issue", agent: "smoke", scope: "read", ttl_hours: 1 },
    }));
    const isst = iss.result?.content?.[0]?.text ?? "";
    check("A1.issue 签发短生命周期凭据", isst.includes("已签发凭据") && isst.includes("smoke"), JSON.stringify(isst.slice(0, 60)));
    const ver = (await send("tools/call", {
        name: "memory_credential",
        arguments: { action: "verify", agent: "smoke" },
    }));
    const vert = ver.result?.content?.[0]?.text ?? "";
    check("A1.verify 目标持有有效凭据", vert.includes("持有 1 条有效凭据"), JSON.stringify(vert.slice(0, 60)));
    // P3：门控预设查询（未声明 gate 的任务应提示「未声明验收门」）
    const gateQ = (await send("tools/call", {
        name: "task_gate",
        arguments: { memory_id: Number(tid2) },
    }));
    const gateQt = gateQ.result?.content?.[0]?.text ?? "";
    check("P3.task_gate 查询验收门（未声明 → 提示白名单）", gateQt.includes("未声明验收门") && gateQt.includes("lint-sql"), JSON.stringify(gateQt.slice(0, 60)));
    // 协议层 A2A：对无凭据目标委派 → fail-closed 拒绝
    const delg = (await send("tools/call", {
        name: "task_delegate",
        arguments: { content: "冒烟：A2A 委派无凭据目标应被拒", to: "ghost-agent", from: "smoke" },
    }));
    const delgt = delg.result?.content?.[0]?.text ?? "";
    check("A2A.task_delegate 无凭据目标 fail-closed 拒绝", delgt.includes("A2A 委派拒绝") && delgt.includes("无有效凭据"), JSON.stringify(delgt.slice(0, 60)));
    // A2A：对已签发凭据的目标（smoke）委派 → 成功建任务
    const delgOk = (await send("tools/call", {
        name: "task_delegate",
        arguments: { content: "冒烟：A2A 委派有效目标", to: "smoke", from: "claude" },
    }));
    const delgOkT = delgOk.result?.content?.[0]?.text ?? "";
    check("A2A.task_delegate 有效目标成功委派", delgOkT.includes("A2A 已委派任务") && delgOkT.includes("claude → smoke"), JSON.stringify(delgOkT.slice(0, 60)));
}
finally {
    proc.stdin.end();
    proc.kill();
    setTimeout(() => {
        for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
            try {
                fs.rmSync(p, { force: true });
            }
            catch { }
        }
        console.log(failed.length === 0 ? "\n== MCP ALL PASS ==" : `\n== MCP ${failed.length} FAILED ==`);
        process.exit(failed.length === 0 ? 0 : 1);
    }, 200);
}
