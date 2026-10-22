import fs from "node:fs";
import path from "node:path";

const VALID_ID = /^cli_[a-z0-9]+_[a-z0-9]+$/;
const TERMINAL = new Set(["done", "failed", "interrupted"]);

// Only executor-owned metadata establishes a card/run association. Never trust a
// request path or infer an owner from a loose .log file.
export function createCliRunHistory(logDir) {
    const records = new Map();
    let error = null;
    const report = (e) => {
        error = "执行记录存储不可用";
        console.error("[cliexec] 执行记录存储失败", e);
    };
    const file = (id, ext) => path.join(logDir, `${id}.${ext}`);
    const summary = (j) => ({
        runId: j.runId, cardId: j.cardId, agentCardId: j.agentCardId,
        status: j.status, startedAt: j.startedAt, createdAt: j.createdAt,
        finishedAt: j.finishedAt, lines: Array.isArray(j.lines) ? j.lines.length : Number(j.lines) || 0,
    });
    try {
        const cutoff = Date.now() - 14 * 86400000;
        for (const name of fs.readdirSync(logDir)) {
            if (!name.endsWith(".run.json")) continue;
            const id = name.slice(0, -9);
            if (!VALID_ID.test(id)) continue;
            try {
                const p = file(id, "run.json");
                if (fs.statSync(p).mtimeMs < cutoff) continue;
                const r = JSON.parse(fs.readFileSync(p, "utf8"));
                if (r.runId !== id || !Number.isSafeInteger(r.cardId) || r.cardId <= 0) continue;
                records.set(id, { ...summary(r), historical: true,
                    status: TERMINAL.has(r.status) ? r.status : "interrupted" });
            } catch (e) { report(e); }
        }
    } catch (e) { report(e); }
    return {
        save(job) {
            if (!VALID_ID.test(job.runId)) return;
            const r = summary(job);
            try {
                fs.writeFileSync(file(job.runId, "run.json.tmp"), JSON.stringify(r), "utf8");
                fs.renameSync(file(job.runId, "run.json.tmp"), file(job.runId, "run.json"));
                records.set(job.runId, r);
            } catch (e) { report(e); }
        },
        append(job, lines) {
            if (!VALID_ID.test(job.runId) || !lines.length) return;
            try {
                fs.appendFileSync(file(job.runId, "events.jsonl"),
                    lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");
            } catch (e) { report(e); }
        },
        list(cardId) {
            return [...records.values()].filter(r => r.cardId === cardId || r.agentCardId === cardId)
                .sort((a, b) => (b.createdAt || b.startedAt || 0) - (a.createdAt || a.startedAt || 0))
                .slice(0, 100);
        },
        read(cardId, runId) {
            const r = records.get(runId);
            if (!r || (r.cardId !== cardId && r.agentCardId !== cardId)) return null;
            let fd;
            try {
                fd = fs.openSync(file(runId, "events.jsonl"), "r");
                const size = fs.fstatSync(fd).size;
                const length = Math.min(size, 256 * 1024);
                const buf = Buffer.alloc(length);
                fs.readSync(fd, buf, 0, length, size - length);
                const rows = buf.toString("utf8").split("\n");
                if (size > length) rows.shift();
                const lines = rows.filter(Boolean).flatMap(s => {
                    try { return [JSON.parse(s)]; } catch { return []; }
                });
                return { ...r, lines, truncated: size > length };
            } catch (e) {
                if (e.code === "ENOENT") return { ...r, lines: [], logMissing: true };
                report(e);
                return { ...r, lines: [], logMissing: true };
            } finally { if (fd !== undefined) fs.closeSync(fd); }
        },
        get error() { return error; },
    };
}
