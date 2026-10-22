/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-reg-cdpexec.js — 节点画布 P3：CDP 驾驶执行器（2026-10-04）
 * 能力：channel='cdp' 的智能体卡派发 → 带参拉起桌面智能体（工作区目录 +
 *       --remote-debugging-port 独占端口）→ CDP 连入 renderer：
 *       ① screencast 帧流经 SSE 回填卡片"直播"画面；② 尽力把任务文本注入聊天输入框并
 *       回车（选择器可经 launch_overrides.chatSelector 配置）；
 *       ③ launch_overrides.openChat 配置了开面板按键 → 先探到面板没开才按（VS Code
 *          Ctrl+Alt+I 是 toggle，盲按会把已开的面板关掉）；
 *       ④ launch_overrides.injectVia:"cdp" → CDP 可信输入（Input.insertText 打字+回车），
 *          用于没有 textarea 的应用（VS Code 聊天输入是 native-edit-context，DOM 赋值无效）；
 *       ⑤ launch_overrides.trustWorkspace:true → 自动点"信任文件夹并继续"（改变用户安全
 *          状态，必须显式 opt-in）；登录类前置（OAuth 引导）不自动化——探测到就降档并给
 *          明确原因，不假装成功。
 * 纪律（设计报告 §5.3 / D8/D10）：
 *  - CDP 唯一主路径；注入失败不重试不 UIA 死磕，降档为"请手动粘贴任务文本"；
 *  - 结果回收不走界面：App 内智能体经 MemoryOS MCP task_done 回写，或用户手动收口；
 *  - 停止 = 断开驾驶连接（不杀用户的 App）；超时上限防漏关；
 *  - 收口复用 finalizeCardDispatch（结算/翻边/交接卡语义不变）。
 * 依赖：Node ≥22 内置 WebSocket 全局（runtime v24 实测可用），零新依赖。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { renewCardLease } from "./db.js";
import { killTree, overridesOf, pruneFinishedJobs, findJobByCard, streamJobSSE } from "./dashboard-exec-util.js";

const HEARTBEAT_MS = 60000;
const CDP_WAIT_DEFAULT_MS = 30000;
const DEFAULT_MAX_MS = 2 * 60 * 60000; // 驾驶会话上限 2 小时（App 不会自己退出）
const PORT_BASE = 9300;

export function registerCdpExec(app, ctx) {
    const { db } = ctx;
    let jobs = new Map();
    let portCursor = 0;
    // scanAgents 是 spawnSync 秒级同步扫描，绝不能在派发热路径裸调（会卡住所有 SSE/HTTP）——60s TTL 缓存
    let _scanCache = { list: null, at: 0 };
    async function scanAgentsCached() {
        const now = Date.now();
        if (_scanCache.list && now - _scanCache.at < 60000)
            return _scanCache.list;
        try {
            const { scanAgents } = await import("./scan.js");
            _scanCache = { list: scanAgents()?.agents ?? [], at: now };
        }
        catch {
            _scanCache = { list: null, at: now };
        }
        return _scanCache.list;
    }

    function pushLine(job, stream, text) {
        job.lines.push({ stream, text: String(text), at: Date.now() });
        if (job.lines.length > 500)
            job.lines.splice(0, job.lines.length - 400);
        job.waiters?.forEach((w) => w());
    }

    function pollHttp(url, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve) => {
            const tick = async () => {
                try {
                    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
                    if (r.ok) {
                        const list = await r.json();
                        if (Array.isArray(list) && list.length)
                            return resolve(list);
                    }
                }
                catch { /* 未就绪继续等 */ }
                if (Date.now() > deadline)
                    return resolve(null);
                setTimeout(tick, 500);
            };
            tick();
        });
    }

    /* ═══ 单实例应用的调试口：复用 + 诊断（2026-10-05 B 方案，根治「端口 25s 未就绪」误导报错）═══
     * VS Code / Chrome 类应用是单实例：第二个进程会把 --remote-debugging-port 交给已有实例后
     * 直接退出，参数只对「第一个实例」生效 → 已有实例没开调试口时，等多久端口都不会就绪，
     * 而旧文案「应用可能不支持 --remote-debugging-port 或启动过慢」是误导（实测取证：已有
     * Code.exe PID 23500 @14:10:18 不带该参数、9329 无监听、DevToolsActivePort 内容 9329 无监听）。 */

    /** 该应用的 DevToolsActivePort 文件（--user-data-dir 覆盖优先，否则按 exe 名取平台默认） */
    function devToolsPortFile(exePath, args) {
        let udd = null;
        for (const a of args ?? []) {
            const m = /^--user-data-dir=(.+)$/i.exec(String(a));
            if (m)
                udd = m[1];
        }
        const exe = String(exePath ?? "").split(/[\\/]/).pop().toLowerCase();
        if (!udd && exe === "code.exe" && process.env.APPDATA)
            udd = `${process.env.APPDATA}\\Code`;
        if (!udd && exe === "chrome.exe" && process.env.LOCALAPPDATA)
            udd = `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`;
        return udd ? `${udd}\\DevToolsActivePort` : null;
    }
    /** 读该文件首行端口号；无文件/读不了/非正整数 → null（视为「从未以调试口启动过」） */
    function readDevToolsPort(file) {
        if (!file || !existsSync(file))
            return null;
        try {
            const n = Number(String(readFileSync(file, "utf8")).split(/\r?\n/)[0]);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
        catch { /* 读失败 = 降档为无调试口，不阻断拉起 */ return null; }
    }
    /** 现存同名 exe 进程的 `pid|CommandLine`（异步 PowerShell；仅复用/失败诊断时调用，不在派发热路径）
     *  ★ 根治二版：进程名按真实 basename 匹配（保留空格，WQL 原生支持）——旧实现把
     *  "TRAE SOLO CN.exe" 清成 "TRAESOLOCN.exe" 永远查不到 → 诊断失效 → 自动接管被跳过。 */
    function listProcCmdLines(exePath) {
        return new Promise((resolve) => {
            const name = String(exePath ?? "").split(/[\\/]/).pop().replace(/'/g, "''");
            if (!name)
                return resolve("");
            let out = "";
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            try {
                const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`],
                { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
                ps.stdout.on("data", (d) => { out += String(d); });
                ps.on("error", () => done(""));
                ps.on("close", () => done(out));
                setTimeout(() => { try { ps.kill(); } catch { /* 已退出 */ } done(out); }, 4000); // 兜底：诊断不许挂住启动链
            }
            catch { done(""); }
        });
    }
    /** 目标页归属校验：DevToolsActivePort 是残留文件，端口可能已被别的应用占用（实测 ChatGPT.exe
     *  声明 `--inspect=9329` 与 VS Code 残留文件同号）——/json/list 通 ≠ 是这个应用，按 exe 核对目标特征 */
    function targetsOwnedBy(exe, targets) {
        const name = String(exe ?? "").split(/[\\/]/).pop().toLowerCase();
        if (name !== "code.exe") // 只对已有串口实证的 code.exe 收紧；其余维持原口径（chrome 默认页标题不稳，不猜）
            return true;
        const sig = /vscode|visual studio code/i;
        return (targets ?? []).some((t) => sig.test(String(t?.title ?? "")) || sig.test(String(t?.url ?? "")));
    }
    /** ① 复用：DevToolsActivePort 指向的端口必须实测 /json/list 通才算数（文件可能是上次残留），
     *  且目标页必须属于该 exe（防接错到占用同号端口的其它应用） */
    async function reuseExistingCdp(exe, args) {
        const port = readDevToolsPort(devToolsPortFile(exe, args));
        if (!port)
            return null;
        const targets = await pollHttp(`http://127.0.0.1:${port}/json/list`, 800);
        if (!targets)
            return null;
        if (!targetsOwnedBy(exe, targets))
            return null;
        return { port, targets };
    }
    /** ② 诊断：端口没等到时，区分「已有实例吞掉参数」（可行动）与「应用不支持/启动慢」（原文案） */
    async function diagnoseNoCdp(exe, excludePid) {
        const rows = (await listProcCmdLines(exe)).split(/\r?\n/).filter(Boolean)
            .filter((l) => Number(l.split("|")[0]) !== Number(excludePid));
        if (!rows.length)
            return null;
        const exeName = String(exe).split(/[\\/]/).pop();
        const pids = rows.map((l) => l.split("|")[0]).join(", ");
        return `${exeName} 已在运行但未开调试端口（PID ${pids}）——单实例应用会把 --remote-debugging-port`
            + ` 交给已有实例后直接退出，端口因此永远不会就绪。请先完全退出 ${exeName}（含托盘图标），再重新派发`;
    }


    /** 注入任务文本：chatSelector 找输入框 → 原生 setter 赋值 → input 事件 → 找发送按钮或回车
     *  ★ 根治批：选择器三级回退（textarea → [contenteditable] → input[type=text]），
     *  载体没配 chatSelector 的未知 Electron 应用也有机会注进去；contenteditable 走 textContent 赋值。 */
    const injectScript = (selector, sendSelector, text) => `
      (() => {
        const tryFill = (el) => {
          if (!el) return false;
          el.focus();
          if (el.isContentEditable) {
            el.textContent = ${JSON.stringify(text)};
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
            return true;
          }
          const set = Object.getOwnPropertyDescriptor(el.constructor.prototype ?? HTMLTextAreaElement.prototype, "value")?.set
            ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
          set.call(el, ${JSON.stringify(text)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        };
        const sels = [${JSON.stringify(selector)}, "textarea", '[contenteditable="true"]', "input[type=text]"].filter(Boolean);
        let ta = null;
        for (const s of sels) { ta = document.querySelector(s); if (ta) break; }
        if (!ta) return { ok: false, why: "未找到输入框（尝试过 " + sels.join(" / ") + "）" };
        if (!tryFill(ta)) return { ok: false, why: "输入框赋值失败" };
        const send = ${JSON.stringify(sendSelector)} ? document.querySelector(${JSON.stringify(sendSelector)}) : null;
        if (send) { send.click(); return { ok: true, how: "点击发送按钮" }; }
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        return { ok: true, how: "模拟回车" };
      })()`;

    /* ── 驾驶注入链（D10：链路有界——最多一次按键 + 一次打字，不重试死磕）────── */

    /** CDP 可信按键（rawKeyDown → char? → keyUp）：合成 DOM 事件骗不过应用快捷键 */
    async function cdpKey(job, k) {
        const base = { key: k.key, code: k.code || "", windowsVirtualKeyCode: k.keyCode || 0, nativeVirtualKeyCode: k.keyCode || 0, modifiers: k.modifiers || 0 };
        await cdpCall(job, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" }, 4000);
        if (k.text)
            await cdpCall(job, "Input.dispatchKeyEvent", { ...base, type: "char", text: k.text }, 4000);
        await cdpCall(job, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }, 4000);
    }

    /** CDP 可信点击（合成 element.click() 不触发应用内手势）。
     *  ★ 2026-10-05 批3：`mouseMoved` 从「4s 超时即 reject」降为 best-effort —— 窗口在后台/被遮挡时
     *  hover 最常卡住，而原实现一次 hover 失败就沿调用链抛穿到 `start()` 的外层 catch，
     *  整条注入链被一句「注入异常：Input.dispatchMouseEvent 超时」打死（实测复用路径即此），
     *  既绕过 D10 统一降档文案，也把本可以成功的点击/打字机会一起丢了。 */
    async function cdpClick(job, x, y) {
        try {
            await cdpCall(job, "Page.bringToFront", {}, 1500);
        }
        catch { /* 前置失败不致命（Electron 个别版本不支持该域方法） */ }
        try {
            await cdpCall(job, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, 1500);
        }
        catch (e) {
            pushLine(job, "sys", `[驾驶] hover 未响应（${e instanceof Error ? e.message : e}）——跳过，直接按下/抬起`);
        }
        await cdpCall(job, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, 4000);
        await cdpCall(job, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, 4000);
    }

    /** DOM 定焦兜底：只 focus，不改文本、不模拟点击（可信打字仍走 Input.insertText）。
     *  用于点击通道卡住（窗口后台/遮挡）时保住注入机会。 */
    async function domFocus(job, ov) {
        const expr = `(() => {
          const c = document.querySelector(${JSON.stringify(ov?.chatContainer ?? ".chat-input-container")});
          if (!c) return false;
          const t = c.querySelector('textarea, [contenteditable="true"], .monaco-editor') || c;
          t.focus();
          return document.activeElement === t || (c.contains && c.contains(document.activeElement));
        })()`;
        try {
            const res = await cdpCall(job, "Runtime.evaluate", { expression: expr, returnByValue: true }, 4000);
            return res?.result?.value === true;
        }
        catch { return false; }
    }

    /**
     * 界面探测：面板是否开 / 输入面文本 / 信任弹窗 / 登录引导 / 焦点是否在输入面。
     * 选择器可用 launch_overrides.chatContainer / chatText 覆盖（默认 VS Code 聊天面）。
     * ★ 2026-10-05 批3（实测「打字未落入输入面（探到 "task_done(memory_id=4636, conc"）」的真因）：
     *   原 `txt` 用 `document.querySelectorAll(chatText)` **全局**取 `.view-line`，而 `.view-line` 是
     *   Monaco 通用行类名 —— 聊天**历史消息里的代码块**同样是 Monaco，于是落字校验拿的是历史文本池，
     *   刚打进去的任务文本永远"找不到"。现改为**限定在 chatContainer 子树内**取，容器内无匹配才回退
     *   全局，并同时回传 scoped/textAny，让失败信息一次说清是"没打进去"还是"探测范围不对"。
     */
    async function probeUi(job, ov) {
        const expr = `(() => {
        const cs = ${JSON.stringify(ov?.chatContainer ?? ".chat-input-container")};
        const ts = ${JSON.stringify(ov?.chatText ?? ".chat-input-container .view-line")};
        const c = document.querySelector(cs);
        const inScope = c ? Array.from(c.querySelectorAll(ts)).map(e => e.innerText || "") : [];
        const anywhere = Array.from(document.querySelectorAll(ts)).map(e => e.innerText || "");
        const txt = (inScope.length ? inScope : anywhere).join("\\n");
        const dlg = Array.from(document.querySelectorAll(".monaco-dialog-box, [role=dialog]"));
        const trust = dlg.flatMap(d => Array.from(d.querySelectorAll("button, a, [role=button], .monaco-button")))
          .find(b => /^(信任文件夹并继续|Trust Folder and Continue)\\b/i.test((b.innerText || "").trim()));
        const signIn = dlg.some(d => /登录以使用|Sign in to use/i.test(d.innerText || ""));
        const dialog = dlg.length > 0
          ? (dlg.map(d => (d.innerText || "").replace(/\\n+/g, " | ").slice(0, 80))[0] || "")
          : "";
        const r = c ? c.getBoundingClientRect() : null;
        const ae = document.activeElement;
        // ★ 定焦判据必须是「可编辑元素」：容器内任意元素（提示条/发送钮/历史项）都算 focused 会造成假焦点，
        //   打字全部落空（2026-10-05 测③ 实证：focused 放行后 Ctrl+A/insertText 无一落面）
        const ed = ae && ae.closest && ae.closest(cs);
        const vr = c ? c.querySelector(".view-line, textarea, [contenteditable='true']") : null;
        const vrr = vr ? vr.getBoundingClientRect() : null;
        return JSON.stringify({
          // 80 字上限曾把「首行被滚动裁掉」的正常落字误判为未落字（2026-10-05 测② 截帧实证）——放宽到 2000
          panel: !!c, text: txt.slice(0, 2000), dialog,
          // 窗口最小化/隐藏：DOM 焦点仍在（hasFocus 可能为 true）但直播无帧、鼠标事件易超时
          hidden: document.visibilityState !== "visible",
          scoped: inScope.length > 0, textAny: anywhere.join("\\n").slice(0, 2000),
          trust: trust ? { x: Math.round(trust.getBoundingClientRect().x + trust.getBoundingClientRect().width / 2),
                           y: Math.round(trust.getBoundingClientRect().y + trust.getBoundingClientRect().height / 2) } : null,
          signIn,
          focused: !!ed,
          // ★ 判定对象是 activeElement 本身，ed(closest=容器) 只证明「焦点在容器内」——
          //   第一版补丁误判 ed（closest 返回的是容器 DIV，role 恒非 textbox）致结构性仍 false（10-06 02:45 实测）
          editable: !!(ed && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable
            // ★ 2026-10-06 CDP DOM 真值：VS Code 聊天输入框是 Monaco EditContext 模式，焦点在
            //   div.native-edit-context（role=textbox、tabindex=0）——非 textarea 也非 contenteditable，
            //   少了这条判据则结构性永远 false（02:01 重测②′③′ 定焦门误杀实锤）
            || ae.getAttribute("role") === "textbox")),
          box: r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null,
          editBox: vrr && vrr.width > 0 ? { x: Math.round(vrr.x + vrr.width / 2), y: Math.round(vrr.y + vrr.height / 2) } : null
        });
      })()`;
        try {
            const res = await cdpCall(job, "Runtime.evaluate", { expression: expr, returnByValue: true }, 6000);
            const v = res?.result?.value;
            return typeof v === "string" ? JSON.parse(v) : null;
        }
        catch {
            return null;
        }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** ⑤ 工作区信任弹窗（配置 trustWorkspace:true 才自动点——默认不改用户安全状态） */
    async function handleTrustDialog(job, ov) {
        if (!ov?.trustWorkspace)
            return false;
        const ui = await probeUi(job, ov);
        if (!ui?.trust)
            return false;
        pushLine(job, "sys", "[驾驶] 检测到工作区信任弹窗，按配置自动信任（launch_overrides.trustWorkspace=true）");
        await cdpClick(job, ui.trust.x, ui.trust.y);
        await sleep(1000);
        return true;
    }

    /** DOM 注入（原路径，行为不变）：返回 {ok, how|why} */
    async function domInject(job, ov, text) {
        try {
            const res = await cdpCall(job, "Runtime.evaluate", {
                expression: injectScript(ov?.chatSelector ?? "", ov?.sendSelector ?? "", text),
                returnByValue: true,
            }, 8000);
            const v = res?.result?.value;
            return v?.ok ? { ok: true, how: v.how } : { ok: false, why: v?.why ?? "未知原因" };
        }
        catch (e) {
            return { ok: false, why: `异常：${e.message}` };
        }
    }

    /**
     * 等应用界面就绪（可选）：launch_overrides.readySelector 命中才开始注入。
     * 拉起后 CDP 秒连 ≠ 工作台就绪——VS Code 实测连上后 1.25s 按快捷键无反应，
     * 必须等聊天等贡献加载完（默认等 15s，每 700ms 探一次，有界不算死磕）。
     */
    async function waitForReady(job, ov) {
        const sel = ov?.readySelector;
        if (!sel)
            return { ok: true, waited: 0 };
        const timeoutMs = ov?.readyTimeoutMs ?? 15000;
        const deadline = Date.now() + timeoutMs;
        const started = Date.now();
        while (Date.now() < deadline) {
            try {
                const res = await cdpCall(job, "Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(sel)})`, returnByValue: true }, 4000);
                if (res?.result?.value === true)
                    return { ok: true, waited: Date.now() - started };
            }
            catch { /* 界面还没起来，继续等 */ }
            await sleep(700);
        }
        return { ok: false, waited: Date.now() - started };
    }

    /**
     * CDP 打字注入（injectVia:"cdp"）：
     *  就绪等待 → 有界状态机（信任弹窗→点击 / 登录引导→降档 / 面板没开→按 openChat，最多按 openChat.attempts 次）
     *  → 定焦点 → 清空 → Input.insertText → 落字校验 →（send!==false）回车。
     * 每步失败立即降档返回原因，不循环重试（D10）。
     */
    async function cdpTypeInjectInner(job, ov, text) {
        const head = text.trim().replace(/\s+/g, "").slice(0, 6);
        // ① 等界面就绪（没配 readySelector 就直接开始）
        const ready = await waitForReady(job, ov);
        if (!ready.ok)
            return { ok: false, why: `应用界面未就绪（等 ${Math.round(ready.waited / 1000)}s 未见 readySelector ${ov.readySelector}）` };
        if (ready.waited > 1000)
            pushLine(job, "sys", `[驾驶] 界面就绪（等待 ${Math.round(ready.waited / 1000)}s）`);
        // ② 有界状态机：处理弹窗与面板开关（最多 6 步，按键最多 attempts 次）
        const maxPress = ov?.openChat ? (ov.openChat.attempts ?? 2) : 0;
        let pressed = 0;
        let escPressed = 0;
        let ui = null;
        for (let step = 0; step < 10; step++) {
            ui = await probeUi(job, ov);
            if (!ui)
                return { ok: false, why: "界面探测失败（CDP 未返回值）" };
            if (ui.trust && ov?.trustWorkspace) {
                pushLine(job, "sys", "[驾驶] 检测到工作区信任弹窗，按配置自动点击（launch_overrides.trustWorkspace=true）");
                await cdpClick(job, ui.trust.x, ui.trust.y);
                await sleep(1000);
                continue;
            }
            if (ui.signIn)
                return { ok: false, why: "应用要求先登录（登录引导对话框挡住输入）——请在窗口里完成一次性登录后重新派发" };
            // 未知模态（Git 仓库确认、更新提示等）→ Esc 关掉再探（有界 2 次；信任/登录对话框在此分支之前已分流）
            if (ui.dialog && escPressed < 2) {
                escPressed++;
                pushLine(job, "sys", `[驾驶] 界面有对话框挡路，按 Esc 关闭（第 ${escPressed}/2 次）：${String(ui.dialog).slice(0, 60)}`);
                await cdpKey(job, { key: "Escape", code: "Escape", keyCode: 27 });
                await sleep(600);
                continue;
            }
            if (ui.panel)
                break;
            if (ov?.openChat && pressed < maxPress) {
                pressed++;
                pushLine(job, "sys", `[驾驶] 会话面板未开，按 openChat（第 ${pressed}/${maxPress} 次）`);
                await cdpKey(job, ov.openChat);
                await sleep(ov.openChat.waitMs ?? 1200);
                continue;
            }
            break; // 面板没开、也没有可按的了
        }
        if (!ui?.panel) {
            const dialogHint = ui?.dialog ? `；有对话框未能关闭：${String(ui.dialog).slice(0, 60)}` : "";
            return { ok: false, why: `未找到会话输入面（选择器 ${ov?.chatContainer ?? ".chat-input-container"}${ov?.openChat ? `，openChat 已按 ${pressed} 次仍未出现` : "，且未配置 openChat"}${dialogHint}）` };
        }
        // 窗口最小化/隐藏：DOM 焦点与打字仍可能成功，但画面直播无帧、鼠标事件易超时——给一次可行动提示
        if (ui.hidden && !job._hiddenWarned) {
            job._hiddenWarned = true;
            pushLine(job, "sys", "[驾驶] 提醒：应用窗口处于最小化/隐藏——画面直播将无帧、鼠标点击易超时；可从任务栏恢复窗口以获得直播画面（不影响打字注入继续执行）");
        }
        if (ui.signIn)
            return { ok: false, why: "应用要求先登录（登录引导对话框挡住输入）——请完成登录后重新派发" };
        // ② 定焦点：门 =「可编辑元素持有焦点」。只看 focused（在容器内）会把提示条/按钮的假焦点当成功，
        //    打字全部落空（2026-10-05 测③ 实证）；点击目标优先 editBox（文本区），容器中心可能落在提示条上
        if (!ui?.editable) {
            const tgt = ui?.editBox ?? ui?.box;
            if (!tgt)
                return { ok: false, why: "会话输入面不可见（宽高为 0）" };
            try {
                await cdpClick(job, tgt.x, tgt.y);
            }
            catch (e) {
                pushLine(job, "sys", `[驾驶] 点击输入面失败（${e instanceof Error ? e.message : e}）——改走 DOM 定焦继续`);
            }
            await sleep(400);
            ui = await probeUi(job, ov);
        }
        if (!ui?.editable) {
            if (!await domFocus(job, ov))
                return { ok: false, why: "输入面未获得编辑焦点（点击后 activeElement 非 textarea/contenteditable，且 DOM 定焦不可用）——请把该应用窗口切到前台后重新派发" };
            ui = await probeUi(job, ov);
            if (!ui?.editable)
                return { ok: false, why: "输入面未获得编辑焦点（DOM 定焦后 activeElement 仍非可编辑元素）——请把该应用窗口切到前台后重新派发" };
        }
        // ③ 清空 → 打字 → 落字校验（不清空会把旧文本拼在前面）
        const seenBefore = String(ui?.text ?? "").replace(/\s+/g, "");
        await cdpKey(job, { key: "A", code: "KeyA", keyCode: 65, modifiers: 2 });
        await sleep(150);
        await cdpKey(job, { key: "Backspace", code: "Backspace", keyCode: 8 });
        await sleep(150);
        await cdpCall(job, "Input.insertText", { text }, 8000);
        await sleep(500);
        ui = await probeUi(job, ov);
        const seen = String(ui?.text ?? "").replace(/\s+/g, "");
        // 多锚点 + 旧文本未变检测（2026-10-05 两测实证的两类假阴性）：
        //  · head 是首行，长文本在输入框里首行常被滚动裁掉（测② 截帧：框内全文在、head 恒不在可见区）
        //  · 光标停在尾部 → tail 必可见；「标题：」行带本卡卡名，是唯一锚
        //  · 文本与打字前逐字相同且标题锚未命中 = 打字根本没生效（测③ 实证：框里还是上一测的残留）
        const tail = text.trim().replace(/\s+/g, "").slice(-6);
        const tm = /标题：\s*(.+)/.exec(text);
        const titleAnchor = tm ? `标题：${tm[1].trim().slice(0, 12)}`.replace(/\s+/g, "") : "";
        const hitHead = !!head && seen.includes(head);
        const hitTail = !!tail && seen.includes(tail);
        const hitTitle = !!titleAnchor && seen.includes(titleAnchor);
        const unchanged = !!seen && seen === seenBefore;
        if (!((hitHead || hitTail || hitTitle) && !(unchanged && !hitTitle))) {
            // 失败信息带「探测范围 + 锚点命中情况」，下次一眼分清：没打进去 / 读错容器 / 校验锚被裁
            const scopeNote = ui?.panel
                ? (ui.scoped ? `容器内探到 ${JSON.stringify(String(ui.text ?? "").slice(0, 30))}`
                    : `容器内无 ${ov?.chatText ?? ".chat-input-container .view-line"} 匹配、已回退全局探到 ${JSON.stringify(String(ui.textAny ?? "").slice(0, 30))}（选择器需按该应用界面校准）`)
                : "会话输入面已消失";
            const why = unchanged && !hitTitle
                ? `打字未改变输入面（文本与打字前逐字相同，仍为 ${JSON.stringify(seen.slice(0, 30))}）`
                : "打字未落入输入面";
            return { ok: false, why: `${why}（${scopeNote}；锚点 head=${hitHead} tail=${hitTail} title=${hitTitle} unchanged=${unchanged}）` };
        }
        // ④ 回车发送（send:false 可关）
        if (ov?.send === false)
            return { ok: true, how: "CDP 打字（未发送）" };
        await cdpKey(job, { key: "Enter", code: "Enter", keyCode: 13 });
        // ★ 发送后才弹的登录引导（VS Code 在 submit 时触发）：实测比回车慢 >700ms，
        //   所以有界轮询 3×900ms 抓它——文本进去了但 AI 不会应答，必须按失败如实报
        ui = null;
        for (let i = 0; i < 3; i++) {
            await sleep(900);
            ui = await probeUi(job, ov);
            if (ui?.signIn)
                return { ok: false, why: "文本已提交，但应用要求先登录（Copilot 登录引导在回车后弹出）——AI 不会应答，请完成一次性登录后重新派发" };
        }
        const left = String(ui?.text ?? "").replace(/\s+/g, "");
        return { ok: true, how: left ? `CDP 打字+回车（输入面仍残留 ${left.length} 字，可能未发出）` : "CDP 打字+回车（输入面已清空=已提交）" };
    }

    /** 打字注入外壳：★ 2026-10-05 批3 —— 中途任何 CDP 失败一律转成「带原因的降档」，
     *  不再抛穿到 `start()` 的外层 catch。原行为：一次 hover/按键超时 → 抛出 → 印
     *  「注入异常：Input.dispatchMouseEvent 超时」，既绕过 D10 统一降档文案，也丢掉本可继续的步骤。 */
    async function cdpTypeInject(job, ov, text) {
        try {
            return await cdpTypeInjectInner(job, ov, text);
        }
        catch (e) {
            return { ok: false, why: `注入链中途失败：${e instanceof Error ? e.message : e}（有界降档，不再重试）` };
        }
    }

    /** 注入主链：信任弹窗 → dom 路径（原行为）或 cdp 打字路径 → 成败都给明确原因 */
    async function driveInject(job, ov) {
        const text = job.message.slice(0, 4000);
        await handleTrustDialog(job, ov);
        if (ov?.injectVia === "cdp") {
            const r = await cdpTypeInject(job, ov, text);
            pushLine(job, "sys", r.ok
                ? `[驾驶] 任务文本已注入（${r.how}）`
                : `[驾驶] 注入失败：${r.why}——已降档，请手动粘贴任务文本（D10）`);
            return;
        }
        // DOM 路径：先注入；失败且配置了 openChat → 探到面板没开就按一下 → 再注入一次
        let r = await domInject(job, ov, text);
        if (!r.ok && ov?.openChat) {
            const ui = await probeUi(job, ov);
            if (!ui?.panel) {
                await cdpKey(job, ov.openChat);
                await sleep(ov.openChat.waitMs ?? 1200);
                r = await domInject(job, ov, text);
            }
        }
        // ★ 根治（2026-10-06）：「未找到输入框」≠ 应用不支持 —— 拉起后 CDP 秒连 ≠ 编辑框已挂载
        //  （实测 WorkBuddy 刚启动时 DOM 还没有编辑器，一次失败即降档，任务永远注不进）。
        //   有界等待重试：最多 15s、每 900ms 一次，编辑框挂载即注入；不需要用户配置 readySelector。
        if (!r.ok && /未找到输入框/.test(r.why || "")) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 15000 && !r.ok) {
                await sleep(900);
                r = await domInject(job, ov, text);
                if (r.ok)
                    pushLine(job, "sys", `[驾驶] 编辑框就绪前等待了 ${Date.now() - startedAt}ms，重试注入成功`);
            }
        }
        pushLine(job, "sys", r.ok
            ? `[驾驶] 任务文本已注入（${r.how}）——若未发出请手动补发`
            : `[驾驶] 注入失败：${r.why}——已降档，请手动粘贴任务文本（D10）`);
    }

    async function start(job) {
        job.status = "launching";
        const p = job.profile;
        const ov = overridesOf(p); // ★ 批1：容忍双重编码存量，与 cliexec 同口径（见 dashboard-exec-util.overridesOf）
        // 可执行文件：launch_overrides.exe > scanAgents 路径
        let exe = ov?.exe ?? null;
        if (!exe) {
            try {
                const hit = ((await scanAgentsCached()) ?? []).find((a) => a.id === p.agent_key && a.path && a.path.includes(".exe"));
                exe = hit?.path ?? null;
            }
            catch { /* 扫描失败走降档 */ }
        }
        if (!exe) {
            const scanIds = (await scanAgentsCached()).map((a) => a.id).slice(0, 24).join(", ");
            return fail(job, `未找到该智能体的可执行文件（agent_key=${p.agent_key}；扫描清单：${scanIds || "扫描为空"}）。确认已安装，或在配置 launch_overrides.exe 中手动指定`);
        }
        const port = PORT_BASE + ((job.profileId * 7 + (++portCursor)) % 600);
        job.port = port;
        const args = ov?.args ?? [];
        // ★前置①：应用已开调试口 → 直接复用（单实例应用的第二进程会吞掉 --remote-debugging-port）
        const reuse = await reuseExistingCdp(exe, args);
        let targets = reuse?.targets ?? null;
        if (reuse) {
            job.port = reuse.port;
            pushLine(job, "sys", `[驾驶] 复用已有实例的调试口（端口 ${reuse.port}，${targets.length} 个页面）——不再重复拉起`);
        }
        if (!targets) {
            const waitMs = ov?.cdpTimeoutMs ?? CDP_WAIT_DEFAULT_MS;
            const launchOnce = async () => {
                const launchArgs = [...(p.workspace ? [p.workspace] : []), ...args, `--remote-debugging-port=${port}`, "--no-first-run"];
                pushLine(job, "sys", `[驾驶] 拉起 ${exe} ${launchArgs.join(" ")}`);
                try {
                    job.proc = spawn(exe, launchArgs, { cwd: p.workspace || undefined, detached: true, windowsHide: false, stdio: "ignore" });
                    job.pid = job.proc.pid ?? null;
                }
                catch (e) {
                    fail(job, `拉起失败：${e instanceof Error ? e.message : e}`);
                    return null;
                }
                job.proc.on("exit", () => { job.pid = null; });
                job.proc.on("error", (e) => pushLine(job, "err", `[驾驶] 进程错误：${e.message}`));
                // 等 CDP 端口
                return await pollHttp(`http://127.0.0.1:${port}/json/list`, waitMs);
            };
            targets = await launchOnce();
            if (!targets) {
                // ★前置②：先诊断再报错——有同类实例在跑就给可行动指引，不甩「应用可能不支持」这种误导
                const why = await diagnoseNoCdp(exe, job.pid);
                return fail(job, why ?? `CDP 调试端口 ${port} 未就绪（等待 ${Math.round(waitMs / 1000)}s）。请检查应用是否支持调试连接，或改用 CLI 通道`);

            }
        }
        pushLine(job, "sys", `[驾驶] CDP 已连接（端口 ${job.port}，${targets.length} 个页面）`);
        // 选目标页：targetMatch 正则优先（非法正则降级为不匹配，不能崩进程），否则第一个 page
        const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        let match = null;
        if (ov?.targetMatch) {
            try {
                const re = new RegExp(ov.targetMatch);
                match = pages.find((t) => re.test(`${t.title} ${t.url}`));
            }
            catch (e) {
                pushLine(job, "sys", `[驾驶] targetMatch 正则非法（${e.message}），已忽略`);
            }
        }
        const target = match ?? pages[0];
        if (!target)
            return fail(job, "没有可驾驶的页面目标");
        pushLine(job, "sys", `[驾驶] 目标页：${String(target.title || target.url).slice(0, 80)}`);
        // WebSocket 连入
        try {
            job.ws = new WebSocket(target.webSocketDebuggerUrl);
        }
        catch (e) {
            return fail(job, `WebSocket 连接失败：${e.message}`);
        }
        job.status = "driving";
        job.ws.addEventListener("open", async () => {
            pushLine(job, "sys", "[驾驶] 已连入应用界面，开始画面直播");
            cdpSend(job, "Page.enable", {});
            cdpSend(job, "Runtime.enable", {});
            cdpSend(job, "Page.startScreencast", { format: "jpeg", quality: 45, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 });
            // 尽力注入任务文本（链路有界：信任弹窗 → dom/CDP 打字 → 降档，不重试死磕 D10）
            try {
                await driveInject(job, ov);
            }
            catch (e) {
                pushLine(job, "sys", `[驾驶] 注入异常：${e.message}——已降档，请手动粘贴任务文本`);
            }
        });
        job.ws.addEventListener("message", (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.method === "Page.screencastFrame" && msg.params?.data) {
                job.frame = msg.params.data;
                cdpSend(job, "Page.screencastFrameAck", { sessionId: msg.params.sessionId });
                job.waiters?.forEach((w) => w("frame"));
            }
        });
        job.ws.addEventListener("close", () => {
            // ★ App 被用户关闭 → 会话终止并收口，不能让心跳把租约无限续命（reaper 失效）
            if (job.status === "driving")
                finish(job, false, "调试连接断开（应用可能被关闭）");
        });
        // 心跳 + 会话上限（SQL 单点在 db.js renewCardLease）
        job.heartbeat = setInterval(() => {
            try {
                renewCardLease(db, job.cardId, job.dispatchId);
            }
            catch { /* 不中断驾驶 */ }
        }, HEARTBEAT_MS);
        job.timer = setTimeout(() => finish(job, false, "驾驶会话到达上限，自动收口"), ov?.maxMinutes ? ov.maxMinutes * 60000 : DEFAULT_MAX_MS);
    }

    let msgId = 0;
    function cdpSend(job, method, params) {
        if (!job.ws || job.ws.readyState !== 1)
            return;
        job.ws.send(JSON.stringify({ id: ++msgId, method, params }));
    }
    function cdpCall(job, method, params, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            if (!job.ws || job.ws.readyState !== 1)
                return reject(new Error("WS 未连接"));
            const id = ++msgId;
            const timer = setTimeout(() => {
                job.ws.removeEventListener("message", onMsg);
                reject(new Error(`${method} 超时`));
            }, timeoutMs);
            const onMsg = (ev) => {
                let m;
                try { m = JSON.parse(ev.data); } catch { return; }
                if (m.id === id) {
                    clearTimeout(timer);
                    job.ws.removeEventListener("message", onMsg);
                    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
                }
            };
            job.ws.addEventListener("message", onMsg);
            job.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    function fail(job, why) {
        pushLine(job, "sys", `[驾驶] ${why}`);
        finish(job, false, why);
    }
    function finish(job, ok, detail) {
        if (job.status === "done" || job.status === "failed")
            return;
        // ★ 从未成功驾驶过（启动/等 CDP 阶段失败）→ 我们拉起的 App 是废实例，杀掉防泄漏；
        //   已进入 driving 的（用户停止/超时）→ App 归用户，只断连接不杀。
        const neverDrove = job.status !== "driving";
        job.status = ok ? "done" : "failed";
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
        clearInterval(job.heartbeat);
        try { job.ws?.close(); } catch { /* 忽略 */ }
        if (neverDrove && job.pid)
            killTree(job.pid);
        pushLine(job, "sys", `[驾驶] 收口：${detail}`);
        try {
            ctx.finalizeCardDispatch?.({ cardId: job.cardId, dispatchId: job.dispatchId, ok, runId: job.runId, actor: job.agent || "dispatch-agent", detail: `${detail}（CDP 驾驶）` });
        }
        catch (e) {
            pushLine(job, "sys", `[驾驶] 收口异常：${e instanceof Error ? e.message : e}`);
        }
        job.waiters?.forEach((w) => w("end"));
        job.waiters = [];
        // 收口后的会话只留最近 10 条（帧 base64 每条可达数百 KB，防常驻内存无界增长）
        pruneFinishedJobs(jobs, 10);
    }

    /** 派发入口：启动驾驶会话（不排队——每个驾驶会话独占一个 App 实例/端口） */
    ctx.startCdpRun = ({ cardId, agentCardId, profile, dispatchId, dispatchKey, taskId, message, agent }) => {
        const runId = `cdp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            runId, cardId, agentCardId: agentCardId ?? null, profileId: profile.id, dispatchId: dispatchId ?? null,
            taskId: taskId ?? null, message, profile, status: "queued", lines: [], frame: null, startedAt: null, finishedAt: null,
            agent: agent || "dispatch-agent", // ★ 收口比对用：须与卡上 assignee 同源（见 finish 的 actor）
        };
        jobs.set(runId, job);
        // start 是 async：必须接住 rejection（launch_overrides 正则写错等不能崩整个 dashboard）
        start(job).catch((e) => fail(job, `驾驶启动异常：${e instanceof Error ? e.message : e}`));
        return { runId, queued: false, queueAhead: 0 };
    };

    // 直播 SSE：帧 + 行 + 结束
    // ★ 根治批（2026-10-06）：驾驶 run 的文本日志此前只在内存里、无任何读取路由 —— 注入链断了无从诊断。
    app.get("/api/agent-cards/:id/cdp-log", (req, reply) => {
        const cardId = Number(req.params.id);
        const job = findJobByCard(jobs, cardId, { runId: String(req.query.runId ?? "") });
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡没有驾驶会话" });
        return { ok: true, runId: job.runId, status: job.status, lines: (job.lines ?? []).slice(-80) };
    });

    app.get("/api/agent-cards/:id/live", (req, reply) => {
        const cardId = Number(req.params.id);
        const job = findJobByCard(jobs, cardId, { runId: String(req.query.runId ?? "") });
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡没有驾驶会话" });
        let lastFrame = null; // 帧去重按连接独立
        streamJobSSE(reply, job, {
            intervalMs: 700,
            extraFlush: (write) => {
                if (job.frame && job.frame !== lastFrame) {
                    lastFrame = job.frame;
                    write("frame", { frame: job.frame });
                }
            },
        });
    });

    // 停止 = 断开驾驶连接并收口（不杀用户的 App）
    app.post("/api/agent-cards/:id/live/stop", async (req, reply) => {
        const cardId = Number(req.params.id);
        const job = findJobByCard(jobs, cardId, { runningOnly: true, runId: String(req.query.runId ?? "") });
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡当前没有驾驶会话" });
        finish(job, false, "用户断开驾驶");
        return { ok: true, runId: job.runId, note: "已断开驾驶连接；桌面应用本身未被关闭" };
    });

    app.get("/api/agent-cards/:id/live/status", async (req, reply) => {
        const cardId = Number(req.params.id);
        const list = [...jobs.values()].filter((j) => j.cardId === cardId || j.agentCardId === cardId)
            .map((j) => ({ runId: j.runId, status: j.status, pid: j.pid, port: j.port, startedAt: j.startedAt, finishedAt: j.finishedAt, lines: j.lines.length, hasFrame: !!j.frame }));
        return { ok: true, runs: list };
    });

    ctx.cdpJobs = () => jobs;
}
