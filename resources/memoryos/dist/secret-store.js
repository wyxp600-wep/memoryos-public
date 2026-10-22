/**
 * MemoryOS — 密钥加密存储（Windows DPAPI，用户作用域）
 *
 * 为什么需要它：P-4171 要求「LLM API Key 绝不明文落盘」，但原实现只是把 llmKey 从落盘对象里
 * 剥掉（dashboard.js writeDiskConfig）而没有替代存储 —— 结果密钥无处可去、保存即丢失，
 * 云端 LLM 在设置页根本配不起来。
 *
 * 方案：先用 DPAPI（CryptProtectData，用户作用域）加密，密文才允许写进 config.json。
 *   · 密文只有**同一个 Windows 用户**能解开；换机器/换账户解不开 → 明确报错，不静默失败。
 *   · 加密/解密借道 Windows 内置 PowerShell，零 npm 依赖（与 restart-core.js 同策略）。
 *   · **加密时明文走 stdin**，不出现在命令行/进程列表里。
 *   · 解密结果进程内缓存，避免每次调用都起 PowerShell。
 */
import { spawn } from "node:child_process";

const cache = new Map();
/** 候选宿主：pwsh(7) 优先（自带 Security 模块，不受 PSModulePath 污染影响），再退 PS 5.1 */
const SHELLS = [process.env.MEMORYOS_POWERSHELL, "pwsh", "powershell"].filter(Boolean);
let workingShell = null;
let lastShellError = "";

function spawnOnce(shell, command, stdin) {
    return new Promise((resolve) => {
        const env = { ...process.env };
        // 关键：清掉继承来的 PSModulePath。PS 5.1 若继承 PS7 的模块路径，
        // 会报「无法找到模块 Microsoft.PowerShell.Security」→ ConvertTo-SecureString 不可用。
        delete env.PSModulePath;
        let ps;
        try {
            ps = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
                env,
            });
        }
        catch (e) {
            return resolve({ ok: false, error: `启动 ${shell} 失败：${e instanceof Error ? e.message : String(e)}` });
        }
        let out = "", err = "";
        ps.stdout.on("data", (d) => { out += d; });
        ps.stderr.on("data", (d) => { err += d; });
        ps.on("error", (e) => resolve({ ok: false, error: `${shell} 不可用：${e.message}` }));
        ps.on("close", (code) => {
            if (code === 0 && out.trim())
                resolve({ ok: true, out: out.trim() });
            else
                resolve({ ok: false, error: (err || out || `${shell} 退出码 ${code}`).trim().slice(0, 300) });
        });
        try {
            if (stdin !== undefined)
                ps.stdin.write(stdin);
            ps.stdin.end();
        }
        catch { /* stdin 已关 */ }
    });
}

/** 依次尝试候选宿主，成功后记住可用宿主（避免每次都试错） */
async function runPs(command, stdin) {
    const tries = workingShell ? [workingShell] : SHELLS;
    for (const shell of tries) {
        const r = await spawnOnce(shell, command, stdin);
        if (r.ok) {
            workingShell = shell;
            return r;
        }
        lastShellError = r.error;
        if (workingShell)
            workingShell = null; // 之前可用的宿主这次失败 → 重新探测
    }
    return { ok: false, error: lastShellError || "没有可用的 PowerShell 宿主" };
}

/** 明文 → DPAPI 密文（base64）。明文经 stdin 传入，避免泄漏到命令行。 */
export async function protectSecret(plain, tag = "llmKey") {
    const value = String(plain ?? "");
    if (!value)
        return { ok: false, error: "空值不加密" };
    const r = await runPs("$s = ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force; ConvertFrom-SecureString -SecureString $s", value);
    if (!r.ok)
        return { ok: false, error: `DPAPI 加密失败：${r.error}` };
    cache.set(tag, value);
    return { ok: true, blob: r.out };
}

/** DPAPI 密文 → 明文；解不开（换机器/换用户/密文损坏）返回 null，调用方据此提示 */
export async function unprotectSecret(blob, tag = "llmKey") {
    if (!blob)
        return null;
    if (cache.has(tag))
        return cache.get(tag);
    const escaped = String(blob).replace(/'/g, "''");
    const r = await runPs(`$s = ConvertTo-SecureString '${escaped}'; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)`);
    if (!r.ok || !r.out)
        return null;
    cache.set(tag, r.out);
    return r.out;
}

/** 清缓存（密钥被替换/清除时调用） */
export function forgetSecret(tag = "llmKey") {
    cache.delete(tag);
}

/** 判断密文是否可用（不解出明文，仅探测可解密性） */
export async function canUnprotect(blob, tag = "llmKey") {
    return (await unprotectSecret(blob, tag)) !== null;
}
