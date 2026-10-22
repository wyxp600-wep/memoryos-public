/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-reg-cliexec.js — 节点画布 P2：CLI 直控执行器（2026-10-04）
 * 能力：agent_profiles(channel='cli') 的卡片派发不走内部 agent run，而是以 headless
 *       模式直接拉起本机智能体 CLI（codex/claude/…），工作区=spawn cwd、模型/推理强度
 *       =启动参数、任务提示词走 stdin；stdout/stderr 逐块经 SSE 回填卡片终端区。
 * 设计纪律（设计报告 §5.3 / D7/D8）：
 *  - 串行队列：同档案并发上限 concurrency（缺省 1），多派发排队；
 *  - 心跳：执行期间每 60s 续卡租约 + 工作证租约（防治理回收误杀）；
 *  - 收口复用 finalizeCardDispatch（结算工作证/翻边/生成交接卡全套语义不变）；
 *  - 分隔符协议（D7）：提示词约定 <<<HANDOFF>>>…<</HANDOFF>>>；解析失败兜底=输出尾部
 *    截取 + 全量日志落盘，绝不因格式漂移丢结果；
 *  - 杀树（D8）：taskkill /T /F 连带子进程；超时自动杀；孤儿预防=detached:false。
 *  - launch_overrides 可整体覆盖 {cmd,args,useStdin,timeoutMinutes}（隔离测试/自定义 CLI）。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createCliRunHistory } from "./cli-run-history.js";
import os from "node:os";
import path from "node:path";
import { renewCardLease } from "./db.js";
import { killTree as killTreePid, pruneFinishedJobs, overridesOf, findJobByCard, streamJobSSE } from "./dashboard-exec-util.js";

/** 已知 CLI 的启动预设（launch_overrides 可整体覆盖） */
const CLI_PRESETS = {
    codex: {
        cmd: "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "-"], // `-` = 提示词走 stdin
        useStdin: true,
        modelArgs: (m) => (m ? ["--model", m] : []),
    },
    claude: {
        cmd: "claude",
        args: ["-p", "--output-format", "text", "--dangerously-skip-permissions"],
        useStdin: true,
        modelArgs: (m) => (m ? ["--model", m] : []),
    },
    // ★ 2026-10-05 P4 载体点亮：mimocode（scan id=mimocode / 别名 mimo）= Xiaomi MiMo CLI。
    //   实证（本机）：`mimo run` 支持位置参数与 stdin 管道两种提示词形态、--pure 免外部插件、
    //   -m 走 provider/model 形式；凭据在 ~/.local/share/mimocode/auth.json（providers whoami 核实）。
    mimocode: {
        cmd: "mimo",
        args: ["run", "--pure"], // 提示词走 stdin（实测管道可用）
        useStdin: true,
        modelArgs: (m) => (m ? ["-m", m] : []),
    },
    mimo: {
        cmd: "mimo",
        args: ["run", "--pure"],
        useStdin: true,
        modelArgs: (m) => (m ? ["-m", m] : []),
    },
    // ★ 2026-10-05 P4 载体点亮：dsh = DeepSeek Harness（npm 全局 `dsh`，本机已装，PATH 实证）。
    //   headless profile 是一次性无头模式（实证 2026-10-05：`dsh --profile headless "task"`
    //   = 答一个任务打印结果即退出）；任务文本只收位置参数、无 stdin 模式 → promptAsArg。
    //   缺凭据报 MISSING_CREDENTIAL 退出码 1（DEEPSEEK_API_KEY 走 dsh 凭据服务或环境变量）。
    //   注：旧注释误判 dsh「无 headless 单次模式」，2026-10-05 实证修正。
    dsh: {
        cmd: "dsh",
        args: ["--profile", "headless"],
        useStdin: false,
        promptAsArg: true,
    },
    // ★ 2026-10-05 P4 载体点亮：opencode = OpenCode CLI（桌面版自带
    //   %LOCALAPPDATA%\Programs\@opencodedesktop\resources\opencode-cli.exe，PATH 无裸名）。
    //   实证（本机 2026-10-05）：`opencode run --auto "<任务>"` 一次性无头 = message 走位置参数（无 stdin 模式）、
    //   -m 走 provider/model 形式；登录态复用桌面版，本机免 key 直接可跑（e2e 输出 ok exit=0）。
    //   本机注册档案时 launch_overrides.cmd 指向完整 exe 路径（裸名不在 PATH）。
    opencode: {
        cmd: "opencode",
        args: ["run", "--auto"],
        useStdin: false,
        promptAsArg: true,
        modelArgs: (m) => (m ? ["-m", m] : []),
    },
    // ★ 2026-10-05 P4 载体点亮：zcode = ZCode 桌面版自带 CLI（无独立可执行文件，
    //   本体为 CJS 包 <ZCode安装目录>\resources\glm\zcode.cjs，需 node 执行；本机实证路径
    //   %LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs）。
    //   无头一次性：`zcode -p "<任务>"`（缺省 yolo 权限模式、--cwd 定工作区、--locale zh-CN）。
    //   预设保持通用语义（cmd=node + 空 args + promptFlag="-p"：任务文本作 -p 的值紧跟旗标）；
    //   完整 cjs 路径由档案 launch_overrides.args 提供（机器相关路径不入仓库预设）。
    //   实证（2026-10-05）：管线通（CLI 拉起 → 模型网关调用），当日 provider 429 限流为唯一缺口；
    //   CDP 通道被 ZCode 应用级单实例锁挡死（主实例运行时二实例 ~1.5s 自退，实证 2s 采样）。
    zcode: {
        cmd: "node",
        args: [],
        useStdin: false,
        promptFlag: "-p",
    },
};
const HEARTBEAT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30 * 60000;
const MAX_BUFFER_LINES = 800;

/** 该载体预设是否接入模型旗标（批2）：`/api/agent-models` 与向导据此**如实告知**
 *  「填了模型会不会真传给 CLI」—— dsh/zcode 无 modelArgs，填了也不生效，不能假装能配。 */
export function cliAcceptsModel(agentKey) {
    return !!CLI_PRESETS[String(agentKey ?? "")]?.modelArgs;
}

export function registerCliExec(app, ctx) {
    const { db } = ctx;
    /** runId → job；queues: profileId → FIFO（串行队列，D5） */
    const jobs = new Map();
    const queues = new Map();

    const logDir = (() => {
        try {
            const dir = ctx.dataDirOf ? ctx.dataDirOf() : "";
            const full = dir ? path.join(dir, "cli-logs") : path.join(os.tmpdir(), "memoryos-cli-logs");
            fs.mkdirSync(full, { recursive: true });
            return full;
        }
        catch {
            return path.join(os.tmpdir(), "memoryos-cli-logs");
        }
    })();

    const history = createCliRunHistory(logDir);

    function pushLine(job, stream, text) {
        // 全量原文独立累积（供 HANDOFF 解析与日志落盘，D7）；lines 只服务 SSE、可截断
        job.fullText = (job.fullText ?? "") + text + (text.endsWith("\n") ? "" : "\n");
        // ★ 智能体真实输出单独累积（sys = 执行器注入的提示词/自述行）：HANDOFF 解析只能看输出，
        //   否则会命中提示词里的模板本身（见 finish 注释）
        if (stream !== "sys")
            job.agentText = (job.agentText ?? "") + text + (text.endsWith("\n") ? "" : "\n");
        const added = String(text).split(/\r?\n/).map(text => ({ stream, text, at: Date.now() }));
        job.lines.push(...added);
        history.append(job, added);
        if (job.lines.length > MAX_BUFFER_LINES * 2)
            job.lines.splice(0, job.lines.length - MAX_BUFFER_LINES);
        job.waiters?.forEach((w) => w());
    }

    /** 队列泵：档案并发位空出即启动下一个（串行默认 1；计数在循环内累加，防连派并发击穿） */
    function pump(profileId) {
        const q = queues.get(profileId);
        if (!q?.length)
            return;
        const limit = Math.max(1, Number(q.concurrency) || 1);
        let running = [...jobs.values()].filter((j) => j.profileId === profileId && j.status === "running").length;
        while (running < limit && q.length) {
            launch(q.shift());
            running++;
        }
    }

    function launch(job) {
        job.status = "running";
        job.startedAt = Date.now();
        history.save(job);
        const p = job.profile;
        const ov = overridesOf(p); // ★ 批1：容忍双重编码存量（档案 #8），旧口径会把字符串当配置 → cmd 丢失
        const preset = CLI_PRESETS[String(p.agent_key ?? "")] ?? null;
        const cmd = ov?.cmd ?? preset?.cmd ?? String(p.agent_key ?? "");
        let args = ov?.args ?? (preset ? [...preset.args] : []);
        // ★ 2026-10-05 批2（用户「模型下拉要真生效」）：原实现是
        //   `args = ov?.args ?? [...preset.args, ...preset.modelArgs(p.model)]` —— 模型旗标被关在
        //   「没有 launch_overrides.args」这条分支里，而本机档案 #9-#12 全带自定义 args，
        //   ⇒ 档案里填了模型也永远传不出去（且无声）。改为独立幂等追加。
        const modelArgs = p.model && preset?.modelArgs ? preset.modelArgs(String(p.model)) : [];
        if (modelArgs.length && !args.includes(modelArgs[0]))
            args = [...args, ...modelArgs];
        else if (p.model && !modelArgs.length)
            pushLine(job, "sys", `[直控] ⚠ 档案模型「${p.model}」未生效：该载体预设没有模型参数（可在配置的高级栏 args 里自行加旗标）`);
        if (!ov && !preset && p.reasoning)
            args = [...args, "--reasoning", String(p.reasoning)]; // 无预设的自定义 CLI：推理强度按通用flag尽力传
        // ★ 提示词两种交付形态：
        //   ① promptFlag（zcode -p <任务> 型）：[flag, 任务文本] 插入 args 末两位（文本紧跟旗标）；
        //   ② promptAsArg（dsh/opencode 位置参数型）：任务文本追加为 args 末位单参数。
        //   win32 shell:true 路径经 quote() 统一预引号，多词任务保持单个参数不被 cmd /s 拆散。
        const promptFlag = ov?.promptFlag ?? preset?.promptFlag;
        if (promptFlag)
            args = [...args, String(promptFlag), String(job.message ?? "")];
        else if (ov?.promptAsArg ?? preset?.promptAsArg ?? false)
            args = [...args, String(job.message ?? "")];
        const cwd = p.workspace || os.homedir();
        job.cwd = cwd;
        job.cmd = cmd;
        try {
            // ★ Windows：npm shim（codex.cmd 等）裸 spawn 必 ENOENT，而 .cmd 出于安全 Node 禁止直接 spawn。
            //   方案：win32 统一 shell:true + 预引号整串 —— node 会把整串再包一层引号交给
            //   cmd /d /s /c，/s 恰好剥掉 node 加的外层引号，我们预置的内层引号原样保留
            //   （解决"C:\Program Files\..."带空格路径）；taskkill /T 仍可整树杀。
            if (process.platform === "win32") {
                const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
                const commandString = `${quote(cmd)} ${args.map(quote).join(" ")}`;
                job.proc = spawn(commandString, {
                    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
                });
            }
            else {
                job.proc = spawn(cmd, args, {
                    cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
                });
            }
        }
        catch (e) {
            fail(job, `拉起失败：${e instanceof Error ? e.message : e}`);
            return;
        }
        job.pid = job.proc.pid ?? null;
        job.proc.stdin?.on("error", () => { }); // ★ CLI 提前退出时 stdin EPIPE 不能炸 dashboard
        pushLine(job, "sys", `[执行器] ${cmd} ${args.join(" ")} ｜ 工作区 ${cwd} ｜ PID ${job.pid ?? "?"}`);
        // 心跳：续卡租约 + 工作证租约（防治理回收误杀长任务；SQL 单点在 db.js renewCardLease）
        job.heartbeat = setInterval(() => {
            try {
                renewCardLease(db, job.cardId, job.dispatchId);
            }
            catch { /* 心跳失败不中断执行 */ }
        }, HEARTBEAT_MS);
        // 超时杀树
        job.timer = setTimeout(() => {
            if (job.status === "running") {
                pushLine(job, "sys", "[执行器] 超时，自动终止进程树");
                killTree(job);
                finish(job, false, "执行超时被终止");
            }
        }, ov?.timeoutMinutes ? ov.timeoutMinutes * 60000 : DEFAULT_TIMEOUT_MS);
        job.proc.stdout?.on("data", (d) => pushLine(job, "out", d.toString("utf8")));
        job.proc.stderr?.on("data", (d) => pushLine(job, "err", d.toString("utf8")));
        job.proc.on("error", (e) => { if (job.status === "running") fail(job, `进程错误：${e.message}`); });
        job.proc.on("close", (code) => {
            if (job.status !== "running")
                return; // 已被超时/手动收口
            pushLine(job, "sys", `[执行器] 进程退出 code=${code}`);
            finish(job, code === 0, code === 0 ? "CLI 执行完成" : `CLI 进程退出码 ${code}`);
        });
        // 提示词走 stdin（避免命令行长度/转义问题）
        if ((ov?.useStdin ?? preset?.useStdin ?? true) && job.proc.stdin) {
            job.proc.stdin.write(job.message + "\n");
            job.proc.stdin.end();
        }
        else {
            job.proc.stdin?.end();
        }
    }

    function killTree(job) {
        if (!job.pid || job.killed)
            return;
        job.killed = true;
        killTreePid(job.pid);
    }

    function fail(job, why) {
        pushLine(job, "sys", `[执行器] ${why}`);
        finish(job, false, why);
    }

    /** 收口：分隔符协议解析（D7）→ 兜底尾部；全量日志落盘；复用 finalizeCardDispatch 全套语义 */
    function finish(job, ok, detail) {
        if (job.status === "done" || job.status === "failed")
            return;
        job.status = ok ? "done" : "failed";
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
        clearInterval(job.heartbeat);
        killTree(job);
        const all = job.fullText ?? job.lines.map((l) => l.text).join("\n"); // 全量原文（不受 SSE 缓冲截断影响）
        // ★ 解析源必须是智能体真实输出（out/err），绝不能是 fullText：执行器注入的提示词本身
        //   就带着模板 `<<<HANDOFF>>> … <</HANDOFF>>>`，正则首战命中它 → answer 恒为字面量 "…"，
        //   智能体真正写的交接/结论被整段丢弃（交接卡【结论】永远是空壳，实测 2026-10-05）。
        const src = (job.agentText ?? "").trim() ? job.agentText : all;
        let answer = "";
        const m = src.match(/<<<HANDOFF>>>([\s\S]*?)(?:<<\/HANDOFF>>>|$)/);
        const cand = m?.[1]?.trim() ?? "";
        if (cand && cand !== "…")
            answer = cand.slice(0, 2400); // ★ P4 详版交接：上限放宽到 2400
        else {
            const tail = src.trim().slice(-1000);
            answer = tail || detail;
            pushLine(job, "sys", "[执行器] 未按约定输出交接段（<<<HANDOFF>>>），已用输出尾部兜底");
        }
        const logFile = path.join(logDir, `${job.runId}.log`);
        try {
            fs.writeFileSync(logFile, all, "utf8");
            pushLine(job, "sys", `[执行器] 全量日志：${logFile}`);
        }
        catch (e) { console.error("[cliexec] 全量日志落盘失败（不影响收口）", e); }
        try {
            ctx.finalizeCardDispatch?.({
                cardId: job.cardId, dispatchId: job.dispatchId, ok, runId: job.runId,
                // ★ actor 必须等于派发时写进 cards.assignee 的值：finalizeCardDispatch 以
                //   `assignee===actor || assignee 为空` 决定是否翻状态+三清锁；缺省回退
                //   "dispatch-agent" 会在 agent 名非缺省时静默跳过收口 → 卡永久 running。
                actor: job.agent || "dispatch-agent",
                answer, channel: "cli", durationMs: job.finishedAt - job.startedAt, logFile,
                detail: `${detail}（CLI 直控 ${job.cmd}）`,
            });
        }
        catch (e) {
            pushLine(job, "sys", `[执行器] 收口异常：${e instanceof Error ? e.message : e}`);
        }
        job.waiters?.forEach((w) => w());
        history.save(job);
        pruneFinishedJobs(jobs, 20);
        pump(job.profileId);
    }

    /** 启动时清理 14 天前的历史日志（防 cli-logs 无界吃磁盘） */
    function cleanOldLogs() {
        try {
            const cutoff = Date.now() - 14 * 86400000;
            for (const f of fs.readdirSync(logDir)) {
                if (!/^cli_[a-z0-9]+_[a-z0-9]+\.(?:log|run\.json(?:\.tmp)?|events\.jsonl)$/.test(f)) continue;
                const fp = path.join(logDir, f);
                if (fs.statSync(fp).mtimeMs < cutoff)
                    fs.rmSync(fp, { force: true });
            }
        }
        catch (e) { console.error("[cliexec] 历史日志清理失败（不影响启动）", e); }
    }
    cleanOldLogs();


    /** 派发入口（dispatch-agent 路由到本执行器）：入队并返回 runId */
    ctx.startCliRun = ({ cardId, agentCardId, profile, dispatchId, dispatchKey, taskId, message, agent }) => {
        const runId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            runId, cardId, agentCardId: agentCardId ?? null, profileId: profile.id, dispatchId: dispatchId ?? null, dispatchKey: dispatchKey ?? null,
            taskId: taskId ?? null, message, profile, status: "queued", lines: [], startedAt: null, finishedAt: null,
            createdAt: Date.now(),
            agent: agent || "dispatch-agent", // ★ 收口比对用：须与卡上 assignee 同源（见 finish 的 actor）
        };
        jobs.set(runId, job);
        history.save(job);
        if (!queues.has(profile.id))
            queues.set(profile.id, []);
        const q = queues.get(profile.id);
        q.concurrency = profile.concurrency;
        q.push(job);
        const queueAhead = q.indexOf(job); // 必须在 pump 前取（启动即出队会变 -1）
        pump(profile.id);
        return { runId, queued: job.status === "queued", queueAhead };
    };

    // 实时执行流（SSE）：先重放缓冲，再持续推送；done/failed 即关闭（骨架在 exec-util 单点）
    app.get("/api/agent-cards/:id/exec/stream", (req, reply) => {
        const cardId = Number(req.params.id);
        const runId = String(req.query.runId ?? "");
        const job = findJobByCard(jobs, cardId, { runId });
        if (!job) {
            const record = runId ? history.read(cardId, runId) : history.read(cardId, history.list(cardId)[0]?.runId);
            if (!record) return reply.code(404).send({ ok: false, error: "该卡没有执行记录" });
            reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            for (const line of record.lines)
                reply.raw.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
            reply.raw.end(`event: end\ndata: ${JSON.stringify({ status: record.status, runId: record.runId, historical: true, logMissing: record.logMissing, truncated: record.truncated })}\n\n`);
            return;
        }
        streamJobSSE(reply, job, { intervalMs: 1500, ping: true });
    });

    // 手动停止（杀树）
    app.post("/api/agent-cards/:id/exec/stop", async (req, reply) => {
        const cardId = Number(req.params.id);
        const job = findJobByCard(jobs, cardId, { runningOnly: true, runId: String(req.query.runId ?? "") });
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡当前没有执行中的任务" });
        pushLine(job, "sys", "[执行器] 用户手动停止");
        killTree(job);
        finish(job, false, "用户手动停止");
        return { ok: true, runId: job.runId };
    });

    // 执行记录（供卡片状态区取 PID/时长）
    app.get("/api/agent-cards/:id/exec", async (req, reply) => {
        const cardId = Number(req.params.id);
        const list = [...jobs.values()].filter((j) => j.cardId === cardId || j.agentCardId === cardId)
            .map((j) => ({ runId: j.runId, status: j.status, pid: j.pid, cmd: j.cmd, cwd: j.cwd,
                startedAt: j.startedAt, finishedAt: j.finishedAt, lines: j.lines.length }));
        const merged = new Map(history.list(cardId).map(r => [r.runId, { ...r, historical: true }]));
        for (const r of list) merged.set(r.runId, { ...merged.get(r.runId), ...r, historical: false });
        return { ok: true, runs: [...merged.values()].sort((a, b) =>
            (b.createdAt || b.startedAt || 0) - (a.createdAt || a.startedAt || 0)).slice(0, 100),
            history_error: history.error };
    });

    ctx.cliLogDir = logDir;
}
