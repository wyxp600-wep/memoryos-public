/**
 * MemoryOS — 热更新清单签名 CLI（T1-R1 配套发布工具）
 *
 * 背景：sha256 只防传输损坏不防来源篡改；updater.js 现要求清单必须带 ed25519 签名
 * （公钥内置 services/updater.js 的 UPDATE_SIGN_PUBKEY，私钥已移出仓库至桌面 _memoryos-signing-keys、不入 git）。
 *
 * 用法：
 *   node services/sign-manifest.js keygen            首次生成密钥对（已存在则拒绝，--force 覆盖）
 *   node services/sign-manifest.js sign <file.json>  对文件字节签名 → 同目录 <file>.sig（不重排序，updater 按原字节验）
 *   node services/sign-manifest.js verify <file.json> [sig]   验签自检（sig 缺省取 <file>.sig）
 *   node services/sign-manifest.js pubkey            打印公钥（供核对与 updater.js 内置值比对）
 *
 * 发布流程：出包时生成 filelist.json → sign → 把 filelist.json + filelist.json.sig 一起上传更新源。
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

/* P0 隔离：密钥对已移出仓库目录（原 security/update-signing 不再存放私钥）；
   可用环境变量 MEMORYOS_SIGN_KEY_DIR 指向自定义位置。 */
const KEY_DIR = process.env.MEMORYOS_SIGN_KEY_DIR
  || path.join(os.homedir(), "Desktop", "_memoryos-signing-keys");
const PRIV = path.join(KEY_DIR, "ed25519-private.pem");
const PUB = path.join(KEY_DIR, "ed25519-public.pem");

function loadPrivate() {
  if (!fs.existsSync(PRIV)) {
    console.error(`未找到私钥 ${PRIV} —— 先执行 node services/sign-manifest.js keygen`);
    process.exit(1);
  }
  return crypto.createPrivateKey(fs.readFileSync(PRIV));
}
function loadPublic() {
  if (!fs.existsSync(PUB)) {
    console.error(`未找到公钥 ${PUB} —— 先执行 node services/sign-manifest.js keygen`);
    process.exit(1);
  }
  return crypto.createPublicKey(fs.readFileSync(PUB));
}

function keygen(force) {
  if (!force && (fs.existsSync(PRIV) || fs.existsSync(PUB))) {
    console.error("密钥对已存在（拒绝覆盖；确需轮换请加 --force，并同步更新 updater.js 内置公钥）");
    process.exit(1);
  }
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(PRIV, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }));
  console.log("已生成密钥对：");
  console.log("  私钥（不入 git）:", PRIV);
  console.log("  公钥:", PUB);
  console.log("★ 轮换时必须把下面公钥同步进 services/updater.js 的 UPDATE_SIGN_PUBKEY：");
  console.log(publicKey.export({ type: "spki", format: "pem" }).trim());
}

function sign(file) {
  const data = fs.readFileSync(file);
  const sig = crypto.sign(null, data, loadPrivate());
  const out = file + ".sig";
  fs.writeFileSync(out, sig);
  console.log(`已签名: ${out}（ed25519，${sig.length} 字节）`);
}

function verifyCmd(file, sigPath) {
  const data = fs.readFileSync(file);
  const sig = fs.readFileSync(sigPath || file + ".sig");
  const ok = crypto.verify(null, data, loadPublic(), sig);
  console.log(ok ? "✅ 验签通过" : "❌ 验签失败（内容与签名不匹配）");
  process.exit(ok ? 0 : 1);
}

function main() {
  const [op, arg, arg2] = process.argv.slice(2);
  if (op === "keygen") return keygen(arg === "--force");
  if (op === "sign") return arg ? sign(path.resolve(arg)) : die("用法: node services/sign-manifest.js sign <file.json>");
  if (op === "verify") return arg ? verifyCmd(path.resolve(arg), arg2 ? path.resolve(arg2) : undefined) : die("用法: node services/sign-manifest.js verify <file.json> [sig]");
  if (op === "pubkey") return console.log(fs.readFileSync(PUB, "utf8").trim());
  console.log([
    "MemoryOS 清单签名工具",
    "  node services/sign-manifest.js keygen             生成密钥对",
    "  node services/sign-manifest.js sign <file.json>   签名 → <file>.sig",
    "  node services/sign-manifest.js verify <file.json> [sig]  验签自检",
    "  node services/sign-manifest.js pubkey             打印公钥",
  ].join("\n"));
}
function die(msg) { console.error(msg); process.exit(1); }

main();
