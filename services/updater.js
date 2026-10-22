"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash, verify, createPublicKey } = require("node:crypto");

/* ---------- HTTP 封装 ---------- */
async function fetchJson(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
async function fetchBuffer(url, timeout = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/* ---------- sha256 ---------- */
function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function sha256File(p) {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/* ---------- 清单验签（T1-R1：sha256 只防传输损坏，不防来源篡改；清单必须过 ed25519 签名） ---------- */
/* 验签公钥内置于此；私钥仅存发布机 security/update-signing/（不入 git）。
   签名生成：node services/sign-manifest.js <filelist.json> → 同目录 <filelist>.sig */
const UPDATE_SIGN_PUBKEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAGjTuO2Lq7RU95Z1tobrj6C8UdKJ8thjg/UJEm4MqRVQ=",
  "-----END PUBLIC KEY-----",
].join("\n");
function assertManifestSigned(manifestBuf, sigBuf) {
  if (!UPDATE_SIGN_PUBKEY) throw new Error("更新包未内置验签公钥，拒绝更新");
  if (!Buffer.isBuffer(sigBuf) || sigBuf.length < 32) throw new Error("清单缺少签名（*.sig）");
  const ok = verify(null, manifestBuf, createPublicKey(UPDATE_SIGN_PUBKEY), sigBuf);
  if (!ok) throw new Error("清单签名校验失败（来源不可信，拒绝更新）");
}

/**
 * 路径安全性守卫（T1）：rel 必须来自清单，拒绝任何越出 root 的取值。
 * 三种弃：含 /.. 段、绝对路径（盘符/UNC/根斜杠）、空串。
 * 返回规范化后的 subpath；不合法则抛错，由调用方 catch 转 error。
 */
function assertSafeRel(rel, root) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("清单含空 rel");
  if (rel.includes("\\") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) throw new Error("清单 rel 非相对路径: " + rel);
  const norm = path.normalize(rel);
  if (norm === ".." || norm.startsWith(".." + path.sep) || path.isAbsolute(norm)) throw new Error("清单 rel 越界: " + rel);
  const joined = path.resolve(root, norm);
  const rootRes = path.resolve(root) + path.sep;
  if (!joined.startsWith(rootRes)) throw new Error("清单 rel 落点越出内核目录: " + rel);
  // 返回统一正斜杠形态：win32 的 path.normalize 会产出反斜杠，二次调用会被上面的反斜杠守卫误拒
  return norm.split(path.sep).join("/");
}

/** 更新源信任（T1-R1）：仅接受 https + 受信主机白名单（已移除第三方镜像 mirror.ghproxy.com），
 *  且必须指向具体路径（不允许域名根——防白名单主机被当通用代理）。 */
const TRUSTED_UPDATE_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
]);
function assertTrustedOrigin(updateUrl) {
  let u;
  try { u = new URL(updateUrl); } catch { throw new Error("更新源不是合法 URL: " + updateUrl); }
  if (u.protocol !== "https:") throw new Error("更新源必须 https: " + updateUrl);
  if (!TRUSTED_UPDATE_HOSTS.has(u.hostname)) throw new Error("更新源不在受信白名单: " + u.hostname);
  if (u.pathname.length <= 1) throw new Error("更新源必须指向具体路径，不允许域名根: " + updateUrl);
}

/**
 * 内核自研增量热更新。依赖经 deps 注入，避免模块间循环 require。
 * deps: { readConfig, readReleaseSettings, readVersion, getKernel, dataDir, restartCore, log }
 * 返回纯结果（{status,current,latest,applied,restartPending?,error?}），UI 弹窗由调用方处理。
 *
 * T1-R3 契约：applyKernelUpdate **只改磁盘文件，不动 version.json**；
 * version.json 由调用方在内核重启成功后经 updateLocalVersion() 写入——
 * 重启失败时版本号保持旧值，下一轮检查会走「文件已一致但版本未落」分支再次尝试重启（自愈）。
 */
function makeUpdater(deps) {
  let _hotupdating = false;

  const { readConfig, readReleaseSettings, readVersion, getKernel, dataDir, restartCore, log } = deps;

  /** 更新内核 version.json 为 latest（仅应在内核重启成功后调用） */
  function updateLocalVersion(latest) {
    try {
      const p = path.join(getKernel(), "version.json");
      const v = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      v.version = latest;
      v.updated = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
    } catch (e) {
      // 版本号写失败不影响已落盘的文件更新，但热更新审计需要留痕
      log("更新 version.json 失败:", e instanceof Error ? e.message : String(e));
    }
  }

  /** 覆盖后重启内核；成功才落版本号，失败留旧版本号等下轮自愈，并立即重试一次 */
  async function restartAfterUpdate(r) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await restartCore();
        updateLocalVersion(r.latest);
        return true;
      } catch (e) {
        log(`内核重启失败（第 ${attempt} 次，版本号保持 ${r.current}，下一轮将自动重试）:`, e instanceof Error ? e.message : String(e));
      }
    }
    return false;
  }

  /** 执行一次内核热更新。status ∈ done / none / error / disabled */
  async function applyKernelUpdate() {
    const cfg = readConfig() || {};
    const updateUrl = cfg.updateUrl || readReleaseSettings().updateUrl;
    if (!updateUrl) return { status: "disabled" };
    try { assertTrustedOrigin(updateUrl); }
    catch (e) { log("热更新源未通过信任校验:", e.message); return { status: "disabled", current: readVersion(), error: e.message }; }
    const current = readVersion();
    try {
      const meta = await fetchJson(updateUrl);
      const latest = String(meta.version || "");
      if (!latest || latest === current) return { status: "none", current };
      const base = new URL(".", updateUrl).toString();
      const manifestUrl = new URL(meta.manifest || "new/filelist.json", base).toString();
      const manifestBuf = await fetchBuffer(manifestUrl);
      const sigBuf = await fetchBuffer(manifestUrl + ".sig");
      assertManifestSigned(manifestBuf, sigBuf);
      const manifest = JSON.parse(manifestBuf.toString("utf8"));
      if (!manifest.files || !manifest.files.length) throw new Error("清单为空");
      log(`热更新 ${current} → ${latest}（${manifest.files.length} 个文件，清单签名已验证）`);
      const todo = [];
      for (const f of manifest.files) {
        const relNorm = assertSafeRel(f.path, getKernel());
        const local = path.join(getKernel(), relNorm);
        if (sha256File(local) !== f.hash) todo.push({ rel: relNorm, hash: f.hash });
      }
      if (!todo.length) {
        // 文件已全部一致但版本号还是旧值 → 上轮覆盖后重启未成功，本轮只补重启
        log("热更新：文件已一致，版本号未落（上轮重启未完成），仅补重启");
        return { status: "applied", current, latest, applied: 0, restartPending: true };
      }
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-hotup-"));
      const downloaded = [];
      for (const f of todo) {
        const buf = await fetchBuffer(new URL(f.rel, new URL("new/", base).toString()).toString());
        if (sha256Buf(buf) !== f.hash) throw new Error(`hash 不匹配: ${f.rel}`);
        const target = path.join(tmp, assertSafeRel(f.rel, tmp));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        downloaded.push({ f, relNorm: assertSafeRel(f.rel, tmp) });
      }
      const bakRoot = path.join(dataDir(), "data", "backup", "hotupdate-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
      /* ── 备份阶段：先把旧文件全部备份、并把备份清单（旧哈希）落盘，然后才允许动目标文件 ── */
      const plan = [];
      for (const dl of downloaded) {
        const relNorm = assertSafeRel(dl.relNorm, getKernel());
        const dst = path.join(getKernel(), relNorm);
        const existed = fs.existsSync(dst);
        let bak = null, oldSha = null;
        if (existed) {
          if (!fs.statSync(dst).isFile()) throw new Error("落点被目录占用，无法覆盖（请人工检查内核目录）: " + relNorm);
          oldSha = sha256File(dst); // 旧内容哈希必须在覆盖前计算（回滚依据）
          bak = path.join(bakRoot, relNorm);
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          fs.copyFileSync(dst, bak);
        }
        plan.push({ relNorm, dst, bak, oldSha, tmp: path.join(tmp, assertSafeRel(dl.relNorm, tmp)) });
      }
      fs.mkdirSync(bakRoot, { recursive: true });
      fs.writeFileSync(path.join(bakRoot, "manifest.sha256"),
        plan.filter((p) => p.oldSha).map((p) => p.oldSha + "  " + p.relNorm.replace(/\\/g, "/")).join("\n") + "\n", "utf8");
      /* ── 覆盖阶段：逐文件覆盖，中途失败立即把已覆盖文件还原（新建文件则删除） ── */
      const done = [];
      try {
        for (const p of plan) {
          fs.mkdirSync(path.dirname(p.dst), { recursive: true });
          fs.copyFileSync(p.tmp, p.dst);
          done.push(p);
        }
      } catch (copyErr) {
        for (const p of done.reverse()) {
          try {
            if (p.bak) fs.copyFileSync(p.bak, p.dst);
            else fs.rmSync(p.dst, { force: true });
          } catch (rbErr) {
            log("回滚单文件失败:", p.relNorm, rbErr instanceof Error ? rbErr.message : String(rbErr));
          }
        }
        log(`覆盖中途失败，已回滚 ${done.length} 个文件；备份留存 → ${bakRoot}`);
        throw copyErr;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      tmp = null;
      log(`热更新完成：${plan.length} 个文件覆盖，旧版备份 → ${bakRoot}（内核重启成功后落版本号）`);
      return { status: "applied", current, latest, applied: plan.length, restartPending: true };
    } catch (e) {
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ } }
      log("热更新执行失败:", String(e.message || e));
      return { status: "error", current, error: String(e.message || e) };
    }
  }

  /** 自动热更新（后台静默）：发现新版→应用→重启内核→重启成功才落版本号 */
  async function runAutoHotUpdate() {
    if (_hotupdating) return;
    _hotupdating = true;
    try {
      const r = await applyKernelUpdate();
      if (r.status === "applied") {
        const ok = await restartAfterUpdate(r);
        if (ok) log(`自动热更新：${r.current} → ${r.latest}（${r.applied} 文件）`);
        else log(`自动热更新：文件已覆盖但内核重启失败，版本号保持 ${r.current}，下一轮检查将自动补重启`);
      } else if (r.status === "error") {
        log(`自动热更新失败：${r.error}`);
      }
    } finally {
      _hotupdating = false;
    }
  }

  /** 启动自调度：启动 delay 后首查 + interval 周期。默认 20s / 30min */
  function auto({ delayMs = 20 * 1000, intervalMs = 30 * 60 * 1000 } = {}) {
    setTimeout(runAutoHotUpdate, delayMs);
    setInterval(runAutoHotUpdate, intervalMs);
  }

  return { applyKernelUpdate, runAutoHotUpdate, auto, updateLocalVersion, restartAfterUpdate };
}

module.exports = { makeUpdater, sha256File, sha256Buf };
