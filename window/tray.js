"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { app } = require("electron");

function safeLog(log, ...a) {
  if (typeof log === "function") log("[Tray]", ...a);
  else console.log("[Tray]", ...a);
}

/* ============ 托盘实现（2026-10-16 定稿：独立 WinForms 宿主 MemoryOS-Tray.exe）============
   本机逐项实证结论（每条都有日志/注册表/自检证据）：

   ① Electron 原生 Tray 在本机「注册成功但不渲染」——注册表
      HKCU\Control Panel\NotifyIconSettings 内 MemoryOS.exe 条目 IsPromoted=1，
      但主托盘与 Win11 隐藏抽屉（^）里都不出现图标。→ 该通道彻底废弃并移除，
      旧代码是 Electron Tray + PowerShell 双通道，本文件已是单通道（详见下）。

   ② 独立 C# WinForms 宿主（/target:winexe，NotifyIcon）注册与渲染都正常：
      宿主自检 Shell_NotifyIconGetRect 返回 hr=0x00000000 且 rect 落在任务栏上。
      旧结论「自定义 winexe 完全不注册」（记忆 #4810）已推翻——其依据 UIA 枚举在本机
      （自动隐藏任务栏 + Windhawk styler）恒返回 0，根本判不出来。

   ③ **根因 = 完整性级别**（本机 EnableLUA=0 → explorer 跑在 High）。经 ShellExecute /
      explorer 拉起的应用（含本应用与 Electron）是 Medium，UIPI 会**静默丢弃**它的
      Shell_NotifyIcon：hr=0x80004005、explorer 不建档、图标连 ^ 抽屉都不出现。
      Job 对象/窗口站/桌面/UI 限制/父进程/中文 tip 全部 A/B 排除，唯一差异因子是完整性级别。
      → 修法：直连启动后 6s 内没让 shell 收下图标，即改用「计划任务 RunLevel=Highest」拉起
        同一个宿主 exe（Medium 进程自己就能 create/run 它，实测无需 UAC 弹窗）→ 宿主拿到
        High 令牌 → 注册成功、explorer 建档、IsPromoted 生效。成功一次即记旗标，后续启动
        直接走提权通道（省掉 6s 探测）。计划任务 /tr 有 261 字符上限 → 动作只写 exe 路径，
        参数由同目录 MemoryOS-Tray.conf 提供。
      **判据是宿主自报的 reg=<hr>**（Shell_NotifyIconGetRect：0=shell 收下了，其它=被静默丢弃），
      而不是「注册表里有没有条目」——后者有历史遗留条目会误报（本文件 17:44 实测踩过）。

   ④ 图标落 ^ 抽屉还是主托盘，取决于 NotifyIconSettings 中**该 exe 条目**的 IsPromoted。
      纯写注册表 + 重新注册**不生效**（explorer 内存缓存），必须重启 explorer/注销才应用
      → 宿主启动即自置 IsPromoted=1，并把「原值」写进状态文件；本文件见「本次新置 1」
        或「从未应用过」即自动重启一次 explorer（已获用户授权，6 小时内不重复）。
        explorer 重启后 WinForms NotifyIcon 响应 TaskbarCreated 自动重加图标，不丢图标。

   ⑤ 宿主身份 = 可执行文件路径（%APPDATA%\memoryos-desktop\bridge\MemoryOS-Tray.exe，
      路径稳定不变）→ 注册表条目跨启动稳定，用户的显示偏好不丢（实测该路径在 High 下 1s 内建档）。
      另有最后一道自愈：若两条通道都拿不到条目，则轮换到全新身份（-2 / -3，见 ⑦）。

   ⑥ 宿主进程本身用 winexe：天生无控制台，不存在「黑窗」与「关窗杀进程」两个老问题。
      提权通道下宿主是 High、本进程是 Medium —— MIC 禁止低完整性级别进程写高完整性对象，
      故本进程**杀不掉也探不动**该宿主。对策（宿主侧已实现）：退出信号文件 + PID 文件心跳，
      本进程据此判定存活与请求退出（详见 killChannel / stopChannelProcess / alivePid）。

   ⑦ 兜底：若本机没有 .NET Framework 的 csc.exe（Windows 自带，极罕见）或宿主编译失败，
      自动回退到原 PowerShell 小助手通道（图标落 ^ 抽屉，功能完整但不吃「常驻显示」），
      保证任何情况下都不会「完全没有托盘图标」。

   ⑧ 身份轮换自愈（最后一道）：explorer 对**曾建档、条目又被删除**的 exe 路径可能永不重建
      （重启 explorer 也不重建；而全新路径 1s 内即建档，4/4 探针复现）。故提权通道也拿不到
      条目时，轮换到全新候选身份（MemoryOS-Tray.exe → -2 → -3），选中的身份持久化。

   宿主源码在 window/tray-native/（运行时读取并编译，缓存 exe + 源码哈希，源码变更自动重编译）。 */
const HOST_NAMES = ["MemoryOS-Tray.exe", "MemoryOS-Tray-2.exe", "MemoryOS-Tray-3.exe"];
const HOST_SRC_DIR = path.join(__dirname, "..", "window", "tray-native");
const HOST_TIP = "MemoryOS 记忆系统";
const DIRECT_CHECK_MS = 6000;    // 直连通道（普通机器主路径）判定窗口
const ELEVATED_CHECK_MS = 15000; // 提权通道判定窗口（计划任务启动 + 宿主注册 + explorer 建档）
const ELEVATED_TRIES = 2;        // 提权通道尝试次数（上一次运行的 High 宿主可能尚未退出）
const HEARTBEAT_TOLERANCE_MS = 120000; // PID 文件心跳新鲜度阈值（宿主 30s 心跳）
const AUTO_RESTART_MIN_GAP_MS = 6 * 3600 * 1000; // 自动重启 explorer 的最小间隔
const ELEVATION_TASK = "MemoryOS-TrayHost";

/* ---------- 兜底：PowerShell 小助手（原实现，保留）----------
   VBS sh.Run(..., 0, False) 隐藏控制台拉起 → 无黑窗 + 图标在 ^ 抽屉；
   消息泵 DoEvents 轮询；180s 重注册（explorer 会静默吞已注册图标）。 */
const BRIDGE_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "function W([string]$m) {",
  "  try { Add-Content -Path '__LOG__' -Value ((Get-Date -Format 'yyyy/MM/dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {}",
  "}",
  // 原子投递：写临时文件 → Move-Item 覆盖（旧实现 WriteAllText 先清空再写，轮询可能读到空/半条命令）
  "function C([string]$c) {",
  "  try {",
  "    $t = '__CMD__.tmp'",
  "    [System.IO.File]::WriteAllText($t, $c, [System.Text.Encoding]::ASCII)",
  "    Move-Item -LiteralPath $t -Destination '__CMD__' -Force",
  "  } catch { W ('cmd fail ' + $_.Exception.Message) }",
  "}",
  "$mtx = $null; $mtxNew = $false",
  "try { $mtx = [System.Threading.Mutex]::new($true, 'MemoryOS-Tray-Host-v1', [ref]$mtxNew) } catch { $mtxNew = $true }",
  "if (-not $mtxNew) { W 'ps 小助手：已有宿主实例在运行，本次退出（不重复注册图标）'; exit }",
  "function Make-Ni {",
  "  $n = New-Object System.Windows.Forms.NotifyIcon",
  "  try {",
  "    $n.Icon = New-Object System.Drawing.Icon('__ICO__')",
  "  } catch {",
  "    W ('icon fail ' + $_.Exception.Message)",
  "    try { $n.Icon = [System.Drawing.SystemIcons]::Application } catch {}",
  "  }",
  "  $n.Text = 'MemoryOS 记忆系统'",
  "  $m = New-Object System.Windows.Forms.ContextMenuStrip",
  "  $i1 = New-Object System.Windows.Forms.ToolStripMenuItem('打开 MemoryOS')",
  "  $i2 = New-Object System.Windows.Forms.ToolStripMenuItem('在浏览器打开')",
  "  $i3 = New-Object System.Windows.Forms.ToolStripMenuItem('检查更新')",
  "  $i4 = New-Object System.Windows.Forms.ToolStripMenuItem('重启内核')",
  "  $i5 = New-Object System.Windows.Forms.ToolStripMenuItem('重启 MCP 服务')",
  "  $i6 = New-Object System.Windows.Forms.ToolStripMenuItem('重新启动')",
  "  $i7 = New-Object System.Windows.Forms.ToolStripMenuItem('退出')",
  "  [void]$m.Items.Add($i1)",
  "  [void]$m.Items.Add($i2)",
  "  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))",
  "  [void]$m.Items.Add($i3)",
  "  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))",
  "  [void]$m.Items.Add($i4)",
  "  [void]$m.Items.Add($i5)",
  "  [void]$m.Items.Add($i6)",
  "  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))",
  "  [void]$m.Items.Add($i7)",
  "  $n.ContextMenuStrip = $m",
  "  $i1.Add_Click({ C 'show' })",
  "  $i2.Add_Click({ C 'browser' })",
  "  $i3.Add_Click({ C 'update' })",
  "  $i4.Add_Click({ C 'restart-core' })",
  "  $i5.Add_Click({ C 'restart-mcp' })",
  "  $i6.Add_Click({ C 'relaunch' })",
  "  $i7.Add_Click({ C 'quit' })",
  "  $n.Add_DoubleClick({ C 'show' })",
  "  $n.Visible = $true",
  "  return $n",
  "}",
  "$ni = Make-Ni",
  "W ('icon ok (ico) visible=' + $ni.Visible)",
  "try { [System.IO.File]::WriteAllText('__PIDFILE__', [string]$PID, [System.Text.Encoding]::ASCII) } catch {}",
  "W ('bridge started appPid=__PID__ selfPid=' + $PID)",
  "$sw = [System.Diagnostics.Stopwatch]::StartNew()",
  "$lastWatch = 0.0",
  "$lastReload = 0.0",
  "$lastBeat = 0.0",
  "while ($true) {",
  "  [System.Windows.Forms.Application]::DoEvents()",
  "  Start-Sleep -Milliseconds 150",
  "  if (($sw.Elapsed.TotalSeconds - $lastBeat) -ge 30) {",
  "    $lastBeat = $sw.Elapsed.TotalSeconds",
  "    if (Test-Path -LiteralPath '__PIDFILE__.quit') { W 'bridge: 收到退出信号文件，主动退出'; break }",
  "    try { [System.IO.File]::WriteAllText('__PIDFILE__', [string]$PID, [System.Text.Encoding]::ASCII) } catch {}",
  "  }",
  "  if (($sw.Elapsed.TotalSeconds - $lastWatch) -ge 5) {",
  "    $lastWatch = $sw.Elapsed.TotalSeconds",
  "    if ($null -eq (Get-Process -Id __PID__ -ErrorAction SilentlyContinue)) { W 'app gone, bridge self-exit'; break }",
  "  }",
  "  if (($sw.Elapsed.TotalSeconds - $lastReload) -ge 180) {",
  "    $lastReload = $sw.Elapsed.TotalSeconds",
  "    try {",
  "      $prev = $ni; $prev.Visible = $false; $prev.Dispose()",
  "      $ni = Make-Ni",
  "      W ('re-registered visible=' + $ni.Visible)",
  "    } catch { W ('re-register fail ' + $_.Exception.Message) }",
  "  }",
  "}",
  "$ni.Visible = $false",
  "$ni.Dispose()",
  "try { Remove-Item -LiteralPath '__PIDFILE__' -ErrorAction SilentlyContinue } catch {}",
  "W 'bridge exited'",
].join("\r\n");

let channelProc = null;    // 原生宿主直连子进程（Node 直接持有 pid，无需依赖 PID 文件）
let channelPid = null;
let channelKind = null;    // "native" | "ps1"
let ensuring = false;      // 宿主编译/准备中（防并发重入）
let shuttingDown = false;
let epoch = 0;             // 每次启动通道 +1，使旧的延时回调失效
let lastOpts = null;
let cmdTimer = null;
let bridgeWatchdog = null;
let quitHookBound = false;
let autoRestartDone = false; // 本次运行是否已自动重启过 explorer
let channelIl = "";          // 当前宿主自报的完整性级别（"High" 时它才有能力重启 explorer）

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function bridgeDir() { return path.join(app.getPath("userData"), "bridge"); }
function pidFilePath() { return path.join(bridgeDir(), "tray-bridge.pid"); }
function quitSignalFile() { return pidFilePath() + ".quit"; }
function hostCmdFile() { return pidFilePath() + ".hcmd"; }
function cmdFilePath() { return path.join(bridgeDir(), "tray-cmd.txt"); }
function identityFile() { return path.join(bridgeDir(), "tray-host-identity.txt"); }
function statusFile() { return path.join(bridgeDir(), "tray-host-status.txt"); }
function confFile() { return path.join(bridgeDir(), "MemoryOS-Tray.conf"); }
function elevationFlagFile() { return path.join(bridgeDir(), "tray-needs-elevation.txt"); }
function elevationTaskStampFile() { return path.join(bridgeDir(), "tray-elevation-task.txt"); }
function autoRestartFile() { return path.join(bridgeDir(), "tray-explorer-restarted.txt"); }

function makeFiles() {
  const dir = bridgeDir();
  return {
    dir,
    cmd: cmdFilePath(),
    pid: pidFilePath(),
    log: path.join(dir, "tray-bridge.log"),
    status: statusFile(),
    ico: path.join(dir, "tray.ico"),
  };
}

function readPid() {
  try {
    const s = fs.readFileSync(pidFilePath(), "utf8").trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  } catch { return null; }
}

/* 进程存活：dead / alive / unknown。
   unknown = 查不动（跨完整性级别：提权通道的 High 宿主对 Medium 的我们而言查不动）→ 一律当活着，
   否则会把好端端的宿主误判为死亡而反复重拉。 */
function pidState(pid) {
  if (!pid) return "dead";
  try { process.kill(pid, 0); return "alive"; }
  catch (e) { return e && e.code === "ESRCH" ? "dead" : "unknown"; }
}

/* 存活的通道 pid：直连子进程直接用 Node 持有的 pid；提权/兜底通道读 PID 文件。
   提权通道下宿主是 High，本进程（Medium）探不动它 → 改用 PID 文件心跳（宿主 30s 重写）。 */
function alivePid() {
  if (channelPid) {
    if (pidState(channelPid) !== "dead") return channelPid;
    channelPid = null;
    channelProc = null;
  }
  const pid = readPid();
  if (!pid) return null;
  if (pidState(pid) === "dead") return null;
  try {
    const st = fs.statSync(pidFilePath());
    const age = Date.now() - st.mtimeMs;
    if (age > HEARTBEAT_TOLERANCE_MS) {
      safeLog(lastOpts && lastOpts.log, "托盘宿主心跳已停 " + Math.round(age / 1000) + "s（视作已退出）");
      return null;
    }
  } catch { return null; }
  return pid;
}

/* 退出通道：写退出信号文件（提权通道下本进程杀不掉 High 宿主，MIC 禁止低写高）+ 尽力 taskkill。
   宿主 2s 内巡检到信号文件即主动退出。同步函数：app 退出（before-quit）时无法 await。
   ★ 2026-10-18：此处**不再**清命令轮询定时器——轮询是 app 级（与通道类型无关），
     通道被杀/切换后轮询必须继续存活；清它正是菜单点击失效的成因之一（见 startCmdPolling）。 */
function killChannel() {
  const pid = alivePid();
  try { fs.writeFileSync(quitSignalFile(), "quit\r\n"); } catch { /* 下次启动会清掉 */ }
  if (pid) execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  channelProc = null;
  channelPid = null;
}

/* 停通道并**等它真的退出**（切换通道/轮换身份前必须确认，否则单实例互斥体会挡掉新宿主）。
   返回 true = 已确认退出；false = 还在（跨完整性级别且信号文件也没生效的极端情况）。 */
async function stopChannelProcess() {
  const pid = alivePid();
  channelProc = null;
  channelPid = null;
  if (!pid) {
    try { fs.unlinkSync(pidFilePath()); } catch { /* 已删 */ }
    return true;
  }
  try { fs.writeFileSync(quitSignalFile(), "quit\r\n"); } catch { /* 忽略 */ }
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 24; i++) {                 // 最多约 7s（宿主 2s 巡检 + 余量）
    if (pidState(pid) === "dead") break;
    await sleep(300);
  }
  const dead = pidState(pid) === "dead";
  if (dead) {
    try { fs.unlinkSync(pidFilePath()); } catch { /* 已删 */ }
  }
  return dead;
}

function stopTrayChannel() {
  shuttingDown = true;
  channelKind = null;
  stopCmdPolling();   // 轮询是 app 级：只在 app 退出时停，通道切换不得停（见 startCmdPolling）
  killChannel();
}

/* ---------- 身份（宿主 exe 路径 = 注册表条目身份）---------- */
function hostName() {
  try {
    const n = fs.readFileSync(identityFile(), "utf8").trim();
    if (HOST_NAMES.includes(n)) return n;
  } catch { /* 首次运行 */ }
  return HOST_NAMES[0];
}
function setHostName(n) {
  try { fs.writeFileSync(identityFile(), n); } catch { /* 下次重新判定，无害 */ }
}

/* ---------- 提权通道旗标 / 自动应用标记 ---------- */
function elevationNeeded() {
  try { return fs.statSync(elevationFlagFile()).size > 0; } catch { return false; }
}
function markElevationNeeded() {
  try { fs.writeFileSync(elevationFlagFile(), "1\r\n"); } catch { /* 下次再判定 */ }
}
function clearElevationNeeded() {
  try { fs.unlinkSync(elevationFlagFile()); } catch { /* 本来就不在 */ }
}
function lastAutoRestart() {
  try { return Number(fs.readFileSync(autoRestartFile(), "utf8").trim()) || 0; } catch { return 0; }
}
function markAutoRestart() {
  try { fs.writeFileSync(autoRestartFile(), String(Date.now())); } catch { /* 下次可能重复，无害 */ }
}

/* ---------- 通道守护（watchdog）：宿主进程会被**无声硬杀** ----------
   实证：bridge 日志无任何退出记录、进程凭空消失。无守护时托盘通道静默失效、用户完全无感。
   故 30s 巡检存活（提权通道按 PID 文件心跳判定），死了即重拉；app 退出时同步停巡检。 */
function startBridgeWatchdog(o) {
  lastOpts = o;
  if (bridgeWatchdog) return;
  bridgeWatchdog = setInterval(() => {
    if (shuttingDown) return;
    if (alivePid()) return;
    safeLog(o.log, "托盘通道已不在（无声死亡），自动重拉");
    channelProc = null;
    channelPid = null;
    startTrayChannel(lastOpts || o);
  }, 30000);
  if (!quitHookBound) {
    app.on("before-quit", () => {
      if (bridgeWatchdog) { clearInterval(bridgeWatchdog); bridgeWatchdog = null; }
      stopTrayChannel();
    });
    quitHookBound = true;
  }
}

/* ---------- 主通道：编译宿主 exe（原生）---------- */
function findCsc() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const cands = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 继续 */ } }
  return null;
}

/* 源码哈希 → 变更即重编译；exe 缓存在 bridge 目录（路径稳定 = 注册表条目稳定） */
function ensureTrayHost(dir, log, name) {
  return new Promise((resolve) => {
    try {
      const src = fs.readFileSync(path.join(HOST_SRC_DIR, "tray-native.cs"));
      const manifest = fs.readFileSync(path.join(HOST_SRC_DIR, "tray-native.manifest"));
      const exe = path.join(dir, name);
      const stamp = crypto.createHash("sha1").update(src).update(manifest).digest("hex");
      const stampFile = exe + ".sha1";
      if (fs.existsSync(exe) && fs.existsSync(stampFile) &&
        fs.readFileSync(stampFile, "utf8").trim() === stamp) {
        resolve(exe);
        return;
      }
      const csc = findCsc();
      if (!csc) {
        safeLog(log, "未找到 csc.exe（.NET Framework 缺失），回退 PowerShell 小助手通道");
        resolve(null);
        return;
      }
      // csc 读不了 asar 内路径 → 先把源码/manifest 落到 bridge 目录
      const csOut = path.join(dir, "MemoryOS-Tray.cs");
      const mfOut = path.join(dir, "MemoryOS-Tray.manifest");
      fs.writeFileSync(csOut, src);
      try { fs.writeFileSync(mfOut, manifest); } catch { /* manifest 写失败不致命 */ }
      // /codepage:65001：源码为 UTF-8，不加则 csc 按系统 ANSI 读，中文菜单标签会乱码
      const args = ["/nologo", "/target:winexe", "/optimize+", "/platform:anycpu", "/codepage:65001",
        "/r:System.dll", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll"];
      if (fs.existsSync(mfOut)) args.push("/win32manifest:" + mfOut);
      args.push("/out:" + exe, csOut);
      safeLog(log, "编译托盘宿主（首次或源码变更）: " + name);
      execFile(csc, args, { windowsHide: true, timeout: 120000 }, (err, _out, errOut) => {
        if (err) {
          safeLog(log, "托盘宿主编译失败，回退 PowerShell 小助手通道: " +
            ((errOut && String(errOut).trim().split(/\r?\n/)[0]) || err.message));
          resolve(null);
          return;
        }
        try { fs.writeFileSync(stampFile, stamp); } catch { /* 下次重编译，无害 */ }
        safeLog(log, "托盘宿主编译完成: " + exe);
        resolve(exe);
      });
    } catch (e) {
      safeLog(log, "托盘宿主准备失败，回退 PowerShell 小助手通道:", (e && e.message) || String(e));
      resolve(null);
    }
  });
}

/* ---------- 提权通道（计划任务 RunLevel=Highest）----------
   为什么需要：本机 EnableLUA=0 → explorer 运行在 High，而经 ShellExecute/explorer 拉起的应用
   是 Medium，UIPI 静默丢弃其 Shell_NotifyIcon（hr=0x80004005、explorer 不建档）。
   计划任务是唯一「无需 UAC 弹窗就能拿到 High 令牌」的通道，且 Medium 进程完全可以自己
   create/run/delete 它（本机 el-task2 实测：il=High、hr=0x00000000、promoted=1）。
   /tr 有 261 字符上限 → 动作只写目标路径，参数由 MemoryOS-Tray.conf 提供。 */
function runSchtasks(args) {
  return new Promise((resolve) => {
    execFile("schtasks", args, { windowsHide: true, timeout: 30000 }, (err, out, errOut) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === "number" ? err.code : (err ? 1 : 0),
        text: (String(errOut || "") + String(out || "")).trim().slice(0, 200),
      });
    });
  });
}

/* 提权通道的启动目标：原生宿主 = exe 本身（winexe 无控制台）；兜底 PS 通道 = 一个小 .cmd
   （wscript 隐藏控制台拉起 ps1；路径固定、无需引号，规避 execFile 的引号转义坑）。 */
function elevateTarget(kind, exe, f, log) {
  if (kind === "native") return exe;
  const wrap = path.join(f.dir, "tray-bridge-launch.cmd");
  try {
    fs.writeFileSync(wrap,
      "@echo off\r\nwscript.exe //B \"" + path.join(f.dir, "tray-bridge.vbs") + "\"\r\n", "ascii");
  } catch (e) {
    safeLog(log, "写提权启动包装失败: " + ((e && e.message) || String(e)));
    return null;
  }
  return wrap;
}

/* 参数落盘给提权通道用（命令行参数优先于 conf，见 tray-native.cs 的 LoadConf） */
function writeConf(f) {
  const lines = [
    "# 提权通道参数（计划任务 /tr 只能写目标路径，其余参数由本文件提供）。由 window/tray.js 重写。",
    "ico=" + f.ico,
    "cmd=" + f.cmd,
    "log=" + f.log,
    "pid=" + f.pid,
    "status=" + f.status,
    "tip=" + HOST_TIP,
    "parent=" + process.pid,
  ];
  fs.writeFileSync(confFile(), lines.join("\r\n") + "\r\n", "utf8");
}

/* 计划任务按需登记：动作路径变了（身份轮换）或被外部删了就重建。
   用本地戳文件比对动作路径，避免解析 schtasks 的本地化/编码输出。 */
async function ensureElevationTask(log, target) {
  let stamp = "";
  try { stamp = fs.readFileSync(elevationTaskStampFile(), "utf8").trim(); } catch { /* 首次 */ }
  const q = await runSchtasks(["/query", "/tn", ELEVATION_TASK]);
  if (q.ok && stamp === target) return true;
  const c = await runSchtasks(["/create", "/tn", ELEVATION_TASK, "/tr", target,
    "/sc", "once", "/st", "23:59", "/rl", "HIGHEST", "/f"]);
  if (!c.ok) {
    safeLog(log, "创建提权计划任务失败（退出码 " + c.code + "）：可能被组策略禁止创建计划任务。"
      + (c.text ? " 输出: " + c.text : ""));
    return false;
  }
  try { fs.writeFileSync(elevationTaskStampFile(), target); } catch { /* 下次重建，无害 */ }
  safeLog(log, "已登记提权计划任务 " + ELEVATION_TASK + "（RunLevel=Highest → " + target + "）");
  return true;
}

/* ---------- 状态文件判读 ---------- */
/* found / notfound / busy → 终态立即返回；空文件（宿主没起来）则等满窗口 */
async function waitFound(f, ms) {
  const end = Date.now() + ms;
  let st = "";
  for (;;) {
    try { st = fs.readFileSync(f.status, "utf8").trim(); } catch { st = ""; }
    if (st.startsWith("found") || st.startsWith("busy")) return st;
    if (Date.now() >= end) return st;
    await sleep(700);
  }
}

/* 通道成败的唯一判据：宿主自报的 **shell 是否真的收下了图标**（reg=0x00000000 = 收下）。
   不能只看注册表条目 found —— 历史遗留条目会让被拒收的 Medium 宿主误报「就绪」
   （实测 17:44：Medium 宿主 hr=0x80004005 被 UIPI 静默丢弃，但旧条目仍在、old=1 → 误判成功）。 */
function regOk(st) { return /reg=0x0{8}/i.test(st); }

/* 取证：把宿主自报的完整性级别与 Shell_NotifyIcon 结果写进壳层日志（便于事后核对） */
function hostDiag(f) {
  try {
    const tail = fs.readFileSync(f.log, "utf8").split(/\r?\n/).filter(Boolean).slice(-12).join(" ");
    const il = tail.match(/il=(\w+)/g);
    const hr = tail.match(/hr=0x([0-9A-Fa-f]{8})/g);
    const parts = [];
    let last = "";
    if (il) { last = il[il.length - 1].slice(3); parts.push("宿主完整性级别=" + last); }
    if (hr) parts.push("Shell_NotifyIcon " + hr[hr.length - 1].slice(0));
    return { text: parts.length ? "（" + parts.join("，") + "）" : "", il: last };
  } catch { return { text: "", il: "" }; }
}

/* ---------- 启动通道（直连）---------- */
function launchDirect(o, f, name, exe, myEpoch, kind) {
  try { fs.unlinkSync(f.status); } catch { /* 无残留 */ }
  try { fs.unlinkSync(quitSignalFile()); } catch { /* 清掉上一轮的退出信号，别让新宿主一启动就退 */ }
  if (kind === "native") {
    // --parent：宿主软件 PID，宿主 2s 巡检，宿主软件没了即自退，不留孤儿
    const args = ["--ico", f.ico, "--cmd", f.cmd, "--log", f.log, "--pid", f.pid, "--status", f.status,
      "--tip", HOST_TIP, "--parent", String(process.pid)];
    const p = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
    channelProc = p;
    channelPid = p.pid;
    channelKind = "native";
    p.on("exit", () => { if (channelProc === p) { channelProc = null; channelPid = null; } });
    safeLog(o.log, "托盘宿主已启动（直连通道 · 身份 " + name + " · 自动置 IsPromoted=1 常驻主托盘）");
    setTimeout(() => {
      if (myEpoch === epoch && !shuttingDown) safeLog(o.log, "托盘宿主自报 PID=" + (readPid() || "(尚无 PID 文件)"));
    }, 3000);
  } else {
    launchPsBridge(o, f);
  }
  // 命令轮询不在此启动：它是 app 级、在 createTray 统一启动（本函数在提权通道下根本不执行，见 startCmdPolling）
}

/* ---------- 兜底通道：PowerShell 小助手 ---------- */
function launchPsBridge(o, f) {
  const lit = (s) => String(s).replace(/'/g, "''");
  const script = BRIDGE_SCRIPT
    .replace(/__CMD__/g, lit(f.cmd))
    .replace(/__LOG__/g, lit(f.log))
    .replace(/__ICO__/g, lit(f.ico))
    .replace(/__PIDFILE__/g, lit(f.pid))
    .replace(/__PID__/g, String(process.pid));
  const ps1 = path.join(f.dir, "tray-bridge.ps1");
  const vbs = path.join(f.dir, "tray-bridge.vbs");
  fs.writeFileSync(ps1, String.fromCharCode(0xfeff) + script, "utf8"); // BOM：PS 5.1 才能正确读中文标签
  fs.writeFileSync(vbs, [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""${ps1}""", 0, False`,
  ].join("\r\n"), "utf8");
  spawn("wscript.exe", ["//B", vbs], { windowsHide: true, stdio: "ignore" });
  channelKind = "ps1";
  safeLog(o.log, "已回退 PowerShell 小助手通道（隐藏控制台 → 无黑窗；图标在 ^ 抽屉）脚本=" + ps1);
  setTimeout(() => {
    if (!shuttingDown) safeLog(o.log, "小助手自报 PID=" + (readPid() || "(尚无 PID 文件)"));
  }, 3000);
}

/* ---------- 通道编排：直连 → 提权 → 轮换身份 ---------- */
async function startChannelFlow(o, f, name, exe, myEpoch) {
  const bad = () => shuttingDown || myEpoch !== epoch;
  const kind = exe ? "native" : "ps1";
  let directLaunched = false;

  // A. 直连（普通机器主路径：explorer 同为 Medium，直连即可建档）
  if (!elevationNeeded()) {
    launchDirect(o, f, name, exe, myEpoch, kind);
    directLaunched = true;
    const st = await waitFound(f, DIRECT_CHECK_MS);
    if (bad()) return;
    if (st.startsWith("found") && regOk(st)) { onChannelOk(o, f, st, "直连通道"); return; }
    safeLog(o.log, "直连通道没能让 shell 收下图标（状态：" + (st || "无状态文件") + "）"
      + "→ 升级为提权通道（计划任务 RunLevel=Highest，High 令牌绕开 UIPI 对 Medium 托盘注册的拒收）");
    const gone = await stopChannelProcess();
    if (bad()) return;
    if (!gone) safeLog(o.log, "直连宿主未确认退出（继续尝试提权通道，宿主自带单实例互斥，重复不会产生第二个图标）");
    directLaunched = false;
  }

  // B. 提权通道
  let taskUsable = true;
  for (let i = 1; i <= ELEVATED_TRIES && taskUsable; i++) {
    if (bad()) return;
    const target = elevateTarget(kind, exe, f, o.log);
    if (!target) { taskUsable = false; break; }
    try { writeConf(f); } catch (e) {
      safeLog(o.log, "写 MemoryOS-Tray.conf 失败: " + ((e && e.message) || String(e)));
      taskUsable = false;
      break;
    }
    if (!(await ensureElevationTask(o.log, target))) { taskUsable = false; break; }
    if (bad()) return;
    try { fs.unlinkSync(f.status); } catch { /* 无残留 */ }
    try { fs.unlinkSync(quitSignalFile()); } catch { /* 别让上一轮切换通道时写的退出信号把新宿主带下去 */ }
    try { fs.unlinkSync(hostCmdFile()); } catch { /* 同上，清掉上一轮的反向命令 */ }
    const run = await runSchtasks(["/run", "/tn", ELEVATION_TASK]);
    if (!run.ok) {
      safeLog(o.log, "运行提权计划任务失败（退出码 " + run.code + "）" + (run.text ? "：" + run.text : ""));
      taskUsable = false;
      break;
    }
    channelKind = kind;
    safeLog(o.log, "已通过提权计划任务启动托盘宿主" + (i > 1 ? "（第 " + i + " 次尝试）" : "")
      + "（动作：" + target + "）");
    const st = await waitFound(f, ELEVATED_CHECK_MS);
    if (bad()) return;
    if (st.startsWith("found") && regOk(st)) {
      markElevationNeeded();
      onChannelOk(o, f, st, "提权通道");
      return;
    }
    if (st.startsWith("busy")) {
      safeLog(o.log, "提权通道：已有宿主实例在运行（多半是上一次运行的 High 宿主尚未自退），等它 2s 巡检退出后重试");
      await sleep(6000);
      continue;
    }
    safeLog(o.log, "提权通道也没让 shell 收下图标（状态：" + (st || "无状态文件") + "）");
  }
  if (bad()) return;

  if (!taskUsable) {
    safeLog(o.log, "提权通道不可用；保持现有通道（托盘图标功能本身仍可用，只是吃不到「常驻主托盘」）");
    if (!directLaunched) launchDirect(o, f, name, exe, myEpoch, kind);
    return;
  }
  await rotateIdentity(o, f, name);
}

/* 两条通道都拿不到条目 → 最后一道自愈：换全新身份（见文件头 ⑧） */
async function rotateIdentity(o, f, name) {
  const idx = HOST_NAMES.indexOf(name);
  const next = HOST_NAMES[idx + 1];
  if (!next) {
    safeLog(o.log, "宿主身份已用尽（" + HOST_NAMES.length + " 个候选 explorer 均未建档）；"
      + "保持当前通道，仅「常驻主托盘」未生效");
    return;
  }
  const gone = await stopChannelProcess();
  if (!gone) {
    safeLog(o.log, "旧宿主未退出（高完整性进程，本进程结束不掉）→ 暂不轮换身份，交看门狗/退出时回收");
    return;
  }
  safeLog(o.log, "explorer 未为 " + name + " 建档 → 轮换为全新身份 " + next);
  setHostName(next);
  startTrayChannel(o);
}

/* 通道就绪：记日志取证 + 必要时自动重启一次 explorer 让「常驻主托盘」生效 */
function onChannelOk(o, f, st, how) {
  const m = /^found\s+\S+\s+old=(\S+)/.exec(st);
  const d = hostDiag(f);
  channelIl = d.il;
  safeLog(o.log, "托盘通道就绪（" + how + "）：" + st + d.text);
  maybeAutoApplyPromotion(o, f, m ? m[1] : "");
}

/* IsPromoted=1 是 explorer **内存缓存**读的值，写入后必须重启 explorer（或注销）才生效。
   用户已授权自动重启一次；只在「本次新写入」或「从未应用过」时做，且 6h 内不重复，
   重启后宿主响应 TaskbarCreated 自动重加图标，不会丢图标。 */
function maybeAutoApplyPromotion(o, f, oldVal) {
  const say = (m) => safeLog(o.log, m);
  if (autoRestartDone) return;
  const last = lastAutoRestart();
  if (oldVal === "1" && last) return;                      // 早就写过、也应用过 → 无事可做
  if (last && Date.now() - last < AUTO_RESTART_MIN_GAP_MS) {
    say("托盘图标已是「始终显示」，但 " + Math.round((Date.now() - last) / 60000)
      + " 分钟前刚自动重启过 explorer，本次不重复（注销/重启后同样会固定到主托盘）");
    return;
  }
  autoRestartDone = true;
  markAutoRestart();
  restartExplorer(o, f, say);
}

/* ---------- 命令轮询（两条通道都写同一个 tray-cmd.txt）---------- */
function explorerPids(cb) {
  execFile("tasklist", ["/FI", "IMAGENAME eq explorer.exe", "/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => {
    if (err) { cb([]); return; }
    const pids = [];
    String(out || "").split(/\r?\n/).forEach((line) => {
      const m = /^"explorer\.exe","(\d+)"/i.exec(line.trim());
      if (m) pids.push(m[1]);
    });
    cb(pids);
  });
}

/* explorer 重启后：NotifyIcon 响应 TaskbarCreated 自动重加图标；IsPromoted=1 被重新读取 → 图标落主托盘。
   **本进程是 Medium、explorer 是 High 时杀不掉它**（MIC 禁止低写高，实测 taskkill 无效），
   故改了完整性级别时改由高完整性宿主代劳（宿主 <pid>.hcmd 反向命令，2s 内执行）。 */
function restartExplorer(o, f, say) {
  if (channelIl === "High") {
    say("重启资源管理器以应用托盘常驻显示（本进程是 Medium，explorer 是 High，交给高完整性宿主执行）");
    try {
      fs.writeFileSync(hostCmdFile(), "restart-explorer\r\n", "ascii");
      say("已向高完整性宿主下达重启指令（宿主 2s 内执行）");
    } catch (e) {
      say("下达重启指令失败: " + ((e && e.message) || String(e)));
    }
    return;
  }
  say("重启资源管理器以应用托盘常驻显示");
  explorerPids((before) => {
    execFile("taskkill", ["/F", "/IM", "explorer.exe"], { windowsHide: true, stdio: "ignore" }, () => {
      setTimeout(() => {
        explorerPids((after) => {
          const fresh = after.filter((p) => !before.includes(p));
          if (fresh.length) { say("explorer 已自动重启（新 PID " + fresh.join(",") + "）"); return; }
          if (!after.length) {
            try {
              spawn("explorer.exe", [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
              say("explorer 未自动重启，已手动拉起");
            } catch (e) { say("explorer 拉起失败: " + ((e && e.message) || String(e))); }
            return;
          }
          say("explorer 未重启（原 PID " + before.join(",") + " 仍在）——多半是本进程完整性级别低于 explorer，"
            + "请用托盘菜单的「立即应用托盘常驻（重启资源管理器）」或注销一次");
        });
      }, 2500);
    });
  });
}

/* ★ 2026-10-18 根因修复（托盘菜单点击后完全无反应）：
   本函数原先只在 launchDirect / launchPsBridge 里调用，而本机 EnableLUA=0 → explorer 是 High →
   直连通道必定失败并切到「提权通道」，那条路径（startChannelFlow 的 B 段 / rotateIdentity /
   看门狗重拉）**从不执行 launchDirect**，于是轮询定时器压根没建立：
   宿主把菜单命令写进 tray-cmd.txt，壳层无人消费（文件滞留、永不删除）→ 所有菜单项点击都没反应。
   实证：desktop.log 内「[Tray] 托盘命令」历史零条；bridge/tray-cmd.txt 滞留 `relaunch`（16:31 写入）。
   修法：轮询与通道**彻底解耦** —— createTray 启动一次，活到 app 退出（仅 stopTrayChannel 停）。
   注意：actions 的回调来自 trayOpts（main.js 注入），重启通道不会换 o，故只捕获一次即可。 */
function startCmdPolling(o) {
  if (cmdTimer) return;
  const { shell, port, TOKEN, log, onShowMain, onUpdateCheck, onRestartCore, onRestartMcp, onQuit } = o;
  const say = (m) => safeLog(log, m);
  const actions = {
    show: () => onShowMain(),
    browser: () => shell.openExternal(`http://127.0.0.1:${port}/?token=${encodeURIComponent(TOKEN)}`),
    update: () => { if (onUpdateCheck) onUpdateCheck(); },
    "restart-core": () => { if (onRestartCore) onRestartCore(); },
    "restart-mcp": () => { if (onRestartMcp) onRestartMcp(); },
    "restart-explorer": () => restartExplorer(o, makeFiles(), say),
    relaunch: () => { app.relaunch(); app.quit(); },
    quit: () => { if (onQuit) onQuit(); else app.quit(); },
  };
  cmdTimer = setInterval(() => {
    try {
      const cmdFile = cmdFilePath();
      if (!fs.existsSync(cmdFile)) return;
      const cmd = fs.readFileSync(cmdFile, "utf8").trim();
      // 读到空内容 = 宿主正在写入（旧版 File.WriteAllText 会先清空）→ 等下一轮，**不删文件**，否则命令会丢
      if (!cmd) return;
      fs.unlinkSync(cmdFile);
      const fn = actions[cmd];
      if (!fn) { say("托盘未知命令: " + cmd); return; }
      say("托盘命令: " + cmd);
      fn();
    } catch { /* 忽略瞬时读写冲突 */ }
  }, 400);
  say("托盘命令轮询已启动（400ms，与通道类型无关：直连/提权/ps1 都靠它执行菜单动作）");
}

function stopCmdPolling() {
  if (!cmdTimer) return;
  clearInterval(cmdTimer);
  cmdTimer = null;
}

/* ---------- 启动托盘通道 ---------- */
function startTrayChannel(o) {
  lastOpts = o;
  if (ensuring || shuttingDown) return;
  ensuring = true;
  const myEpoch = ++epoch;
  try {
    const dir = bridgeDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = makeFiles();
    // 真实 .ico 文件（GDI+ 读不了 asar 内路径；PNG→HICON 句柄无所有权、易失效 → Shell_NotifyIcon 静默失败）
    fs.copyFileSync(path.join(__dirname, "..", "assets", "tray.ico"), f.ico);
    try { fs.unlinkSync(f.pid); } catch { /* 无残留 */ }
    try { fs.unlinkSync(quitSignalFile()); } catch { /* 清掉上一轮的退出信号，别让新宿主一启动就退 */ }
    try { fs.unlinkSync(f.cmd); } catch { /* 无残留 */ }
    const name = hostName();
    ensureTrayHost(dir, o.log, name).then((exe) => {
      ensuring = false;
      if (shuttingDown || myEpoch !== epoch) return;
      startChannelFlow(o, f, name, exe, myEpoch).catch((e) => {
        safeLog(o.log, "托盘通道流程异常: " + ((e && e.message) || String(e)));
      });
    });
  } catch (e) {
    ensuring = false;
    safeLog(o.log, "托盘通道启动失败: " + ((e && e.message) || String(e)));
  }
}

function createTray(o) {
  /* 单通道：独立 C# 宿主（可常驻主托盘）。不再创建 Electron Tray——本机它注册不渲染，
     留着只会让人误以为托盘已就绪（2026-10-16 实证，见文件头注释①）。 */
  /* ★ 命令轮询必须在**通道编排之前**启动，且只在这里启动：
     本机走提权通道，launchDirect 不执行 —— 旧代码把轮询挂在 launchDirect 里，
     结果菜单点击写了命令文件却没人消费（2026-10-18 根因，详见 startCmdPolling 注释）。 */
  startCmdPolling(o);
  startTrayChannel(o);
  startBridgeWatchdog(o);
}

module.exports = { createTray };
