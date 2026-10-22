export const REPORT_NAMES = ["funnel", "trend", "top", "zombies", "cross_tool", "outcomes", "eval", "graph"];
function scope(p, alias) {
    return p ? (p.trim() === "" ? "" : ` AND ${alias}.project = '${p.replace(/'/g, "''")}'`) : "";
}
// T 格式(ISO) vs 空格(datetime()) 字符串比较不可靠 → 一律用 julianday 数值比较
const DAYS_OF_LAST = (days) => `julianday(u.created_at) >= julianday('now', '-${days} days')`;
/** 漏斗：write / returned(去重 memory) / raw-cited / inferred-cited。x = write - 采用 */
export function funnel(db, p) {
    const sc = scope(p.project, "u");
    const scR = scope(p.project, "r"); // inferred 子查询别名是 r
    const write = db.prepare(`SELECT COUNT(*) c FROM memory_usage u WHERE u.event='write'${sc}`).get().c;
    const returned = db
        .prepare(`SELECT COUNT(DISTINCT u.memory_id) c FROM memory_usage u WHERE u.event='returned'${sc}`)
        .get().c;
    const rawCited = db.prepare(`SELECT COUNT(*) c FROM memory_usage u WHERE u.event='cited'${sc}`).get().c;
    // inferred-cited：同 session 内(同项目)该记忆 returned 后又发生 write
    // ★ 2026-09-15 修正：原判据 `w.created_at > r.created_at` 是**字符串比较**，同毫秒并列即漏计
    //   （实测同一代码约 1/3 次运行 inferred=0 → cite 冒烟间歇失败）。本文件第 5 行已写明
    //   「字符串比较不可靠 → 一律用 julianday」，此处漏改。改为按**追加式主键**比较：
    //   memory_usage.id 是 AUTOINCREMENT，插入序即事件序（归档表 memory_usage_archive 亦保留 id），
    //   杜绝时间戳并列歧义。语义不变：仍是"returned 之后发生了 write"。
    const inferred = db
        .prepare(`SELECT COUNT(DISTINCT r.memory_id) c
         FROM memory_usage r
         JOIN memory_usage w
           ON w.event='write' AND w.session_id = r.session_id AND w.project = r.project
            AND w.id > r.id
         WHERE r.event='returned'${scR}`)
        .get().c;
    const adopted = rawCited + inferred; // 采用 = raw + inferred（近似）
    return [
        { name: "write", event: "write", value: write },
        { name: "returned(去重memory)", event: "returned", value: returned },
        { name: "raw_cited", event: "cited", value: rawCited },
        { name: "inferred_cited", event: "inferred", value: inferred },
        { name: "adopted(≈采用,raw+inferred)", event: "adopted", value: adopted },
        { name: "x(未被采用,write-adopted)", event: "x", value: Math.max(0, write - adopted) },
    ];
}
/** 趋势：每日 w/r/c 三线（近 days 天，默认 14） */
export function trend(db, p) {
    const sc = scope(p.project, "u");
    const rows = db
        .prepare(`SELECT substr(u.created_at,1,10) day,
              SUM(u.event='write') write,
              SUM(u.event='returned') returned,
              SUM(u.event='cited') cited
       FROM memory_usage u
       WHERE ${DAYS_OF_LAST(p.days ?? 14)}${sc}
       GROUP BY substr(u.created_at,1,10) ORDER BY day`)
        .all();
    return rows;
}
/** 高价值 Top N：cited → returned → hit_count → confidence 加权排序（仅 active） */
export function topMemories(db, p) {
    const sc = scope(p.project, "u"); // 子查询别名 u
    const scM = scope(p.project, "m"); // 主查询别名 m
    const rows = db
        .prepare(`SELECT m.id, m.content, m.type, m.agent, m.confidence, m.hit_count,
              (SELECT COUNT(*) FROM memory_usage u WHERE u.memory_id=m.id AND u.event='cited'${sc}) cited,
              (SELECT COUNT(*) FROM memory_usage u WHERE u.memory_id=m.id AND u.event='returned'${sc}) returned
       FROM memories m
       WHERE m.status='active'${scM}
       ORDER BY cited DESC, returned DESC, m.hit_count DESC, m.confidence DESC
       LIMIT ?`)
        .all(p.limit ?? 10);
    return rows;
}
/** 待归档（僵尸）：active 但创建超 days 天仍 0 命中 */
export function zombies(db, p) {
    const sc = scope(p.project, "u");
    const rows = db
        .prepare(`SELECT id, content, type, agent, created_at,
              CAST(julianday('now') - julianday(created_at) AS INTEGER) days
       FROM memories m
       WHERE m.status='active' AND m.hit_count=0
         AND julianday(m.created_at) < julianday('now', ?)
         AND NOT EXISTS (SELECT 1 FROM memory_usage u WHERE u.memory_id=m.id AND u.event='returned'${sc})
       ORDER BY m.created_at ASC LIMIT ?`)
        .all(`-${p.days ?? 90} days`, p.limit ?? 10);
    return rows;
}
/** 跨工具复用：returned/cited 且 reader≠writer 的事件 */
export function crossTool(db, p) {
    const sc = scope(p.project, "u");
    const rows = db
        .prepare(`SELECT writer_agent, reader_agent, event, COUNT(*) n
       FROM memory_usage u
       WHERE u.event IN ('returned','cited') AND u.reader_agent IS NOT NULL
         AND u.writer_agent IS NOT NULL AND u.reader_agent != u.writer_agent${sc}
       GROUP BY writer_agent, reader_agent, event ORDER BY n DESC LIMIT ?`)
        .all(p.limit ?? 20);
    return rows;
}
/** 使用侧健康（P2 效果监控）：触发率/空召回/写读比/各 agent 使用漏斗，诊断「只写不搜」。 */
export function usageHealth(db, days = 30) {
    const since = days > 0 ? `created_at >= datetime('now', '-${days} days')` : "1=1";
    const cv = (v) => Number(v ?? 0);
    const search = cv(db.prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event='search' AND ${since}`).get()?.c);
    const write = cv(db.prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event='write' AND ${since}`).get()?.c);
    const returned = cv(db.prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event='returned' AND ${since}`).get()?.c);
    const cited = cv(db.prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event='cited' AND ${since}`).get()?.c);
    const distinctReturned = cv(db.prepare(`SELECT COUNT(DISTINCT memory_id) c FROM memory_usage WHERE event='returned' AND ${since}`).get()?.c);
    // 触发率 = 搜索次数/沉淀次数；<1 → 沉淀多于检索 = 只写不搜信号
    const search_trigger_rate = write > 0 ? Math.min(9, Math.round((search / write) * 100) / 100) : 0;
    // 空召回 ≈ 返回的不同记忆条数 < 搜索次数 的差距占比（粗指标；search 多、去重后 returned 少即空召回多）
    const empty_recall_rate = search > 0
        ? Math.max(0, Math.min(1, Math.round(((search - Math.min(search, distinctReturned)) / search) * 1000) / 1000))
        : 0;
    const write_read_ratio = returned > 0 ? Math.round((write / returned) * 100) / 100 : 0;
    const per_agent = db
        .prepare(`SELECT reader_agent agent,
              SUM(event='search') search,
              SUM(event='returned') returned,
              SUM(event='cited') cited,
              SUM(event='write') write
       FROM memory_usage WHERE ${since} AND reader_agent IS NOT NULL
       GROUP BY reader_agent ORDER BY search DESC, returned DESC`)
        .all();
    return { search, returned, write, cited, search_trigger_rate, empty_recall_rate, write_read_ratio, per_agent };
}
/**
 * ★ 2026-10-02（P1-9，对标 Orca AI Vault 的 status）：索引侧健康。
 * 与 usageHealth（回答「有没有在用」）互补，本函数回答「索引全不全」——召回变差时用来区分
 *   「确实没有这条」与「索引没跟上 / 索引坏了」。
 * 口径：向量以 memory_vectors 为权威（memories.embedding 已由 migrateVectorsSplit 搬离并置空）；
 *   stale = 正文改过但向量未跟（updateMemory 置位，daemon 限量重算）。
 * 纯读、零建表、不改 schema → 不影响 /api/health 基线哈希。
 * 注：schema 未记录「上次重建时间 / 索引代数」，故不报（不编造）。
 */
export function indexHealth(db) {
    const cv = (v) => Number(v ?? 0);
    const total = cv(db.prepare(`SELECT COUNT(*) c FROM memories`).get()?.c);
    const active = cv(db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active'`).get()?.c);
    const withVec = cv(db
        .prepare(`SELECT COUNT(*) c FROM memories m JOIN memory_vectors v ON v.memory_id = m.id WHERE m.status='active'`)
        .get()?.c);
    const stale = cv(db.prepare(`SELECT COUNT(*) c FROM memories WHERE embedding_stale=1`).get()?.c);
    // FTS 行数与 memories 行数应一致；不等 = 触发器漏同步（幽灵结果 / 漏召回）
    const ftsRows = cv(db.prepare(`SELECT COUNT(*) c FROM memories_fts`).get()?.c);
    // gram 覆盖：只算 memory_id 仍存在的。gram 表无删除触发器（由 syncGrams 手动维护，
    //   见 db.js「先删后插」注释），记忆被删时可能留下「孤儿残留」—— 单独计数暴露，不混进覆盖率。
    const gramMem = cv(db
        .prepare(`SELECT COUNT(DISTINCT g.memory_id) c FROM memories_gram g JOIN memories m ON m.id = g.memory_id`)
        .get()?.c);
    const gramOrphan = cv(db
        .prepare(`SELECT COUNT(DISTINCT g.memory_id) c FROM memories_gram g LEFT JOIN memories m ON m.id = g.memory_id WHERE m.id IS NULL`)
        .get()?.c);
    return {
        total,
        active,
        withVec,
        vecMissing: Math.max(0, active - withVec),
        vecCoverage: active > 0 ? Math.round((withVec / active) * 1000) / 1000 : 1,
        stale,
        ftsRows,
        ftsDrift: total - ftsRows,
        gramMem,
        gramOrphan,
        gramCoverage: total > 0 ? Math.round((gramMem / total) * 1000) / 1000 : 1,
    };
}

/**
 * ★ P0-B（2026-10-13）：记忆任务效果关联——每条记忆的 success/failed/unverified 计数 + 成功率。
 * 数据源：memory_task_outcomes 表（task_done 事务内写入）。
 * underperforming：曝光 ≥5 次且成功率 <20% 的记忆 → daemon 降权候选。
 */
export function outcomes(db, p) {
    const scM = scope(p.project, "m");
    const rows = db
        .prepare(`SELECT m.id, m.content, m.type, m.agent,
              (SELECT COUNT(*) FROM memory_task_outcomes o WHERE o.memory_id=m.id AND o.outcome='success') success,
              (SELECT COUNT(*) FROM memory_task_outcomes o WHERE o.memory_id=m.id AND o.outcome='failed') failed,
              (SELECT COUNT(*) FROM memory_task_outcomes o WHERE o.memory_id=m.id AND o.outcome='unverified') unverified,
              (SELECT COUNT(*) FROM memory_task_outcomes o WHERE o.memory_id=m.id) total
       FROM memories m
       WHERE m.status='active' AND EXISTS (SELECT 1 FROM memory_task_outcomes o WHERE o.memory_id=m.id)${scM}
       ORDER BY total DESC LIMIT ?`)
        .all(p.limit ?? 20);
    const withRate = rows.map((r) => {
        const total = r.success + r.failed;
        const rate = total > 0 ? Math.round((r.success / total) * 100) / 100 : null;
        return { ...r, success_rate: rate, underperforming: total >= 5 && rate !== null && rate < 0.2 };
    });
    return withRate;
}

/**
 * ★ P1-C（2026-10-13）：图谱健康——memory→memory 关系（graph-distill 蒸馏产物）的统计。
 * 口径：links 表 src_kind=dst_kind='memory' 的关系边；连通度 = 有关系边的记忆占 active 总数比例；
 *   孤立节点 = 无任何 memory→memory 边的 active 记忆。conflicts 单列（供仲裁消费）。
 * 纯读，零写库。
 */
export function graphHealth(db, p) {
    const cv = (v) => Number(v ?? 0);
    const active = cv(db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active'`).get()?.c);
    const edgeCount = cv(db
        .prepare(`SELECT COUNT(*) c FROM links WHERE src_kind='memory' AND dst_kind='memory'`)
        .get()?.c);
    const byKind = db
        .prepare(`SELECT kind, COUNT(*) c FROM links WHERE src_kind='memory' AND dst_kind='memory'
                  GROUP BY kind ORDER BY c DESC`)
        .all();
    // 端点去重：与至少一条边相连的 distinct memory 端点
    const connected = cv(db
        .prepare(`SELECT COUNT(DISTINCT x.id) c FROM (
                    SELECT src_id AS id FROM links WHERE src_kind='memory' AND dst_kind='memory'
                    UNION
                    SELECT dst_id AS id FROM links WHERE src_kind='memory' AND dst_kind='memory'
                  ) x JOIN memories m ON m.id = x.id AND m.status='active'`)
        .get()?.c);
    const conflicts = byKind.find((k) => k.kind === "conflicts")?.c ?? 0;
    const sample = db
        .prepare(`SELECT l.src_id, m1.content s1, l.dst_id, m2.content s2, l.kind, l.anchor
           FROM links l
           JOIN memories m1 ON m1.id = l.src_id AND m1.status='active'
           JOIN memories m2 ON m2.id = l.dst_id AND m2.status='active'
           WHERE l.src_kind='memory' AND l.dst_kind='memory'
           ORDER BY l.created_at DESC LIMIT ?`)
        .all(p.limit ?? 10);
    return {
        active,
        edgeCount,
        by_kind: byKind,
        connected,
        coverage: active > 0 ? Math.round((connected / active) * 1000) / 1000 : 0, // 连通度
        isolated: Math.max(0, active - connected),
        conflicts,
        sample,
    };
}
