/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-exec-util.js — 节点画布执行器共享工具（2026-10-04，对抗性审查 C 类去重）
 * 只收 cliexec/cdpexec 之间逐行同构的骨架：杀树 / JSON 解析 / 任务修剪 / 找任务 / SSE 流。
 * 刻意不做的合并：两个执行器的 finish 流程差异实质存在（CLI 有协议解析+日志落盘，
 * CDP 有 neverDrove 杀 App）——塞进基类只会加间接层不减总逻辑，保持各自直写。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { execFile } from "node:child_process";

export function safeJson(s) {
    try {
        return JSON.parse(s ?? "null");
    }
    catch {
        return null;
    }
}

/** 解析档案 launch_overrides → 对象（无/非法则 null）。
 *  ★ 2026-10-05 批1：容忍「双重编码」存量 —— 值本身是一段被再包了一层的 JSON 字符串
 *  （实测档案 #8 = "{\"cmd\":…}"，#9-#12 正常），旧口径 parse 一次拿到的是**字符串**而非对象
 *  ⇒ ov.cmd / ov.exe 全 undefined ⇒ 静默回退裸预设 ⇒ 用户所见「派发后什么都没跑起来」。
 *  只多解一层；解出来仍不是对象就 null（不把标量当配置，也不改任何存量数据）。 */
export function overridesOf(p) {
    const raw = p?.launch_overrides;
    if (!raw)
        return null;
    let v = typeof raw === "string" ? safeJson(raw) : raw;
    if (typeof v === "string")
        v = safeJson(v);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** 杀整棵进程树（Windows taskkill /T；其余 SIGKILL）。收口以 close 事件为准，此处失败不抛。 */
export function killTree(pid) {
    if (!pid)
        return;
    try {
        if (process.platform === "win32")
            execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => { });
        else
            process.kill(pid, "SIGKILL");
    }
    catch { /* 进程可能已退出 */ }
}

/** 收口后的 job 修剪：终态只留最近 maxFinished 条（防 jobs Map / 帧缓冲常驻内存无界增长）。 */
export function pruneFinishedJobs(jobs, maxFinished = 20) {
    const finished = [...jobs.entries()].filter(([, j]) => j.status === "done" || j.status === "failed");
    if (finished.length > maxFinished)
        for (const [id] of finished.slice(0, finished.length - maxFinished))
            jobs.delete(id);
}

/** 按卡片找任务（任务卡与智能体卡都能命中）；runningOnly 时只返回执行中的。 */
export function findJobByCard(jobs, cardId, { runningOnly = false, runId = "" } = {}) {
    return [...jobs.values()].reverse().find((j) => (j.cardId === cardId || j.agentCardId === cardId)
        && (!runningOnly || j.status === "running" || j.status === "launching" || j.status === "driving")
        && (!runId || j.runId === runId));
}

/** SSE 任务流：重放 lines → 持续推送 → end 关闭。extraFlush 供 CDP 推帧等差量。 */
export function streamJobSSE(reply, job, { intervalMs = 1500, ping = false, extraFlush } = {}) {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let sent = 0;
    // ★ 收口后再写会抛 ERR_STREAM_WRITE_AFTER_END，且它是 ServerResponse 的 'error' 事件、
    //   无人监听 → 整个 dashboard 进程被未捕获异常打死（实测 2026-10-05：一次 CLI run 收口即崩，
    //   日志 stack 落在 cliexec finish 的 waiters.forEach）。故 write 必须自防护。
    const write = (event, data) => {
        if (reply.raw.writableEnded || reply.raw.destroyed)
            return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const flush = () => {
        while (sent < job.lines.length)
            write("line", job.lines[sent++]);
        extraFlush?.(write);
        if (job.status === "done" || job.status === "failed") {
            write("end", { status: job.status, runId: job.runId });
            cleanup();
        }
    };
    const interval = setInterval(() => {
        flush();
        if (ping && !reply.raw.writableEnded && !reply.raw.destroyed)
            reply.raw.write(": ping\n\n");
    }, intervalMs);
    const cleanup = () => {
        clearInterval(interval);
        // ★ 必须把自己从 waiters 摘掉：cleanup 只 end 了响应，此时 socket 的 'close' 还没来得及触发
        //   （摘除逻辑在 close 里），finish 随后的 waiters.forEach 会再次 flush → write after end → 崩。
        job.waiters = (job.waiters ?? []).filter((w) => w !== flush);
        reply.raw.end();
    };
    job.waiters = job.waiters ?? [];
    job.waiters.push(flush);
    reply.raw.on("close", () => {
        clearInterval(interval);
        job.waiters = (job.waiters ?? []).filter((w) => w !== flush);
    });
    // ★ 客户端半途断开（页面刷新/rd.cancel）产生的写错误降级为安静关闭，绝不冒泡成进程崩溃
    reply.raw.on("error", () => {
        clearInterval(interval);
        job.waiters = (job.waiters ?? []).filter((w) => w !== flush);
    });
    flush();
}
