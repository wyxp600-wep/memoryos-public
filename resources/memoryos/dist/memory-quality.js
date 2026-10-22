import { annotateConflicts } from "./knowledge-quality.js";
/** 读取质量规则：仅筛选展示，不改写历史记忆，也不依靠引用次数判断真假。 */
export const KNOWLEDGE_TYPES = ["decision", "experience", "pitfall", "convention", "rule", "example"];

/** 保守去重：仅折叠空白，保持数字、否定词、标点、代码与大小写差异。 */
export function memoryContentKey(content) {
    const raw = String(content ?? "").replace(/\r\n?/g, "\n");
    // 代码中的空格、换行和缩进可能改变语义，不按普通文字折叠。
    return /`|(?:^|\n)[ \t]{2,}\S/u.test(raw) ? raw.trim() : raw.replace(/\s+/gu, " ").trim();
}
export function distinctMemories(rows, contentOf = (r) => r.content) {
    const seen = new Set();
    return rows.filter((r) => {
        const key = memoryContentKey(contentOf(r));
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function usableKnowledge(r, now = Date.now()) {
    return KNOWLEDGE_TYPES.includes(r.type) && r.status === "active" &&
        r.sensitivity !== "secret" && !r.superseded_by && !r.conflict_with && !(r.conflict_peers?.length) &&
        (!r.valid_from || Date.parse(r.valid_from) <= now) &&
        (!r.valid_until || Date.parse(r.valid_until) > now);
}

/** 无主题兜底：只取有效知识，包含 global；大小写别名在读取时兼容，不迁移数据。 */
export function generalContext(db, { project = "global", limit = 5 } = {}) {
    const rows = db.prepare(`SELECT m.id, m.content, m.type, m.agent, m.project, m.status, m.confidence, m.hit_count,
        m.created_at, m.valid_from, m.valid_until, m.conflict_with, m.superseded_by,
        m.sensitivity, m.pinned, m.salience, m.decay_lambda, m.last_seen_at, m.source_ref,
        (SELECT COUNT(*) FROM memory_usage u WHERE u.memory_id=m.id AND u.event='cited') cited,
        (SELECT COUNT(*) FROM memory_usage u WHERE u.memory_id=m.id AND u.event='returned') returned
        FROM memories m
        WHERE m.status='active' AND m.sensitivity != 'secret'
          AND m.project COLLATE NOCASE IN (?, 'global')
          AND m.type IN ('decision','experience','pitfall','convention','rule','example')
          AND m.superseded_by IS NULL AND m.conflict_with IS NULL
          AND (m.valid_from IS NULL OR julianday(m.valid_from)<=julianday('now'))
          AND (m.valid_until IS NULL OR julianday(m.valid_until)>julianday('now'))
        ORDER BY m.pinned DESC,
          CASE WHEN m.project COLLATE NOCASE = ? THEN 0 ELSE 1 END,
          m.created_at DESC, m.id DESC`).all(project, project);
    const now = Date.now();
    return distinctMemories(annotateConflicts(db, rows).filter((r) => {
        const days = Math.max(0, (now - Date.parse(r.last_seen_at ?? r.created_at)) / 86400000);
        const eff = r.pinned || r.type === "decision" ? r.salience : r.salience * Math.exp(-(r.decay_lambda ?? 0.01) * days);
        return usableKnowledge(r, now) && eff > 0.15;
    })).slice(0, limit);
}

/** 元信息与正文分开显示，提醒全文、历史状态、冲突和旧分数。 */
export function qualitySuffix(r, cap = Infinity) {
    const notes = [];
    if (cap === 120 && r.created_at) notes.push(`创建=${String(r.created_at).slice(0, 10)}`);
    if (String(r.content ?? "").replace(/\s+/gu, " ").length > cap)
        notes.push(`摘要已截断，请 memory_read #${r.id} 核对全文`);
    if (/当前会话|当前工作区|当前环境|当前仅|尚未部署|尚未集成/u.test(r.content ?? ""))
        notes.push("历史状态快照，使用前核验当前环境");
    if (r.conflict_peers?.length) notes.push(`未决冲突组：${r.conflict_peers.map(id => "#"+id).join("、")}；不能据此作为确定结论`);
    else if (r.conflict_with) notes.push(`与 #${r.conflict_with} 存在未决冲突`);
    if (r.superseded_by) notes.push(`已被 #${r.superseded_by} 替代`);
    if (r.valid_from) notes.push(`生效=${r.valid_from}`);
    if (r.valid_until) notes.push(`到期=${r.valid_until}`);
    if (r.source_ref && !String(r.source_ref).startsWith("card:")) notes.push(`来源=${r.source_ref}`);
    if (Number(r.confidence) > 1 || Number(r.confidence) < 0) notes.push("历史置信评分越界，不是准确概率");
    return notes.length ? ` 【${notes.join("；")}】` : "";
}
