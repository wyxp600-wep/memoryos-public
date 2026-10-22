/**
 * MemoryOS — 执行工具面（P0）
 * 内容：file_read（L0 只读） / file_write（L1 必审 + 改前自动备份） / exec_run（L1 必审 + 参数数组执行 + cwd 白名单 + 超时杀进程树）
 * 设计要点（对应 docs/agent-completion/FINAL-补全方案.md）：
 *  ① TOOL_RISK 是**全部工具**（口径以 `Object.keys(TOOL_RISK)` / `node dist/smoke-toolrisk.mjs` 为准）的风险级/审批策略单一真相源 —— 修 F1（原先 agent-core.js:15-19 硬编码 WRITE_TOOLS）。
 *     server.js 在 addTool 覆写处把 `⟨risk:Lx|gate:required|auto⟩` 前缀注入工具描述；
 *     agent-core 从 tools/list 解析该前缀决定是否过 writeGate，**解析不到一律按需审批（fail-closed）**。
 *  ② 输出预算：stdout/stderr 各留 head 50 行 + tail 50 行，超限全文落 data/artifacts/ 并回传路径（修 F3 只保头部丢尾部）。
 *  ③ exec_run 用参数数组 spawn（**不用 shell 字符串拼接**，杜绝命令注入），执行前校验 cwd 在允许根内。
 *  ④ 每次调用写 exec_audit（append-only），审计失败不阻断执行。
 * 纪律：不写入凭据；路径一律经 resolveInside 校验（真实路径比对，防符号链接逃逸）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

/* ── 风险表：全部工具（F1 单一真相源）──────────────────────────────
   L0 只读无副作用 / L1 工作区内变异 / L2 工作区外变异 / L3 网络 / L4 特权
   gate:true = 必须过 writeGate 审批；false = 自动放行                          */
export const TOOL_RISK = {
    // — 2026-10-19 工具面整合：冷门同风险级工具并门（风险级/审批语义逐字不变） —
    memory_admin: { risk: "L0", gate: false },    // 合并门：memory_report+memory_health+memory_quality（原三者均 L0/auto）
    memory_work: { risk: "L1", gate: true },      // 合并门：memory_work_read+write（★ 修复：原两者漏登记风险表，fail-closed 成 L4/required）
    obsidian: { risk: "L1", gate: true },         // 合并门：obsidian_import/export/write_note（原三者均 L1/required；不进无头预授权）
    method_query: { risk: "L0", gate: false },    // 合并门：method_search/read/preflight（原三者均 L0/auto）
    method_apply: { risk: "L1", gate: true },     // 合并门：method_generate/run/feedback（原三者均 L1/required）
    task_admin: { risk: "L1", gate: true },       // 合并门：task_block/reopen/verify（原三者均 L1/required，均不在无头预授权）
    memory_evidence: { risk: "L1", gate: true },
    // — 记忆域 —
    memory_search: { risk: "L0", gate: false },
    memory_read: { risk: "L0", gate: false },
    memory_ask: { risk: "L0", gate: false },
    memory_context: { risk: "L0", gate: false },   // ★ 2026-10-19 吸收 memory_projects（返回体本就含可用 project 清单）
    memory_write: { risk: "L1", gate: true },
    memory_feedback: { risk: "L1", gate: true },
    memory_cite: { risk: "L1", gate: true },
    memory_credential: { risk: "L4", gate: true },   // ★ 2026-09-22 补缺：凭据签发/撤销/查询 = 特权操作
    tool_guide: { risk: "L0", gate: false },         // ★ 批次F1（P2-2）：纯只读详规查询
    // — Obsidian 域 —（2026-10-19 起三工具并入 obsidian 合并门，风险级不变）
    // — 任务域 —
    task_next: { risk: "L0", gate: false },
    task_assign: { risk: "L1", gate: true },
    task_claim: { risk: "L1", gate: true },
    task_done: { risk: "L1", gate: true },
    task_supersede: { risk: "L1", gate: true },
    task_gate: { risk: "L0", gate: false },          // ★ 2026-09-25 改判：纯只读查看（任务头 + 最近一次 task_gate 事件，内部 logExecAudit 早已写 risk:"L0"），不该每次调用都过审批
    task_delegate: { risk: "L1", gate: true },
    task_heartbeat: { risk: "L0", gate: false },     // 纯续期心跳，无人值守必需，自动放行
    task_release: { risk: "L1", gate: true },        // 归还锁/租约；无头预授权见 HEADLESS_PREAUTHORIZED
    // — 执行域（P0 新增）—
    file_read: { risk: "L0", gate: false },
    file_write: { risk: "L1", gate: true },
    exec_run: { risk: "L1", gate: true },
};

/** 无头（--work / --auto-write）模式的预授权白名单 —— 用户决策「方案 c」：
 *  仅 task_* 与 memory_* 预授权，**执行类 L1（file_write/exec_run 等）仍然拒绝**。
 *  注：obsidian_* 不在预授权内 —— 它们会写工作区外的 vault，无头模式下同样需要显式同意。
 *  ★ 2026-09-22（方案 A）：补 task_release —— 无头模式不归还锁/租约会泄漏资源；
 *    task_delegate/block/reopen/verify 与 memory_credential **不在**预授权内（状态流转/特权仍需人；
 *    task_gate 已于 2026-09-25 改判 L0/auto —— 纯只读查看，不再属本条所列）。 */
export const HEADLESS_PREAUTHORIZED = new Set([
    "task_assign", "task_claim", "task_done", "task_supersede", "task_release",
    "memory_write", "memory_feedback", "memory_cite",
]);

/** 描述前缀（agent-core 解析用）。★ 2026-09-22 fail-closed 兜底（用户拍板「server 注入端兜底」）：
 *  未知工具（不在 TOOL_RISK）返回 L4/required —— 注入端保证 tools/list 上 100% 工具带前缀，
 *  新增工具漏登记只会「多审批」，绝不会静默放行；agent-core 的 LEGACY_WRITE_TOOLS 回落
 *  仅服务真正未打前缀的旧 server（本端不再产生无前缀工具）。 */
export function riskPrefix(name) {
    const m = TOOL_RISK[name];
    if (!m) return "⟨risk:L4|gate:required⟩ ";
    return `⟨risk:${m.risk}|gate:${m.gate ? "required" : "auto"}⟩ `;
}

/* ── 输出预算与 artifact ─────────────────────────────────────── */
const OUT_BUDGET_BYTES = 4096;   // shell/文件读取的单流预算
const HEAD_LINES = 50;
const TAIL_LINES = 50;
const ARGS_DIGEST_MAX = 300;     // 审计里参数摘要上限
const DETAIL_MAX = 400;
const SENSITIVE_KEY = /(key|token|secret|password|passwd|credential|authorization)/i;

/** 参数摘要：截断 + 剔除敏感键值（审计绝不落凭据） */
export function digestArgs(args) {
    let s;
    try {
        s = JSON.stringify(args ?? {}, (k, v) => (SENSITIVE_KEY.test(k) ? "«已隐去»" : v));
    } catch { s = "(不可序列化)"; }
    return s.length > ARGS_DIGEST_MAX ? s.slice(0, ARGS_DIGEST_MAX) + `…(+${s.length - ARGS_DIGEST_MAX})` : s;
}

/** 把长文本切成 head/tail 摘要；返回 {text, truncated, totalBytes, totalLines} */
export function headTail(raw) {
    const s = String(raw ?? "");
    const totalBytes = Buffer.byteLength(s, "utf8");
    const lines = s.split(/\r?\n/);
    const totalLines = lines.length;
    const truncated = totalBytes > OUT_BUDGET_BYTES;
    if (!truncated) return { text: s, truncated: false, totalBytes, totalLines };
    const head = lines.slice(0, HEAD_LINES).join("\n");
    const tail = lines.slice(-TAIL_LINES).join("\n");
    return {
        text: `${head}\n\n…（中间省略 ${Math.max(0, totalLines - HEAD_LINES - TAIL_LINES)} 行 / 全文 ${totalLines} 行、${totalBytes} 字节，完整内容见 artifact）…\n\n${tail}`,
        truncated: true,
        totalBytes,
        totalLines,
    };
}

/** 大输出落盘，返回相对可读路径（失败返回 null，不阻断） */
function spillArtifact(dataDir, tool, text) {
    try {
        const dir = path.join(dataDir, "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const file = path.join(dir, `${tool}-${ts}-${crypto.randomBytes(3).toString("hex")}.txt`);
        fs.writeFileSync(file, String(text ?? ""), "utf8");
        return file;
    } catch (e) {
        // 落盘失败降级返回 null（工具主结果不受影响），但必须留痕——否则大输出静默丢失无从排查
        console.error(`[exec] artifact 落盘失败（${tool}）: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

/* ── 路径与命令安全 ─────────────────────────────────────────── */
/** Windows 保留设备名（含带扩展名形态如 `CON.txt` 也会被映射到设备而非文件）。 */
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
/** 解析并强制路径落在允许根内（比对真实路径，防符号链接逃逸）；越界抛错。
 *  ★ 2026-10-14 补三处 Windows 缺口（原实现只挡 UNC + 越界）：
 *   ① ADS 备用数据流：`note.txt:evil` 在 Windows 上是合法路径、可读可写，而它前缀仍在 root 内
 *      ⇒ 原 startsWith 校验直接放行（等于「工作区内文件」的直觉被绕过）。凡盘符后再出现 `:` 一律拒。
 *   ② 保留设备名：CON/PRN/AUX/NUL/COM1-9/LPT1-9 被 Windows 映射到设备，写进去去向不明
 *      （NUL=丢弃、CON=控制台）⇒ 逐段基名比对，命中即拒。
 *   ③ TOCTOU 见 assertStillInside（本函数只负责「校验时刻」正确，不负责「使用时刻」）。 */
export function resolveInside(root, p) {
    if (typeof p !== "string" || !p.trim()) throw new Error("路径不能为空");
    if (/^\\\\|^\/\//.test(p)) throw new Error("拒绝 UNC 路径");
    const abs = path.resolve(root, p);
    if (process.platform === "win32") {
        // ① ADS：跳过盘符（"C:"）后不得再出现 ':'
        if (abs.slice(2).includes(":"))
            throw new Error(`拒绝备用数据流路径（'${path.sep}' 后含 ':'）：${p}`);
        // ② 保留设备名：逐段取基名（去扩展名）比对
        for (const seg of abs.slice(3).split(/[\\/]+/)) {
            if (WIN_RESERVED.test(seg.split(".")[0].toUpperCase()))
                throw new Error(`拒绝 Windows 保留设备名路径：${p}`);
        }
    }
    const realRoot = fs.realpathSync(root);
    // 目标可能尚不存在（新建文件）：退化为校验其最近的已存在祖先目录
    let probe = abs;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    const realProbe = fs.realpathSync(probe);
    const inside = (target) => target === realRoot || target.startsWith(realRoot + path.sep);
    if (!inside(realProbe) || !inside(path.resolve(abs))) {
        throw new Error(`路径越界（必须位于工作区 ${realRoot} 内）：${p}`);
    }
    return abs;
}

/** ★ 2026-10-14（TOCTOU 收窄）：真正 read/write/spawn 之前，**再校验一次**「目标（或其最近的已存在
 *  祖先）的真实路径仍在校验时认定的根内」。
 *  纯 JS + Windows 无 O_NOFOLLOW 语义 ⇒ **无法完全消除**「校验→使用」之间的替换窗口；
 *  本函数把窗口从「任意长」压到微秒级，属**收窄而非根治**（如实声明；根治需平台级句柄校验）。
 *  ★ 探测起点必须是 `abs` 自身（不是 dirname）：否则目标=工作区根时（如 exec_run 默认 cwd="."），
 *    dirname 落在根之外 → 误判越界。口径与 resolveInside 对新文件的「逐级向上找已存在祖先」一致。 */
function assertStillInside(root, abs) {
    const realRoot = fs.realpathSync(root);
    let probe = abs;
    while (!fs.existsSync(probe)) {
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
    }
    let real;
    try { real = fs.realpathSync(probe); }
    catch { throw new Error(`路径祖先不可解析（疑似校验后被删除/替换）：${abs}`); }
    if (!(real === realRoot || real.startsWith(realRoot + path.sep)))
        throw new Error(`路径在「校验→使用」之间发生越界（疑似被替换为软链）：${abs}`);
}

/** 命令可执行文件白名单（保守默认：**不含 shell 宿主与脚本解释器**——cmd/powershell/pwsh/python
 *  一旦放行，["powershell","-Command","…"] 即绕过整个清单，等于没有白名单；
 *  确需时用 MEMORYOS_EXEC_ALLOW 显式加入，并自行承担 shell 逃逸面）
 * ★ 2026-10-14（安全加固 · 方案 A）：`npx` 移出默认清单 —— 它「拉远程包直接跑」，
 *   是唯一完全不需要工作区文件、单次调用即执行远端代码的入口。其余形态由 execDenyReason 兜。 */
export function execAllowlist() {
    const env = process.env.MEMORYOS_EXEC_ALLOW;
    if (env && env.trim()) return new Set(env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    return new Set(["npm", "git", "node"]);
}
/** ★ 2026-10-14（安全加固 · 命令形态守卫，方案 A）——拦住「**单次调用**即执行任意/远程代码」的形态。
 *
 *  为什么需要它：白名单只按**可执行文件基名**放行。基名一旦在清单里，下面这些就都能一次调用跑起来，
 *  既不需要先 file_write（因而绕过了「写操作必审」那道闸），也不需要第二次人工批准：
 *    · `["node","-e","<任意代码>"]`          —— node 内在的 eval 通道
 *    · `["npx","<任意包>"]` / `["npm","exec"…]` —— 拉远程包执行
 *    · `["npm","install"…]`                  —— 触发第三方包 postinstall 生命周期脚本
 *    · `["git","-c","alias.pwn=!命令","pwn"]` —— git alias 前缀 `!` 直接起 shell
 *    · `["git","rebase","--exec","<命令>"]`  —— git 自带的 exec 类子命令
 *
 *  ★ 边界如实声明（不夸大）：这是**黑名单**，只能抬高门槛、**不能穷举**——同类形态（如
 *   `npm pkg set scripts.test=… ` 再 `npm test`、未来新增的子命令）仍可能漏网。彻底封堵须改
 *   「服务端挂起审批」（审的是"这次要跑什么"，不依赖枚举）——已列报，见 CLAIM §5 2026-10-14 行。
 *
 *  语义：**只在默认清单生效时启用**。显式设置 MEMORYOS_EXEC_ALLOW = 操作者已知悉并承担风险 →
 *  守卫让位（避免"设了白名单却被静默改写"的惊讶，也保住自用者的完整能力）。
 *  只在 MCP `exec_run`（LLM 行走的通道）启用；看板准终端是人手敲的，不强加本守卫。
 */
const DENY_SPEC = {
    node: { flags: ["-e", "--eval", "-p", "--print", "--import", "--experimental-loader"] },
    git: {
        flags: ["-c", "--exec-path", "--config-env", "--upload-pack", "--receive-pack",
            "--exec", "--tree-filter", "--msg-filter"],
        subcommands: ["rebase", "bisect", "submodule", "filter-branch", "filter-repo", "send-email"],
    },
    npm: { subcommands: ["exec", "x", "install", "i", "add", "ci", "link", "unlink", "create", "init", "rebuild", "update", "pkg"] },
};
/** 返回拒绝原因（人话）或 null（放行）。cmd 为完整命令数组（含 exe 本身）。
 *  匹配口径：开关/子命令按**整词相等**比对 —— 宁可保守（如 `git show rebase` 会被误拒），
 *  也不放过真实危险形态。 */
export function execDenyReason(cmd) {
    if (process.env.MEMORYOS_EXEC_ALLOW && process.env.MEMORYOS_EXEC_ALLOW.trim())
        return null; // 显式放开：操作者已知悉风险，守卫让位
    const arr = Array.isArray(cmd) ? cmd.map(String) : [];
    const base = path.basename(arr[0] ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
    const spec = DENY_SPEC[base];
    if (!spec) return null;
    const rest = arr.slice(1);
    for (const f of spec.flags ?? []) {
        if (rest.includes(f))
            return `命令形态被拒：${base} 的 ${f} 可直接执行任意代码（不经工作区文件、也不需要二次审批）。如确需请改用文件方式，或显式设置 MEMORYOS_EXEC_ALLOW 自行承担该风险。`;
    }
    for (const s of spec.subcommands ?? []) {
        if (rest.includes(s))
            return `命令形态被拒：${base} ${s} 会执行第三方包或自定义命令。如确需请显式设置 MEMORYOS_EXEC_ALLOW 自行承担该风险。`;
    }
    return null;
}

/* ── ★ 2026-10-14（方案 B · 服务端挂起审批）高风险判定 ─────────────────────────
 * 与上面 DENY_SPEC 的分工（两条闸，语义不同，切勿混为一谈）：
 *   · DENY_SPEC = **黑名单 → 直接拒**：一次调用即任意/远程代码、agent 场景无正当理由的形态；
 *   · 本函数   = 清单内**跑得了**但可能不可逆 / 改动信任面的形态 → **挂起交人裁量**
 *     （人看得见命令原文与工作目录，故不必穷举"危险长什么样"）。
 * 判据取向 = **白名单式失败关闭**：只认「已知只读/常规开发」子命令，其余（含未来新增子命令）一律挂起。
 *   这正是方案 B 相对黑名单的核心收益 —— 新形态自动落入待批，不再漏网。
 * 低摩擦原则：日常动作（git status/diff/log/add/commit、npm test/run、node 跑工作区脚本）一律直放。
 * 返回**人话原因**（非 null ⇒ 需人批）或 null（低风险，直放）。
 */
const GIT_READ_SUB = new Set([
    "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "describe",
    "shortlog", "blame", "grep", "name-rev", "count-objects", "check-ignore", "check-attr", "fsck", "whatchanged",
    "version", "help", "cherry", "merge-base", "diff-tree", "diff-index", "diff-files", "verify-commit",
    "verify-tag", "for-each-ref", "show-ref", "symbolic-ref", "var", "add", "commit", "mv", "rm", "cherry-pick",
    "revert", "merge", "apply", "am", "format-patch", "notes", "request-pull", "bundle", "repository-layout",
]);
/** 查看型子命令：带危险开关才挂起（不带开关 = 只读，直放） */
const GIT_MIXED_SUB = {
    branch: ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-u", "--set-upstream-to", "--unset-upstream", "--track", "--edit-description"],
    tag: ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-m", "--message", "-f", "--force"],
    remote: ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"],
    stash: ["drop", "clear"],
    reflog: ["expire", "delete"],
    worktree: ["add", "remove", "prune", "lock", "unlock", "move", "repair"],
};
const NPM_READ_SUB = new Set([
    "test", "t", "run", "run-script", "ls", "list", "view", "info", "show", "outdated", "why", "explain",
    "prefix", "root", "bin", "help", "usage", "doctor", "query", "repo", "explore", "ls-remote", "star",
]);
const NODE_RISK_FLAGS = ["--inspect", "--inspect-brk", "--inspect-port", "--watch", "--watch-path", "--run", "-"];

export function execRiskReason(cmd) {
    const arr = Array.isArray(cmd) ? cmd.map(String) : [];
    const base = path.basename(arr[0] ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
    const rest = arr.slice(1);
    const has = (...xs) => xs.some((x) => rest.includes(x));
    const first = rest.find((a) => !a.startsWith("-")) ?? "";
    if (base === "git") {
        if (!first)
            return null; // 裸 git → 仅打印用法
        if (first === "config")
            return has("-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch")
                ? null
                : "git config 的写形态：可植入 alias/hook/credential helper → 等于给出持久化的代码执行面";
        const mixed = GIT_MIXED_SUB[first];
        if (mixed) {
            const bad = mixed.find((f) => rest.includes(f));
            return bad ? `git ${first} ${bad} 属写/破坏形态：不可逆或改动仓库信任面` : null;
        }
        if (GIT_READ_SUB.has(first))
            return null;
        return `git ${first} 不在「已知只读/常规开发」白名单内（含 push/clean/reset/pull 等不可逆或联网动作，以及未来新增子命令）`;
    }
    if (base === "npm") {
        if (!first)
            return null; // npm --version / 裸 npm
        if (first === "config")
            return has("-l", "--list", "get", "list", "ls") ? null : "npm config 的写形态：可改 registry / 认证配置";
        if (first === "audit")
            return has("fix") ? "npm audit fix 会改写依赖树（不可逆）" : null;
        if (NPM_READ_SUB.has(first))
            return null;
        return `npm ${first} 不在「已知低风险」白名单内：可能改依赖树、发布产物或写盘`;
    }
    if (base === "node") {
        const bad = NODE_RISK_FLAGS.find((f) => rest.includes(f));
        return bad ? `node ${bad}：开调试口 / 长驻监听 / 执行 package 脚本，属单次调用即可扩展执行面` : null;
    }
    // 其余可执行文件只在「显式自定义白名单（MEMORYOS_EXEC_ALLOW）」下出现，且那种情形审批闸整体让位；
    // 这里仍按高危兜底（防御性：不依赖另一处开关的正确性）。
    return `可执行文件 ${base} 不属于默认只读面（自定义白名单场景按高危处理）`;
}

/** 杀整棵进程树（Windows 用 taskkill /T /F，与 services/core-process.js 既有模式一致）
 *  ★ 1b：导出供 server-reg-task.js 的 [gate] 验收子进程复用（同一套「不留孤儿」口径）。 */
export function killTree(child) {
    try {
        if (process.platform === "win32") {
            if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
    } catch { /* 已退出 */ }
}

/* ── 工具实现 ───────────────────────────────────────────────── */
/**
 * @param {object} o
 * @param {string} o.workspaceRoot 允许读写的工作区根（cwd 白名单）
 * @param {string} o.dataDir       内核数据目录（artifact 落 <dataDir>/artifacts）
 * @param {string} o.agent         调用方 agent 名（审计用）
 * @param {Function} o.logAudit    (row) => void ；审计写入，失败会被吞掉
 * @param {Function} [o.getAbortSignal] ★ 1b：() => AbortSignal|null —— 当前请求的取消信号
 *   （核心侧由 dashboard-reg-ops.js 的请求中断生成；direct 模式恒 null ⇒ 行为与改前逐字一致）
 * @param {Function} [o.getClientCwd] ★ 1b 收口（缺口 B）：() => string|null —— 当前请求的调用方 cwd
 *   （核心侧由 `x-memory-cwd` 头透传；direct 模式恒 null ⇒ 回落 workspaceRoot，行为与改前逐字一致）
 */
export function createExecTools({ workspaceRoot, dataDir, agent = "unknown", logAudit = () => { }, approvalGate = null, getAbortSignal = () => null, getClientCwd = () => null }) {
    const audit = (row) => { try { logAudit({ agent, ...row }); } catch { /* 审计失败不阻断执行 */ } };
    // ★ 2026-10-14（方案 B）：审批闸（可选注入）。接受 exec-approval.js 的 { request, settle }，或旧式函数。
    const gateRequest = typeof approvalGate === "function"
        ? approvalGate
        : (approvalGate && typeof approvalGate.request === "function" ? (r) => approvalGate.request(r) : null);
    const gateSettle = approvalGate && typeof approvalGate.settle === "function"
        ? (id, info) => { try { approvalGate.settle(id, info); } catch { /* 回填失败不影响命令结果 */ } }
        : null;

    /** ★ 1b 收口（缺口 B）：相对路径 / 缺省 cwd 的**基准目录**。
     *  口径差异（保持语义等价，不是新语义）：
     *   · direct = 服务进程工作区（workspaceRoot 由进程 env 派生）—— 取不到 clientCwd（null）→ 回落 root；
     *   · shim   = 调用方 cwd 透传（核心侧 x-memory-cwd → clientCwd）—— 调用方未显式给 cwd/路径基准时按其 cwd 解析。
     *  仅当 clientCwd 解析后确实**落在允许根内**时才采用（否则忽略退回 root —— 绝不因一个头放宽边界）。
     *  显式传参（args.cwd / 绝对路径）仍以显式为准（行为不变）。与 wt/b1a-cwd-qoder 的 resolveRunCwd
     *  （卡片 worktree 裁决）对齐留待后续批次，本批不发明第二套。 */
    const pickBase = () => {
        const c = getClientCwd?.();
        if (typeof c !== "string" || !c.trim())
            return workspaceRoot;
        const abs = path.resolve(c);
        try { resolveInside(workspaceRoot, abs); }   // 复用边界口径：越界/非法 → 抛错 → 忽略
        catch { return workspaceRoot; }
        return abs;
    };

    return [
        /* ── file_read（L0，自动放行）──────────────────────── */
        {
            name: "file_read",
            description: `读取工作区内文本文件（带行号）。默认工作区：${workspaceRoot}`,
            parameters: z.object({
                path: z.string().describe("文件路径（相对工作区或工作区内绝对路径）"),
                offset: z.number().int().min(1).optional().describe("起始行（1 基），默认 1"),
                limit: z.number().int().min(1).max(2000).optional().describe("最多返回行数，默认 400"),
            }),
            async execute(args) {
                const t0 = Date.now();
                try {
                    // ★ 缺口 B：相对路径基准 = 调用方 cwd（clientCwd 透传）；direct 取不到 → 回落 workspaceRoot（行为不变）
                    const target = path.isAbsolute(args.path) ? args.path : path.resolve(pickBase(), args.path);
                    const abs = resolveInside(workspaceRoot, target);
                    assertStillInside(workspaceRoot, abs);   // ★ TOCTOU 收窄：临读前再校验一次
                    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${args.path}`);
                    const st = fs.statSync(abs);
                    if (st.isDirectory()) throw new Error(`这是目录，不是文件：${args.path}（目录浏览请用 file_list/glob）`);
                    const raw = fs.readFileSync(abs, "utf8");
                    const lines = raw.split(/\r?\n/);
                    const off = (args.offset ?? 1) - 1;
                    const lim = args.limit ?? 400;
                    const slice = lines.slice(off, off + lim);
                    const numbered = slice.map((l, i) => `${String(off + i + 1).padStart(5)}| ${l}`).join("\n");
                    const { text, truncated, totalLines } = headTail(numbered);
                    audit({ tool: "file_read", risk: "L0", approval: "auto", argsDigest: digestArgs(args), detail: `${totalLines} 行`, durationMs: Date.now() - t0 });
                    return `【file_read】${abs}\n共 ${lines.length} 行，返回第 ${off + 1}–${off + slice.length} 行${truncated ? "（已按预算裁剪）" : ""}\n${text}`;
                } catch (e) {
                    audit({ tool: "file_read", risk: "L0", approval: "auto", argsDigest: digestArgs(args), detail: `错误: ${e.message}`, durationMs: Date.now() - t0 });
                    throw e;
                }
            },
        },

        /* ── file_write（L1，必审；改前自动备份）──────────── */
        {
            name: "file_write",
            description: `写入/覆盖工作区内文本文件。默认改前自动生成时间戳备份（.bak-p0exec-<ts>）。工作区：${workspaceRoot}`,
            parameters: z.object({
                path: z.string().describe("文件路径（相对工作区或工作区内绝对路径）"),
                content: z.string().describe("完整文件内容（整文件覆盖）"),
                backup: z.boolean().optional().describe("是否在覆盖前备份，默认 true（仅对已存在文件生效）"),
            }),
            async execute(args) {
                const t0 = Date.now();
                let backupPath = null;
                try {
                    // ★ 缺口 B：相对路径基准 = 调用方 cwd（clientCwd 透传）；direct 取不到 → 回落 workspaceRoot（行为不变）
                    const target = path.isAbsolute(args.path) ? args.path : path.resolve(pickBase(), args.path);
                    const abs = resolveInside(workspaceRoot, target);
                    assertStillInside(workspaceRoot, abs);   // ★ TOCTOU 收窄：临写前再校验一次
                    const existed = fs.existsSync(abs);
                    if (existed && args.backup !== false) {
                        const ts = new Date().toISOString().replace(/[:.]/g, "-");
                        backupPath = `${abs}.bak-p0exec-${ts}`;
                        fs.copyFileSync(abs, backupPath);
                    }
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, String(args.content ?? ""), "utf8");
                    const bytes = Buffer.byteLength(String(args.content ?? ""), "utf8");
                    audit({ tool: "file_write", risk: "L1", approval: "gate-allowed", argsDigest: digestArgs(args), detail: `${existed ? "覆盖" : "新建"} ${bytes} 字节${backupPath ? " 已备份" : ""}`, durationMs: Date.now() - t0 });
                    return `【file_write】已${existed ? "覆盖" : "新建"} ${abs}（${bytes} 字节）${backupPath ? `\n改前备份：${backupPath}` : ""}`;
                } catch (e) {
                    audit({ tool: "file_write", risk: "L1", approval: "gate-allowed", argsDigest: digestArgs(args), detail: `错误: ${e.message}`, durationMs: Date.now() - t0 });
                    throw e;
                }
            },
        },

        /* ── exec_run（L1，必审；参数数组，无 shell 拼接）──── */
        {
            name: "exec_run",
            description: `在工作区内执行一条命令。参数为**数组**（如 ["npm","test"]，不经过 shell 拼接，故不支持管道/重定向）。cwd 受限于工作区；超时会杀掉整棵进程树。`,
            parameters: z.object({
                cmd: z.array(z.string()).min(1).describe('命令与参数数组，例：["npm","test"] 或 ["git","status","--short"]'),
                cwd: z.string().optional().describe("工作目录（相对工作区，默认工作区根）"),
                timeout_ms: z.number().int().min(1000).max(600000).optional().describe("超时毫秒，默认 30000，上限 600000"),
            }),
            async execute(args) {
                const t0 = Date.now();
                const timeoutMs = args.timeout_ms ?? 30000;
                const auditRow = { tool: "exec_run", risk: "L1", approval: "gate-allowed", argsDigest: digestArgs(args) };
                let cwd;
                try {
                    // ★ 缺口 B：缺省 cwd 基准 = 调用方 cwd（clientCwd 透传）；显式 args.cwd 仍以显式为准（行为不变）
                    const cwdTarget = args.cwd !== undefined ? args.cwd : path.resolve(pickBase(), ".");
                    cwd = resolveInside(workspaceRoot, cwdTarget);
                    assertStillInside(workspaceRoot, cwd);   // ★ TOCTOU 收窄：临 spawn 前再校验一次
                    if (!fs.statSync(cwd).isDirectory()) throw new Error(`cwd 不是目录：${args.cwd}`);
                } catch (e) {
                    audit({ ...auditRow, detail: `cwd 校验失败: ${e.message}`, durationMs: Date.now() - t0 });
                    throw e;
                }
                const [exe, ...rest] = args.cmd;
                const base = path.basename(String(exe)).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
                const allow = execAllowlist();
                if (!allow.has(base)) {
                    const msg = `命令 ${exe} 不在允许清单内（当前允许：${[...allow].join(", ")}）。如确需，请用安装/配置流程加入 MEMORYOS_EXEC_ALLOW。`;
                    audit({ ...auditRow, detail: msg, durationMs: Date.now() - t0 });
                    throw new Error(msg);
                }
                // ★ 2026-10-14（方案 A）：命令形态守卫 —— 拦住「单次调用即任意/远程代码执行」的形态
                //   （node -e / npm exec·install / git -c alias·rebase --exec …，详见 DENY_SPEC 注释）
                const deny = execDenyReason(args.cmd);
                if (deny) {
                    audit({ ...auditRow, approval: "gate-denied", detail: deny, durationMs: Date.now() - t0 });
                    throw new Error(deny);
                }
                // ★ 2026-10-14（方案 B · 服务端挂起审批）：高风险 → 落待批并**挂起**，等人看板点同意才继续。
                //   低风险命令（execRiskReason=null）零打扰直放。被拒 / 超时一律**不执行**，并把结论原样回告发起方
                //   （回告里带审批编号与原因，便于人机对齐「刚被拒的是哪一条」）。
                const risk = execRiskReason(args.cmd);
                let approvalId = null;
                if (risk) {
                    if (!gateRequest) {
                        // 未接审批通道（如裸用 createExecTools 的场景）→ 保持保守语义：拒绝，绝不静默放行
                        const msg = `高风险命令被拒（本次运行未接入人工审批通道）：${risk}。如确需请显式设置 MEMORYOS_EXEC_APPROVAL=0 自行承担风险。`;
                        audit({ ...auditRow, approval: "gate-denied", detail: msg, durationMs: Date.now() - t0 });
                        throw new Error(msg);
                    }
                    const d = await gateRequest({ cmd: args.cmd, cwd, reason: risk, agent });
                    approvalId = d?.id ?? null;
                    if (d?.decision !== "approved") {
                        const msg = d?.decision === "denied"
                            ? `高风险命令被人工拒绝（审批 #${approvalId}，${d?.by ?? "human"}）：${risk}`
                            : `高风险命令等待人工审批超时（审批 #${approvalId}，无人处理）→ 按拒绝处理：${risk}`;
                        audit({ ...auditRow, approval: d?.decision === "denied" ? "human-denied" : "approval-expired", detail: msg, durationMs: Date.now() - t0 });
                        throw new Error(`${msg}。请把命令原文与理由交给人工操作者（看板 → 待批命令）；或改用低风险形态（只读子命令 / 工作区脚本文件）。`);
                    }
                    audit({ ...auditRow, approval: "human-approved", detail: `高风险命令经人工批准（审批 #${approvalId}）：${risk}`, durationMs: Date.now() - t0 });
                }
                return await new Promise((resolve, reject) => {
                    const child = spawn(exe, rest, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32" });
                    let out = "", err = "", timedOut = false, aborted = false, settled = false;
                    const cap = OUT_BUDGET_BYTES * 8; // 采集上限（防内存爆），超出后仍继续接收但丢弃多余
                    child.stdout.on("data", (d) => { if (out.length < cap) out += d.toString(); });
                    child.stderr.on("data", (d) => { if (err.length < cap) err += d.toString(); });
                    const timer = setTimeout(() => {
                        timedOut = true;
                        killTree(child);
                    }, timeoutMs);
                    // ★ 1b：请求中断（MCP 客户端取消 / stdio 关闭 → 核心侧 req close）→ 立即杀掉整棵进程树，不留孤儿
                    const sig = getAbortSignal();
                    const onAbort = () => { aborted = true; killTree(child); };
                    const unbind = () => { if (sig) { try { sig.removeEventListener("abort", onAbort); } catch { /* 忽略 */ } } };
                    if (sig) {
                        if (sig.aborted)
                            onAbort();
                        else
                            sig.addEventListener("abort", onAbort, { once: true });
                    }
                    child.on("error", (e) => {
                        if (settled) return; settled = true; clearTimeout(timer); unbind();
                        audit({ ...auditRow, detail: `spawn 失败: ${e.message}`, durationMs: Date.now() - t0 });
                        reject(new Error(`命令启动失败：${e.message}`));
                    });
                    child.on("close", (code) => {
                        if (settled) return; settled = true; clearTimeout(timer); unbind();
                        const ms = Date.now() - t0;
                        const o = headTail(out), e2 = headTail(err);
                        let artifact = null;
                        if (o.truncated || e2.truncated) {
                            artifact = spillArtifact(dataDir, "exec_run", `$ ${args.cmd.join(" ")}\n[exit ${code}${timedOut ? " / TIMEOUT" : ""}${aborted ? " / ABORTED" : ""}]\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
                        }
                        const head = `【exec_run】$ ${args.cmd.join(" ")}  (cwd=${cwd})\nexit=${timedOut ? "TIMEOUT" : code}  用时 ${ms}ms${artifact ? `\n完整输出：${artifact}` : ""}`;
                        const body = `\n--- stdout (${o.totalLines} 行) ---\n${o.text || "(空)"}\n--- stderr (${e2.totalLines} 行) ---\n${e2.text || "(空)"}`;
                        audit({ ...auditRow, approval: aborted ? "request-aborted" : auditRow.approval, detail: `exit=${timedOut ? "TIMEOUT" : code}${aborted ? " ABORTED" : ""} ${ms}ms out=${o.totalBytes}B err=${e2.totalBytes}B`, durationMs: ms });
                        // ★ 方案 B：审批链闭环 —— 把执行结果回填待批项（谁批的 + 跑出什么），供看板/审计复盘
                        if (approvalId && gateSettle) gateSettle(approvalId, { exit: code, timedOut, ms, outBytes: o.totalBytes, errBytes: e2.totalBytes });
                        if (aborted) { resolve(`${head}${body}\n\n⚠ 请求已中断（MCP 客户端取消 / 连接关闭），进程树已终止。`); return; }
                        if (timedOut) { resolve(`${head}${body}\n\n⚠ 已超时（${timeoutMs}ms），进程树已终止。`); return; }
                        if (code !== 0) { resolve(`${head}${body}\n\n⚠ 命令失败（退出码 ${code}）。请按 stderr 尾部定位（错误通常在尾部）。`); return; }
                        resolve(`${head}${body}`);
                    });
                });
            },
        },
    ];
}
