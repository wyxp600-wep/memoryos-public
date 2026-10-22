/** T8（P2-3）：buildApp 路由域拆分 —— static 域。
 * handler 自 dashboard.js 原行 1306-1331 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function registerStatic(app, ctx) {
    const { db, UI_DIR, _staticCache } = ctx;
    // —— 新版重设计 UI：/ 与 /echarts.min.js（读取文件，同源 /api/* 免 CORS）——
    //   ★ P1-1 / T7：改为内存驻留 + ETag/304。mtime/size 变化自动失效。
    //   html/js 用 no-cache（协商缓存，改完即生效）；echarts 版本固定用 immutable 长缓存。
    const staticAsset = (name) => {
        const full = path.join(UI_DIR, name);
        const st = fs.statSync(full);
        const key = `${st.mtimeMs}:${st.size}`;
        const hit = _staticCache.get(name);
        if (hit && hit.key === key)
            return hit;
        const buf = fs.readFileSync(full);
        const entry = { key, buf, etag: `"${createHash("sha256").update(buf).digest("hex").slice(0, 16)}"` };
        _staticCache.set(name, entry);
        return entry;
    };
    const sendStatic = (name, type, cacheControl) => (req, reply) => {
        const a = staticAsset(name);
        reply.header("Cache-Control", cacheControl).header("ETag", a.etag).type(type);
        const inm = String(req.headers["if-none-match"] ?? "");
        if (inm.split(",").map((s) => s.trim()).includes(a.etag))
            return reply.code(304).send();
        return reply.send(a.buf);
    };
    app.get("/", sendStatic("index.html", "text/html; charset=utf-8", "no-cache"));
    app.get("/styleguide", sendStatic("index.html", "text/html; charset=utf-8", "no-cache"));
    app.get("/echarts.min.js", sendStatic("echarts.min.js", "application/javascript", "public, max-age=31536000, immutable"));
    app.get("/app.js", sendStatic("app.js", "application/javascript", "no-cache"));
    // 固定白名单，禁止路径穿越；字体与 HTML/JS 一样用 ETag 协商缓存，更新后不保留旧字体。
    for (const font of ['inter-400.woff2','inter-600.woff2','jetbrains-mono-400.woff2','jetbrains-mono-600.woff2']) {
        app.get('/fonts/' + font, sendStatic('fonts/' + font, 'font/woff2', 'public, max-age=0, must-revalidate'));
    }
    // /canvas-editor.js 路由 2026-10-05 随节点画布并入任务地图而移除（canvas-editor.js 已删）
}
