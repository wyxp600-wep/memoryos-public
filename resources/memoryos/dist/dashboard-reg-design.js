/** Orca 融合 P3 · design 域（2026-10-03 CLAIM §5 登记，A 分区）
 * 能力：Design Mode —— 真实 Chromium 元素拾取（对标 Orca README L77-81：
 *       「Click any UI element in a real Chromium window to send its HTML, CSS,
 *        and a cropped screenshot straight into your agent's prompt」）。
 * 链路：POST /api/design/open 起 Chrome（随机调试端口 + 临时 profile）
 *       → CDP 注入拾取器（Runtime.addBinding + addScriptToEvaluateOnNewDocument）
 *       → 用户在 Chrome 窗口 hover 高亮 / 点选 → window.memoryosPick(JSON) 回传
 *       → Runtime.bindingCalled 收包 + Page.captureScreenshot 裁剪截图
 *       → 前端轮询 GET /api/design/picks → 一键附进 Agent prompt（P0 附件管线）。
 * 零新 npm 依赖：CDP 走 Node 原生 fetch + WebSocket（走查门禁 outputs/workbench-ui-walk.mjs:92 同款先例）。
 * 安全口径：
 *   - 调试端口 --remote-debugging-port=0（读 DevToolsActivePort 文件取随机端口，避开端口竞写），
 *     仅连 127.0.0.1；独立临时 user-data-dir；close / Chrome 自退 / 异常一律 killTree + 清临时目录；
 *   - URL 协议白名单 http/https/file（javascript:/data: 等 400）；
 *   - 拾取结果限速（≥200ms/次）+ 只留最近 10 条（防页面刷 bindingCalled 打爆截图）；
 *   - logExecAudit（approval=human-ui，同准终端口径）；RESTRICTED → 403。
 * 会话模型：全局单会话（一次一个 Chrome 窗口）；重复 open → 409，close 幂等。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestArgs } from "./exec-tools.js";
import { logExecAudit } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PICKS_KEEP = 10;          // 每会话保留的拾取结果条数（FIFO）
const PICK_GAP_MS = 200;        // 拾取限速（页面可任意刷 bindingCalled）
const SHOT_MAX_PX = 4_000_000;  // 截图 clip 面积上限（2000×2000 量级，防超大页爆内存）
const HTML_CAP = 32768;         // 单条拾取 outerHTML 字符上限
const CDP_TIMEOUT = 15000;      // 单条 CDP 命令超时

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 杀整棵进程树（与 exec-tools.js / dashboard-reg-term.js 同模式：Windows taskkill /T /F，POSIE 进程组） */
function killTree(child) {
    try {
        if (process.platform === "win32") {
            if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref?.();
        }
        else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
    }
    catch { /* 已退出 */ }
}

/** Chrome 可执行定位：CHROME_BIN 优先（与 4 个走查门禁同口径），其次常见安装位 + Edge 兜底（同为 Chromium/CDP） */
function findBrowser() {
    const cands = [
        process.env.CHROME_BIN,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ].filter(Boolean);
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 忽略不可读候选 */ } }
    return null;
}

/** URL 协议白名单：http/https/file（与 Orca 浏览器场景对齐；javascript:/data: 一律拒） */
function validateUrl(raw) {
    let u;
    try { u = new URL(String(raw ?? "").trim()); }
    catch { return { status: 400, error: "URL 无法解析（请带 http:// https:// 或 file:/// 前缀）" }; }
    if (!["http:", "https:", "file:"].includes(u.protocol))
        return { status: 400, error: `不支持的协议 ${u.protocol}（仅 http/https/file）` };
    if (u.protocol === "file:" && !/^file:\/\/\//.test(u.href))
        return { status: 400, error: "file URL 格式不合法（例：file:///C:/path/page.html）" };
    return { url: u.href };
}

/** 等 DevToolsActivePort 文件给出随机调试端口（--remote-debugging-port=0 的约定产物） */
async function waitDevtoolsPort(tmpDir, timeoutMs = 8000) {
    const f = path.join(tmpDir, "DevToolsActivePort");
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const p = parseInt(String(fs.readFileSync(f, "utf8")).split(/\r?\n/)[0], 10);
            if (Number.isFinite(p) && p > 0) return p;
        } catch { /* 未写入 */ }
        await sleep(120);
    }
    return null;
}

/** 极简 CDP 客户端（id 应答配对 + method 广播；Node 原生 WebSocket，零依赖） */
function cdpConnect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const pending = new Map();
        const listeners = new Set();
        let seq = 0;
        const timer = setTimeout(() => { try { ws.close(); } catch { /* 已关 */ } reject(new Error("CDP WebSocket 连接超时")); }, CDP_TIMEOUT);
        ws.addEventListener("open", () => {
            clearTimeout(timer);
            resolve({
                send(method, params = {}) {
                    return new Promise((res, rej) => {
                        const id = ++seq;
                        const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} 超时`)); }, CDP_TIMEOUT);
                        pending.set(id, { res, rej, t });
                        ws.send(JSON.stringify({ id, method, params }));
                    });
                },
                on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
                close() { try { ws.close(); } catch { /* 已关 */ } },
            });
        });
        ws.addEventListener("message", (ev) => {
            let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
            if (m.id && pending.has(m.id)) {
                const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
                if (m.error) p.rej(new Error(m.error.message || "CDP 错误")); else p.res(m.result || {});
            }
            else if (m.method) for (const fn of listeners) { try { fn(m); } catch { /* 监听器异常不阻断 */ } }
        });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); });
        ws.addEventListener("close", () => {
            for (const [, p] of pending) { clearTimeout(p.t); p.rej(new Error("CDP 连接已关闭")); }
            pending.clear();
        });
    });
}

/** 拾取器：注入每个文档（addScriptToEvaluateOnNewDocument）。
 *  hover → 高亮框（pointer-events:none，不挡点击）；click → 收集 HTML/计算样式/CSS 路径/页坐标 → memoryosPick。 */
const PICKER_SOURCE = String.raw`
(() => {
  if (window.__memoryosPickOn) return; window.__memoryosPickOn = true;
  const send = (o) => { try { window.memoryosPick(JSON.stringify(o)); } catch (e) { /* 绑定缺失 */ } };
  const PROPS = ["display","position","top","left","right","bottom","width","height","margin","padding","gap",
    "border","border-radius","background","background-color","color","font-family","font-size","font-weight",
    "line-height","text-align","text-decoration","box-shadow","z-index","flex-direction","align-items",
    "justify-content","overflow","opacity","transition"];
  const cssPath = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + "#" + CSS.escape(n.id)); break; }
      if (n.classList && n.classList.length) s += "." + [...n.classList].slice(0, 2).map(CSS.escape).join(".");
      const p = n.parentElement;
      if (p) { const sib = [...p.children].filter(c => c.tagName === n.tagName); if (sib.length > 1) s += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")"; }
      parts.unshift(s); n = p;
    }
    return parts.join(" > ");
  };
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;outline:2px dashed #08c;" +
    "background:rgba(8,136,204,0.12);border-radius:2px;transition:all .06s linear;display:none";
  const tag = document.createElement("div");
  tag.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#08c;color:#fff;" +
    "font:11px/1.5 Consolas,monospace;padding:2px 6px;border-radius:3px;display:none;max-width:60vw;overflow:hidden";
  const show = (el) => {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
    tag.style.display = "block";
    tag.style.left = Math.max(0, r.left) + "px"; tag.style.top = Math.max(0, r.top - 20) + "px";
    tag.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
      (el.classList && el.classList.length ? "." + [...el.classList][0] : "") + " · " + Math.round(r.width) + "×" + Math.round(r.height);
  };
  const mount = () => { if (!document.documentElement) return false; document.documentElement.appendChild(box); document.documentElement.appendChild(tag); return true; };
  if (!mount()) document.addEventListener("DOMContentLoaded", mount, { once: true });
  document.addEventListener("mouseover", (e) => { if (e.target && e.target.nodeType === 1) show(e.target); }, true);
  document.addEventListener("mouseleave", () => { box.style.display = "none"; tag.style.display = "none"; }, true);
  document.addEventListener("click", (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect();
    let styles = {};
    try {
      const cs = getComputedStyle(el);
      for (const p of PROPS) { const v = cs.getPropertyValue(p); if (v) styles[p] = v; }
    } catch (err) { /* 跨域/怪异元素 */ }
    send({
      html: (el.outerHTML || "").slice(0, 32768),
      selector: cssPath(el),
      styles,
      rect: { x: r.left + (window.scrollX || 0), y: r.top + (window.scrollY || 0), w: r.width, h: r.height },
      pageUrl: location.href,
      title: document.title || "",
      ts: Date.now(),
    });
  }, true);
})();
`;

export function registerDesign(app, ctx) {
    const { db, RESTRICTED } = ctx;
    /** 全局单会话：{child, client, port, tmpDir, url, picks, lastCap, closed} */
    let S = null;

    const audit = (r) => { try { logExecAudit(db, { agent: "dashboard:design", ...r }); } catch { /* 审计失败不阻断 */ } };

    /** 清临时 profile（Chrome 退出后文件句柄有延迟，重试 6 次） */
    async function rmProfile(dir) {
        for (let i = 0; i < 6; i++) {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); return; }
            catch (e) { console.error(`[design] 清临时 profile 失败（重试 ${i + 1}/6）：`, e?.message ?? e); await sleep(150); }
        }
    }

    /** 关会话（幂等）：关 CDP → 杀进程树 → 清 profile */
    async function closeSession(reason) {
        const s = S;
        if (!s) return false;
        S = null;
        s.closed = true;
        try { s.client?.close(); } catch { /* 已关 */ }
        killTree(s.child);
        s.child?.kill?.();
        await rmProfile(s.tmpDir);
        audit({ tool: "design_close", risk: "L1", approval: "human-ui", argsDigest: digestArgs({ cmd: ["chrome-design"] }), detail: `关闭设计会话（${reason}）` });
        return true;
    }

    // Chrome 自退（用户手关窗口）→ 同步清状态，前端轮询即见 active:false
    const attachExit = (s) => {
        s.child.on("exit", () => {
            if (S !== s) return;
            S = null;
            try { s.client?.close(); } catch { /* 已关 */ }
            void rmProfile(s.tmpDir);
        });
    };

    // ── POST /api/design/open {url}：起 Chrome + CDP 拾取器（单会话，重复 → 409） ──
    app.post("/api/design/open", async (req, reply) => {
        if (RESTRICTED) return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        if (S) return reply.code(409).send({ ok: false, error: "已有设计会话，请先关闭（POST /api/design/close）", url: S.url });
        const uv = validateUrl(req.body?.url);
        if (uv.status) return reply.code(uv.status).send({ ok: false, error: uv.error });
        const exe = findBrowser();
        if (!exe) return reply.code(503).send({ ok: false, error: "未找到 Chrome/Edge，请设置环境变量 CHROME_BIN 指向浏览器可执行文件" });

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-design-"));
        const args = [
            "--remote-debugging-port=0", `--user-data-dir=${tmpDir}`,
            "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-translate",
            "--window-size=1366,900", "about:blank",
        ];
        audit({ tool: "design_open", risk: "L1", approval: "human-ui", argsDigest: digestArgs({ cmd: ["chrome-design", uv.url] }), detail: `起设计会话 ${uv.url}` });
        const child = spawn(exe, args, { stdio: "ignore", shell: false, detached: process.platform !== "win32" });
        const s = { child, client: null, port: 0, tmpDir, url: uv.url, picks: [], lastCap: 0, closed: false };
        S = s;
        attachExit(s);

        try {
            s.port = await waitDevtoolsPort(tmpDir);
            if (!s.port) throw new Error("DevToolsActivePort 未生成（Chrome 启动失败？）");
            let list = null;
            for (let i = 0; i < 10 && !list; i++) {
                // 超时必须显式：裸 fetch 遇半开连接可挂约 300s（进程被杀树强停时 finally 不跑、残留即由此而来）
                try { list = await (await fetch(`http://127.0.0.1:${s.port}/json/list`, { signal: AbortSignal.timeout(3000) })).json(); } catch { await sleep(200); }
            }
            const page = Array.isArray(list) ? list.find((t) => t.type === "page") : null;
            if (!page?.webSocketDebuggerUrl) throw new Error("无可用 page target（/json/list 无 page）");
            const client = await cdpConnect(page.webSocketDebuggerUrl);
            s.client = client;
            client.on((m) => {
                if (m.method === "Runtime.bindingCalled" && m.params?.name === "memoryosPick")
                    void onPick(s, String(m.params.payload ?? ""));
            });
            await client.send("Page.enable");
            await client.send("Runtime.enable");
            await client.send("Runtime.addBinding", { name: "memoryosPick" });
            await client.send("Page.addScriptToEvaluateOnNewDocument", { source: PICKER_SOURCE });
            await client.send("Page.navigate", { url: uv.url });
            return { ok: true, port: s.port, url: uv.url };
        }
        catch (e) {
            await closeSession(`open 失败：${e.message}`);
            return reply.code(500).send({ ok: false, error: `设计会话启动失败：${e.message}` });
        }
    });

    /** 拾取回调：限速 → 裁剪截图（失败不阻断）→ FIFO 留 10 条 */
    async function onPick(s, raw) {
        if (S !== s || s.closed) return;
        let p; try { p = JSON.parse(raw); } catch { return; }
        if (!p || typeof p.html !== "string" || !p.html) return;
        const now = Date.now();
        if (now - s.lastCap < PICK_GAP_MS) return;   // 限速：页面刷拾取不给打爆截图
        s.lastCap = now;
        let shot = null;
        try {
            const r = p.rect || {};
            const w = Number(r.w) || 0, h = Number(r.h) || 0;
            if (w > 0 && h > 0 && w * h <= SHOT_MAX_PX) {
                const res = await s.client.send("Page.captureScreenshot", {
                    format: "jpeg", quality: 70, captureBeyondViewport: true,
                    clip: { x: Number(r.x) || 0, y: Number(r.y) || 0, width: w, height: h, scale: 1 },
                });
                if (res?.data) shot = "data:image/jpeg;base64," + res.data;
            }
        } catch { shot = null; /* 截图失败保底：只丢图不丢拾取 */ }
        s.picks.push({
            id: randomUUID().slice(0, 8),
            html: p.html.slice(0, HTML_CAP),
            selector: String(p.selector || "").slice(0, 500),
            styles: p.styles && typeof p.styles === "object" ? p.styles : {},
            pageUrl: String(p.pageUrl || s.url).slice(0, 2000),
            title: String(p.title || "").slice(0, 300),
            shot,
            ts: now,
        });
        while (s.picks.length > PICKS_KEEP) s.picks.shift();
    }

    // ── POST /api/design/navigate {url}：会话内换页（拾取器随 addScriptToEvaluateOnNewDocument 自动重注） ──
    app.post("/api/design/navigate", async (req, reply) => {
        if (RESTRICTED) return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        if (!S) return reply.code(404).send({ ok: false, error: "无进行中的设计会话" });
        const uv = validateUrl(req.body?.url);
        if (uv.status) return reply.code(uv.status).send({ ok: false, error: uv.error });
        try {
            await S.client.send("Page.navigate", { url: uv.url });
            S.url = uv.url;
            return { ok: true, url: uv.url };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: `导航失败：${e.message}` });
        }
    });

    // ── GET /api/design/status：会话状态（快照 env-drift：会话/端口随运行态变化） ──
    app.get("/api/design/status", async () => {
        if (!S) return { ok: true, active: false, url: null, port: 0, picks: 0 };
        return { ok: true, active: true, url: S.url, port: S.port, picks: S.picks.length };
    });

    // ── GET /api/design/picks：拾取结果 FIFO（含裁剪截图 dataURL；env-drift 同上） ──
    app.get("/api/design/picks", async () => ({ ok: true, picks: S ? S.picks : [] }));

    // ── POST /api/design/close：杀进程树 + 清 profile（幂等，无会话也 200） ──
    app.post("/api/design/close", async (req, reply) => {
        if (RESTRICTED) return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const had = await closeSession("手动关闭");
        return { ok: true, closed: had };
    });

    // 服务退出兜底：尽力杀 Chrome（Windows 下 killTree 的 taskkill 不保证在 exit 钩子里跑完，故补直接 kill）
    process.once("exit", () => { if (S) { try { S.child?.kill?.(); } catch { /* 已退出 */ } } });
    if (typeof ctx.onShutdown === "function") ctx.onShutdown(() => closeSession("服务退出"));
}
