/**
 * MemoryOS ★ P2-6（C-5 / #4201）：三方对账与投影重建守护（任务记忆 ⇄ 看板卡片）。
 *  - 投影重建：任务记忆（active/trial 且非终态）无 dispatch 卡 → 补建卡（事件 reconcile_created）
 *  - 状态对齐：记忆头 pending/in_progress/blocked ↔ 卡片失配 → 修复（事件 reconcile_aligned）。
 *    ★ 修 #3（2026-09-19）：只对齐投影三态 ready/running/blocked；review/failed/triage/todo 等
 *    卡侧富状态不碰（原口径会把 review 泳道抹掉、把 failed/todo 恢复路拉死、绕过 depends 依赖门）
 *  - 镜像滞后：修复时卡片 updated_at 滞后 >5 分钟 → daemon_log 告警（op=lag）
 *  实现纪律：参数绑定（无内联 SQL 字面量）+ 字符串切分（无正则转义）+ 幂等（一致的对不命中）。
 *  由常驻 daemon 每 5 分钟调用（daemon.js runReconcile）。
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { EXPECT_CARD_OF } from "./task-status-map.js"; // ★ 一致性③（2026-09-19）：映射上移权威对照表
const NON_TERMINAL = ["pending", "in_progress", "blocked"];
// ★ 修 #3（2026-09-19）：对账只对齐「投影三态」ready/running/blocked（C-5 的映射目标集）。
//   原 CARD_TERMINAL 跳过口径太宽：review/failed/triage/todo 既不在终态名单、又不是映射目标，
//   会被强拉回三态 —— review 进卡 5 分钟即被抹（syncCardToTask 把 review 写成头 in_progress，
//   对账又按 in_progress→running 拉回）；failed→todo 恢复路被拉回 blocked；todo→ready 绕过
//   dispatch 的 depends 依赖门。这些卡侧富状态由卡片流转/dispatcher/reaper 自己拥有，对账不碰。
const PROJECTABLE = new Set(["ready", "running", "blocked"]);

/** ★ 2026-09-19（弊端 H5）：头部字段只解析首行（与 server.js headLineOf 口径统一）——
 *  正文里引用的 [status:]/[assignee:] 标记不再影响对账。 */
function headLineOf(content) {
    const s = String(content ?? "");
    const i = s.indexOf("\n");
    return i < 0 ? s : s.slice(0, i);
}
/** 从任务记忆头部行取状态头（锚定首行，正文引用无效） */
function headStatus(content) {
    const m = headLineOf(content).match(/\[status:([a-z_]+)\]/);
    return m ? m[1] : null;
}
/** 从任务记忆头部行取 assignee（锚定首行，正文引用无效） */
function headAssignee(content) {
    const m = headLineOf(content).match(/\[assignee:([^\]]*)\]/);
    const v = m ? m[1].trim() : null;
    return !v || v === "?" ? null : v;
}

export function reconcileTasksAndCards(db) {
    const out = { created: 0, aligned: 0, lagAlerts: 0, divergenceAlerts: 0 };
    try {
        const pairs = db
            .prepare(`SELECT cm.memory_id, cm.card_id, m.content, c.status AS card_status, c.updated_at AS card_updated
                FROM card_memory cm
                JOIN memories m ON m.id = cm.memory_id
                JOIN cards c ON c.id = cm.card_id
                WHERE cm.relation=? AND m.type=? AND m.status IN (?,?)`)
            .all("dispatch", "task", "active", "trial");
        for (const p of pairs) {
            const st = headStatus(p.content);
            const want = st ? EXPECT_CARD_OF[st] : null;
            if (!want || p.card_status === want || !PROJECTABLE.has(p.card_status))
                continue;
            const lagMin = p.card_updated ? (Date.now() - Date.parse(p.card_updated)) / 60000 : null;
            // ★ 修 #17（2026-09-19）：对齐递增 cards.version —— reaper/MCP 侧卡写均递增，对账独缺会造成卡侧 fencing 口径不齐
            db.prepare(`UPDATE cards SET status=?, version=version+1, updated_at=strftime(?, ?) WHERE id=?`).run(want, "%Y-%m-%dT%H:%M:%fZ", "now", p.card_id);
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(p.card_id, "reconciler", "reconcile_aligned", p.card_status, want, `任务 #${p.memory_id} 三方对账：头 ${st} → 卡 ${want}（C-5）`);
            out.aligned++;
            if (lagMin != null && lagMin > 5) {
                out.lagAlerts++;
                db.prepare(`INSERT INTO daemon_log(task,op,memory_id,detail,operator) VALUES (?,?,?,?,?)`).run("reconcile", "lag", p.memory_id, `卡片 #${p.card_id} 镜像滞后 ${Math.round(lagMin)} 分钟（任务 #${p.memory_id}），已修复至 ${want}`, "reconciler");
            }
        }
        // ★ 2026-09-19（弊端 M1）：todo/triage 泳道发散告警——头 in_progress 但卡停 todo/triage
        //   （无回写、非对账目标）；卡静止超 30 分钟写 daemon_log 告警，避免无声失同步
        for (const p of pairs) {
            const st2 = headStatus(p.content);
            if (st2 !== "in_progress" || (p.card_status !== "todo" && p.card_status !== "triage"))
                continue;
            const lagMin2 = p.card_updated ? (Date.now() - Date.parse(p.card_updated)) / 60000 : null;
            if (lagMin2 == null || lagMin2 <= 30)
                continue;
            out.divergenceAlerts++;
            db.prepare(`INSERT INTO daemon_log(task,op,memory_id,detail,operator) VALUES (?,?,?,?,?)`).run("reconcile", "diverge", p.memory_id, `任务 #${p.memory_id} 头=in_progress 但卡 #${p.card_id} 停留 ${p.card_status} 泳道 ${Math.round(lagMin2)} 分钟（todo/triage 非对账目标）：需 task_release / task_admin(action=block)，或把卡移回 ready`, "reconciler");
        }
        const orphans = db
            .prepare(`SELECT m.id, m.content FROM memories m
                WHERE m.type=? AND m.status IN (?,?)
                AND NOT EXISTS (SELECT 1 FROM card_memory cm WHERE cm.memory_id=m.id AND cm.relation=?)`)
            .all("task", "active", "trial", "dispatch");
        for (const o of orphans) {
            const st = headStatus(o.content);
            if (!st || !NON_TERMINAL.includes(st))
                continue;
            // ★ 2026-09-16 修正：原为 `st === "pending" ? "ready" : st`，当头部是 in_progress 时直接把
            //   "in_progress" 写进 cards.status —— 但**卡片状态词汇表**是 ready/running/blocked/done/archived/
            //   cancelled（认领后为 running），"in_progress" 并非合法卡态：补建的卡会短暂处于非法状态、
            //   不在 running 泳道，且要等下一轮对账（5 分钟后）才被自我修正为 running。
            //   正解：复用文件顶部已定义的单一映射 EXPECT_CARD_OF（pending→ready / in_progress→running / blocked→blocked）。
            const cardStatus = EXPECT_CARD_OF[st] ?? st;
            // ★ 2026-09-19（弊端 L7）：卡标题剥掉 [task]/[assignee]/[status]/[depends] 头标记，只留纯任务描述
            const titleSrc = String(o.content ?? "").split("\n")[0].replace(/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]\s*(?:\[depends:[^\]]*\]\s*)?/, "").trim();
            const title = titleSrc.slice(0, 120) || `任务 #${o.id}`;
            const info = db
                .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES (?,?,?,?,?,?,?,?,?)`)
                .run("default", "task", title, "对账补建（C-5）", cardStatus, "memory", o.id, 3, headAssignee(o.content));
            const cid = Number(info.lastInsertRowid);
            db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,?)`).run(cid, o.id, "dispatch");
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cid, "reconciler", "reconcile_created", null, cardStatus, `任务 #${o.id} 无卡，投影重建（C-5）`);
            out.created++;
        }
    }
    catch (e) {
        console.error(`[reconcile] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
}

/**
 * P2 自进化有界验证环（融合架构「弱点挖掘 → 有界提案 → 回归验证」+ 安全默认「外部监督 + 分层遏制」）：
 * 进化引擎（evolution-engine 技能）把高频失败因果结构化成「提案」条目写入 engine/ 目录，
 * 供 Heartbeat 持续学习。本函数实现其中缺的一环——**双回归验证门**：
 *   提案要「被接受进生产规则集」必须同时满足：
 *     (a) held-in 回归不退化，且 (b) held-out 回归有提升，且确定性 gate 通过。
 * 这是确定性判定（跑既有验收脚本 + 比对前后指标），不是 LLM 自评——避免「自进化风险（攻击持久化）」
 * 由模型自己盖章。提案文件 schema（engine/<slug>.json）：
 *   { "title","gate":"smoke|lint|lint-catch", "held_in": {<样例名>:0|1}, "held_out": {...} }
 * 输出写回同一文件的 verdict（accepted/rejected + 明细 + ts），并落 daemon_log。
 */
export function evolutionRegressionGate(db, engineDir) {
    const out = { scanned: 0, accepted: 0, rejected: 0, details: [] };
    if (!engineDir || !fs.existsSync(engineDir))
        return out;
    // gate cwd 必须是 resources/memoryos（smoke 类脚本用 process.cwd() 拼 data/ 与 dist/ 相对路径；
    // lint/snapshot 类按 import.meta.url 自定位不依赖 cwd）
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    // 确定性验收门（字面量命令，防注入：gate 名只做枚举匹配，绝不参与 argv 构造）
    const GATES = {
        smoke: ["dist/smoke-mcp.js"],
        "lint-sql": ["dist/lint-sql-arity.js"],
        "lint-catch": ["dist/lint-silent-catch.js"],
    };
    let files = [];
    try {
        const dirReal = fs.realpathSync(engineDir);
        files = fs.readdirSync(engineDir)
            .filter((f) => f.endsWith(".json") && !f.includes("..") && f.length <= 120)
            .map((f) => path.join(engineDir, f))
            // 路径穿越防护：目标父目录必须仍落在 engineDir 根内
            .filter((full) => {
                try {
                    const parent = fs.realpathSync(path.dirname(full));
                    return parent === dirReal || parent.startsWith(dirReal + path.sep);
                }
                catch { return true; }
            });
    }
    catch (e) { console.error(`[evolution-gate] 读取 engineDir ${engineDir} 失败，本轮跳过: ${e.message}`); return out; }
    for (const full of files) {
        const fname = path.basename(full);
        let p;
        try { p = JSON.parse(fs.readFileSync(full, "utf8")); }
        catch (e) { console.error(`[evolution-gate] 提案 ${fname} JSON 解析失败，跳过: ${e.message}`); continue; }
        out.scanned++;
        // 已判决的提案不重判（幂等）
        if (p.verdict === "accepted" || p.verdict === "rejected")
            continue;
        const hi = p.held_in ?? {};
        const ho = p.held_out ?? {};
        const hiPass = Object.values(hi).filter(Boolean).length;
        const hoPass = Object.values(ho).filter(Boolean).length;
        const hoBefore = 0; // 提案未记录 held-out 基线 → 视作 0，提升判定即「有任一 held-out 通过」
        const hiTotal = Object.keys(hi).length;
        const hoTotal = Object.keys(ho).length;
        const gateKey = p.gate === "lint-sql" || p.gate === "lint-catch" ? p.gate : "smoke";
        const gateArgv = GATES[gateKey];
        let gateOk = false;
        let gateDetail = "无匹配 gate";
        try {
            const r = spawnSync("node", gateArgv, { shell: false, cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true });
            gateOk = r.status === 0;
            gateDetail = String(r.stdout || r.stderr || "").trim().slice(0, 160);
        }
        catch (e) { gateDetail = `gate 执行异常：${e.message}`; }
        // 双回归判定：确定性 gate 通过 且 held-in 不退化（已知样例正确率不腰斩）且 held-out 有提升
        const holdInNotDegraded = hiTotal === 0 ? true : hiPass >= hiTotal * 0.5;
        const holdOutImproved = hoTotal > 0 ? (hoPass > hoBefore) : true;
        const accepted = gateOk && holdInNotDegraded && holdOutImproved;
        p.verdict = accepted ? "accepted" : "rejected";
        p.verdict_detail = {
            gate: gateKey, gateOk, gateDetail: gateDetail.slice(0, 120),
            heldIn: `${hiPass}/${hiTotal}（基线记录）`,
            heldOut: `${hoPass}/${hoTotal}（前 ${hoBefore}）`,
            rule: "双回归门：确定性 gate 通过 且 held-in 不退化 且 held-out 提升",
            ts: new Date().toISOString(),
        };
        // 写回同一文件（仍锁 engineDir 根内，防穿越）
        try {
            const parent = fs.realpathSync(path.dirname(full));
            const dirReal = fs.realpathSync(engineDir);
            if (parent === dirReal || parent.startsWith(dirReal + path.sep))
                fs.writeFileSync(full, JSON.stringify(p, null, 2), "utf8");
        }
        catch (e) { console.error(`[evolution-gate] 提案 ${fname} 写回 verdict 失败（判定本身已生效）: ${e.message}`); }
        try {
            db.prepare(`INSERT INTO daemon_log(task,op,memory_id,detail,operator) VALUES (?,?,?,?,?)`)
                .run("evolution", accepted ? "gate_pass" : "gate_reject", null,
                    `提案 ${fname}：verdict=${p.verdict}（gate=${gateKey} ${gateOk ? "OK" : "FAIL"}；held-in ${hiPass}/${hiTotal}；held-out 提升=${holdOutImproved}）`, "evolution-gate");
        }
        catch (e) { console.error(`[evolution-gate] 提案 ${fname} 审计写入失败（不影响判定）: ${e.message}`); }
        out.details.push({ file: fname, verdict: p.verdict });
        if (accepted)
            out.accepted++;
        else
            out.rejected++;
    }
    return out;
}
