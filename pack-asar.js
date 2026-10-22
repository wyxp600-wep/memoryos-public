/**
 * MemoryOS — app.asar 重打包器（最小改动：只替换 SYNC_FILES，其余文件字节级保留）
 *
 * 用法：node pack-asar.js            # 备份旧 asar → 写入新 asar → 反解逐文件校验
 *      node pack-asar.js --check    # 只校验当前 asar 与工作树副本是否一致
 *      node pack-asar.js --extract-only  # 把「asar-only」条目补到工作树（P2-7，幂等）
 *
 * asar 文件布局（与 Electron @electron/asar 一致）：
 *   [uint32 4][uint32 headerBuf.length][uint32 headerPayloadSize][uint32 jsonLen][json][file data...]
 *   file.offset 相对数据区起点 base = 8 + headerBuf.length = 16 + jsonLen
 *
 * ★ P2-7（2026-09-15）：`preload.js` / `welcome.html` / `assets/*` 原本**只存在于 asar**（不在工作树、不在 git）
 *   ⇒ 要改 IPC / 审批 UI 时「改不动且无 git 回滚」，只能从 asar 反向提取。现把这些路径纳入 SYNC_FILES
 *   并在工作树落副本，使其进入 git 纳管（改完 `node pack-asar.js` 即回写 asar）。
 *   有意**不纳入**：`/package.json`、`/release-settings.json` —— 前者落仓库根会改变根目录 npm 语义
 *   （根上已有 pack-asar.js 等工具脚本，误触 `npm test/install` 会作用到错误位置），后者属发布元数据、
 *   由发布流程生成。这两项要保持同步请单独处理，勿盲目加进 SYNC_FILES。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const ASAR = path.join(ROOT, "resources", "app.asar");
const SYNC_FILES = [
  "/main.js", "/services/core-process.js", "/window/tray.js", "/services/updater.js", // ★ 2026-09-14：updater.js 加入同步（T1 热更新加固）
  "/preload.js", "/welcome.html", "/assets/icon-512.png", "/assets/icon.ico", "/assets/tray.png", // ★ P2-7：asar-only → 落树纳管
  "/assets/tray.ico", // ★ 2026-10-10：多尺寸托盘图标（托盘根治 T3）
  // ★ 2026-09-21（A 分区跨区修复，P0）：以下壳层文件在 asar 内但不在本清单 → 改动重打包后静默丢失
  //   （与 09-18 发现的 lint 白名单盲区同类）。补齐后所有壳层源码改动均可被 `node pack-asar.js` 带入 asar。
  "/window/main-window.js", "/window/welcome-window.js",
  "/services/scheduler.js", "/services/port.js", "/security/token.js", "/security/ipc.js", "/app/lifecycle.js",
  // ★ 2026-10-16（托盘根治 T4）：C# 宿主源码随壳层同步——运行时由 window/tray.js 读取并编译成
  //   bridge/MemoryOS-Tray.exe（否则打包后源码不在 asar 内，宿主编译失败只能回退 PowerShell 通道）。
  "/window/tray-native/tray-native.cs", "/window/tray-native/tray-native.manifest",
];
/** 有意留在 asar-only 的条目（见文件头说明），--extract-only 不会提取它们 */
const EXTRACT_EXCLUDE = ["/package.json", "/release-settings.json"];

function sourceFile(asarPath) {
  return path.join(ROOT, asarPath.replace(/^\//, ""));
}

/** 解析 asar → { header, base, files: [{p, offset, size}] }（从 Buffer 或文件） */
function readAsarBuffer(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString("utf8"));
  const base = 16 + jsonLen;
  const files = [];
  (function walk(dir, prefix) {
    for (const name of Object.keys(dir.files)) {
      const e = dir.files[name];
      const p = prefix + "/" + name;
      if (e.files) walk(e, p);
      else files.push({ p, offset: Number(e.offset), size: Number(e.size) });
    }
  })(header, ""); // 注意：从 header 起（header.files 才是根映射）
  return { buf, header, base, files };
}

function readAsar(file) {
  return readAsarBuffer(fs.readFileSync(file));
}

function extract(a, f) {
  return a.buf.slice(a.base + f.offset, a.base + f.offset + f.size);
}

/** 取旧 header 中某路径的节点（用于沿用它未变动的字段，如 integrity） */
function nodeAt(header, p) {
  let node = header.files;
  for (const part of p.replace(/^\//, "").split("/")) {
    if (!node || !node[part]) return null;
    node = node[part];
    if (node.files) node = node.files;
  }
  return node;
}

/** 计算 per-file integrity（SHA256，blockSize 4MB；单块时 hash === blocks[0]） */
function computeIntegrity(data) {
  const blockSize = 4194304;
  const blocks = [];
  for (let i = 0; i < data.length; i += blockSize) {
    blocks.push(require("node:crypto").createHash("sha256").update(data.slice(i, i + blockSize)).digest("hex"));
  }
  const hash = blocks.length === 1
    ? blocks[0]
    : require("node:crypto").createHash("sha256").update(blocks.join("")).digest("hex");
  return { algorithm: "SHA256", hash, blockSize, blocks };
}

/** 打包：entries = [{ p, data }]（p 以 / 开头）；沿旧 header 顶层键与其他节点字段，变动文件重算 integrity */
function packAsar(entries, oldHeader) {
  const files = {};
  let cursor = 0;
  const ordered = entries.slice().sort((x, y) => (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
  for (const e of ordered) {
    const parts = e.p.replace(/^\//, "").split("/");
    let node = files;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || { files: {} };
      node = node[parts[i]].files;
    }
    const oldNode = nodeAt(oldHeader, e.p) || {};
    node[parts[parts.length - 1]] = {
      ...oldNode,
      size: e.data.length,
      offset: String(cursor),
      integrity: e.recompute ? computeIntegrity(e.data) : oldNode.integrity || computeIntegrity(e.data),
    };
    cursor += e.data.length;
  }
  const header = { ...oldHeader, files };
  // 删掉旧 header 里可能残留的非 files 顶层键之外的东西？保留原样，仅覆盖 files
  let json = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (json.length % 4)) % 4;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]); // 空格填充，JSON.parse 可容忍
  // 布局：[4][headerBuf.length][picklePayloadSize][jsonLen][json][data...]
  // 其中 picklePayloadSize = 4 + jsonLen（与 @electron/asar 一致，json 起始偏移恒为 16）
  const headerPayload = Buffer.alloc(8 + json.length);
  headerPayload.writeUInt32LE(4 + json.length, 0); // pickle payload size
  headerPayload.writeUInt32LE(json.length, 4); // writeString 的长度前缀
  json.copy(headerPayload, 8);
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(headerPayload.length, 4);
  const out = Buffer.concat([sizeBuf, headerPayload, ...ordered.map((e) => e.data)]);
  // 自检：产物必须能被解析且文件数一致，否则拒绝落盘
  const self = readAsarBuffer(out);
  if (self.files.length !== entries.length) throw new Error(`自检失败：文件数 ${self.files.length} ≠ ${entries.length}`);
  return out;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const extractOnly = process.argv.includes("--extract-only");
  const old = readAsar(ASAR);

  /* ── P2-7：把 asar-only 条目补到工作树（幂等；已存在且字节相同的跳过） ── */
  if (extractOnly) {
    let wrote = 0, same = 0;
    for (const f of old.files) {
      if (EXTRACT_EXCLUDE.includes(f.p)) { console.log(`跳过（有意保持 asar-only）: ${f.p}`); continue; }
      const target = sourceFile(f.p);
      if (fs.existsSync(target)) {
        const eq = fs.readFileSync(target).equals(extract(old, f));
        console.log(`${eq ? "已一致" : "⚠ 内容不同（保留工作树版本，未覆盖）"}: ${f.p}`);
        if (eq) same++; else wrote += 0;
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, extract(old, f));
      console.log(`已提取: ${f.p} → ${path.relative(ROOT, target)}`);
      wrote++;
    }
    console.log(`\n提取 ${wrote} 个、已存在一致 ${same} 个；SYNC_FILES 现有 ${SYNC_FILES.length} 条。`);
    console.log("提示：新增条目请同步加入 pack-asar.js 的 SYNC_FILES 并 `git add`，否则仍在 asar-only 无回滚区。");
    process.exit(0);
  }

  if (checkOnly) {
    let ok = true;
    for (const p of SYNC_FILES) {
      const cur = old.files.find((f) => f.p === p);
      const same = !!cur && extract(old, cur).equals(fs.readFileSync(sourceFile(p)));
      console.log(`asar ${p} 与根目录一致:`, same);
      ok = ok && same;
    }
    process.exit(ok ? 0 : 1);
  }

  const entries = old.files.map((f) => ({
    p: f.p,
    data: SYNC_FILES.includes(f.p) ? fs.readFileSync(sourceFile(f.p)) : extract(old, f),
    recompute: SYNC_FILES.includes(f.p),
  }));
  // ★ 2026-10-10：SYNC_FILES 里的新文件（旧 asar 没有）也要带入，否则新增资源静默丢失
  for (const p of SYNC_FILES) {
    if (!old.files.find((f) => f.p === p)) {
      entries.push({ p, data: fs.readFileSync(sourceFile(p)), recompute: true });
      console.log("新增带入 asar:", p);
    }
  }

  const out = packAsar(entries, old.header);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bak = path.join(ROOT, "resources", `app.asar.bak-${stamp}`);
  fs.copyFileSync(ASAR, bak);
  const tmp = ASAR + ".tmp";
  fs.writeFileSync(tmp, out);
  // 说明：rename 覆盖 app.asar 在本机报 EPERM，改用 copy 覆盖（同目录，原子性足够）
  fs.copyFileSync(tmp, ASAR);
  try { fs.unlinkSync(tmp); } catch { /* 沙箱/网络驱动可能报 EPERM，可安全忽略（tmp 在 resources/ 同目录） */ }
  console.log("备份:", bak);
  console.log("新 asar 字节:", out.length, "（旧:", old.buf.length, "）");

  // 反解校验：逐文件字节比对
  const v = readAsar(ASAR);
  let bad = 0;
  for (const e of entries) {
    const f = v.files.find((x) => x.p === e.p);
    if (!f) {
      console.log("❌ 缺失", e.p);
      bad++;
      continue;
    }
    const got = extract(v, f);
    if (!got.equals(e.data)) {
      console.log("❌ 内容不一致", e.p);
      bad++;
    }
  }
  console.log(`校验文件数 ${entries.length}，不一致 ${bad}`);
  for (const p of SYNC_FILES) {
    const file = v.files.find((x) => x.p === p);
    console.log(`${p} 与根目录一致:`, !!file && extract(v, file).equals(fs.readFileSync(sourceFile(p))));
  }
  process.exit(bad === 0 ? 0 : 1);
}

main();
