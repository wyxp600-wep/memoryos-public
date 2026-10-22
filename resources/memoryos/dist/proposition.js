import { memoryFields } from './memory-fields.js';
/**
 * proposition.js — 命题关系判定（把「语义相似」与「命题冲突」分开）
 *
 * 背景（2026-10-18 收尾 P2）：原 db.js::dedupeDecision 仅按最高余弦分档
 *   （≥0.92 merge / ≥0.85 conflict），但余弦只反映「话题相近」，不反映「两个命题是否互斥」。
 *   实测生产库 74 条 conflict_with 指针逐对核读，绝大多数是同一子系统/同一次排障的不同记录
 *   （相关但互补），被误标为冲突 → 双方都被降置信、进仲裁队列。
 *
 * 口径（本模块的判据边界，勿越界）：
 *   · 相似度只用于选候选；本模块只回答「关系类型」，不回答「哪条更可信」。
 *   · 判 conflict 必须有**显式不相容信号**：同对象 + 对立谓词 / 谓词否定不对称 / 同一语境数字矛盾。
 *   · 判 duplicate 必须近同文且同范围（用于「重复同义」，不用于「不同命题合并」）。
 *   · 判 related = 同主题且适用条件不相交或无可比命题（版本迁移/环境不同）。
 *   · 判 unknown = 重叠存在但无法判定 → 待复核，**不等于无冲突**，不得据此提高置信度。
 *
 * 覆盖边界（诚实声明）：纯词法信号不可能覆盖「语义互斥但用词不同」的冲突
 *   （例：托盘图标根因先后被推翻的两条记录用词完全不同）。这类样本会落到 unknown（待复核），
 *   而不是被自动裁成「无冲突」。需要更高召回时应接 LLM 复核并校验引用来自原文。
 */

const CJK = /[\u4e00-\u9fff]/;

/** 相邻 CJK 二连字集合（与 db.js::gramTokens 同源口径；非 CJK 打断连续性） */
export function bigrams(s, cap = 4000) {
    const out = new Set();
    let prev = "";
    for (const ch of String(s)) {
        if (CJK.test(ch)) {
            if (prev) out.add(prev + ch);
            prev = ch;
            if (out.size >= cap) break;
        }
        else prev = "";
    }
    return out;
}

/** 抽取五字段（宽松版：字段名后允许 : 或 ：，取到行尾）；未结构化时 head/scope 为空 */
export function bodyFields(content) {
    const s = String(content).replace(/\r\n?/g, "\n");
    const grab = n => memoryFields(s).find(f=>f.name===n)?.value ?? "";
    return { structured: /(?:^|\n)\*{0,2}结论(?:\*{0,2})?[：:]/.test(s), head: grab("结论"), scope: grab("适用范围"), state: grab("状态") };
}

/** 对立谓词对（左/右互为否定）。**只在「主张区」内匹配**，不做全文扫描——
 *  全文扫描会把叙事性叙述（「失败三次后成功了」）误判为对立，实测误报率极高（2026-10-18 回放实证）。 */
const OPPOSITES = [
    ["证伪", "成立"], ["被推翻", "沿用"], ["与软件实现无关", "与软件有关"],
    ["不可兼得", "可以兼得"], ["不属于", "属于"], ["无效", "有效"],
    ["禁止", "允许"], ["必须", "不必"], ["只能", "也可以"], ["已替代", "仍适用"],
];
/** 量化锚点（数字必须紧邻同名锚点才算「同一命题上的互斥数值」） */
const ANCHORS = ["版本", "阈值", "超时", "高度", "宽度", "维度", "比例", "覆盖率", "命中率", "长度", "数量", "页面", "端口", "天数", "并发", "上限"];
/** 主张区 = 结构化正文的「结论」行；散文正文取去空白后的前 130 字（标题/首句） */
function claimRegion(text, fields) {
    if (fields.structured && fields.head) return fields.head;
    return String(text).replace(/\s+/g, " ").trim().slice(0, 130);
}
const NUM_RE = /(?:\d+\.\d+|\d{4}-\d{2}-\d{2}|\d+)/g;
/** 数字集合 */
function numbers(s) {
    const out = new Set();
    for (const m of String(s).match(NUM_RE) ?? []) out.add(m);
    return out;
}

/**
 * 关系判定。
 * @param {string} a 新正文
 * @param {string} b 既有正文
 * @param {{sim?:number}} [opts] 余弦（仅记录在 signals 里，**不参与判定**，避免把相似度当冲突证据）
 * @returns {{relation:'duplicate'|'conflict'|'related'|'unknown', reason:string, signals:object}}
 */
export function classifyRelation(a, b, opts = {}) {
    const A = String(a ?? "").replace(/\r\n?/g, "\n"), B = String(b ?? "").replace(/\r\n?/g, "\n");
    const ga = bigrams(A), gb = bigrams(B);
    const inter = [...ga].filter((x) => gb.has(x));
    const overlap = Math.min(ga.size, gb.size) ? inter.length / Math.min(ga.size, gb.size) : 0;
    const fa = bodyFields(A), fb = bodyFields(B);
    const signals = { overlap: Number(overlap.toFixed(3)), sharedGrams: inter.length, bothStructured: fa.structured && fb.structured, sim: opts.sim ?? null };

    // —— 显式不相容信号（全部限制在主张区 + 要求对象重叠达标）—— //
    const ca = claimRegion(A, fa), cb = claimRegion(B, fb);
    const hard = [], soft = [];
    if (overlap >= 0.30) {
        // ①【硬信号】对立谓词：整对只见于单侧，且落在主张区
        for (const [x, y] of OPPOSITES) {
            const ax = ca.includes(x), bx = cb.includes(x), ay = ca.includes(y), by = cb.includes(y);
            if ((ax && by && !ay && !bx) || (ay && bx && !ax && !by)) hard.push(`主张区对立谓词「${x} / ${y}」分列两侧`);
        }
        // ②【软信号】谓词否定不对称：同一 CJK 词在两侧主张区都出现，仅一侧被否定前缀修饰。
        //   ★ 实测该信号噪声高（同一事实的不同表述/工序说明都会触发）→ 只降级为「待复核」，不判冲突。
        if (inter.length >= 5) {
            const negA = new Set([...ca.matchAll(/(?:不|未|无|非|否)([\u4e00-\u9fff]{2,4})/g)].map((m) => m[1]));
            const negB = new Set([...cb.matchAll(/(?:不|未|无|非|否)([\u4e00-\u9fff]{2,4})/g)].map((m) => m[1]));
            for (const t of negA) if (cb.includes(t) && !negB.has(t)) soft.push(`主张区否定不对称：「${t}」仅 A 侧被否定`);
            for (const t of negB) if (ca.includes(t) && !negA.has(t)) soft.push(`主张区否定不对称：「${t}」仅 B 侧被否定`);
        }
        // ③【硬信号】同一量化锚点上的数字互斥（例：同一对象「阈值=0.92」vs「阈值=0.85」）。
        //   必须锚点同名 + 数字紧邻锚点，避免把任意数字差异（页码/时间戳/任务序号）当成矛盾。
        if (inter.length >= 6) {
            for (const anchor of ANCHORS) {
                if (!ca.includes(anchor) || !cb.includes(anchor)) continue;
                const after = (s) => { const m = s.match(new RegExp(`${anchor}[^\\d\\n]{0,8}(\\d+(?:\\.\\d+)?)`)); return m ? m[1] : null; };
                const va = after(ca), vb = after(cb);
                if (va && vb && va !== vb) hard.push(`同一锚点「${anchor}」的数值互斥（A=${va}，B=${vb}）`);
            }
        }
    }
    if (hard.length) return { relation: "conflict", reason: hard.slice(0, 3).join("；"), signals };
    if (soft.length) return { relation: "unknown", reason: `可疑但不足以判冲突（${soft.slice(0, 2).join("；")}）→ 待复核`, signals };

    // —— 重复同义 —— //
    const headSame = fa.structured && fb.structured && fa.head && fa.head === fb.head;
    const scopeSame = fa.structured && fb.structured && fa.scope && fa.scope === fb.scope;
    if ((headSame && scopeSame) || (A.trim() === B.trim())) return { relation: "duplicate", reason: "同范围 + 结论逐字相同", signals };
    if (overlap >= 0.75 && Math.abs(A.length - B.length) / Math.max(A.length, B.length) <= 0.15)
        return { relation: "duplicate", reason: `近似同文（对象重叠 ${signals.overlap}，长度相近）`, signals };

    // —— 相关（适用条件可分辨 → 版本迁移/不同环境，不是矛盾）—— //
    if (fa.structured && fb.structured && fa.scope && fb.scope) {
        const sa = bigrams(fa.scope), sb = bigrams(fb.scope);
        const sInt = [...sa].filter((x) => sb.has(x)).length / Math.max(1, Math.min(sa.size, sb.size));
        signals.scopeOverlap = Number(sInt.toFixed(3));
        if (sInt < 0.3) return { relation: "related", reason: `适用范围不重叠（scopeOverlap=${signals.scopeOverlap}）→ 版本/环境差异，非直接矛盾`, signals };
    }

    // —— 兜底 —— //
    if (overlap >= 0.35) return { relation: "related", reason: `同主题（对象重叠 ${signals.overlap}），未见不相容信号`, signals };
    return { relation: "unknown", reason: `对象重叠仅 ${signals.overlap}，不足以判定关系（既不能判冲突，也不能判无冲突）`, signals };
}
