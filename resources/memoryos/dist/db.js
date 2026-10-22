/**
 * MemoryOS v0.1 → v0.2 — db 层（node:sqlite，零原生依赖）
 * SQLite(WAL) + FTS5 trigram + AFTER INSERT 触发器 + scope 隔离。
 * v0.2 增：status/confidence/hit_count/last_hit_at/embedding(BLOB) + 去重/冲突预检。
 * 引擎约束（实证）：node:sqlite 禁 load_extension → 向量用 BLOB 存 + JS 余弦，见 V5.1 R2 实现说明。
 */
import { installKeywordIndex } from "./memory-keywords.js";
import { installCheckpointStore } from "./task-checkpoints.js";
import { installMemoryBodyGuard } from "./memory-body.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { vecToBuf, bufToVec, cosine } from "./embed.js";
import { IvfAnnIndex } from "./ann.js"; // ★ P0-ANN：进程内 IVF-Flat ANN 索引（纯 JS，零额外依赖）
import { classifyRelation } from "./proposition.js"; // ★ 收尾 P2：命题关系判定（纯函数，零依赖）
const BASE_COLUMNS = "id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence, conflict_with, superseded_by, derived_from, hit_count, last_hit_at, created_at, sector, form, salience, decay_lambda, last_seen_at, valid_from, valid_until, trigger_cond, trigger_kind, trigger_action, valence, arousal, source_ref, sensitivity, pinned, version, fencing_token, epoch, idempotency_key, causal_parent, inject, source";
function joinPrefix(s) {
    return s ? `[${s.replace(/"/g, '""')}]` : "";
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  type        TEXT    NOT NULL DEFAULT 'experience',
  agent       TEXT    NOT NULL,
  agent_fpath TEXT,
  project     TEXT    NOT NULL DEFAULT 'global',
  status      TEXT    NOT NULL DEFAULT 'active',     -- active/merged/superseded/rejected/archived
  confidence  REAL    NOT NULL DEFAULT 0.8,
  eff_confidence REAL,                              -- v0.3 衰减后有效置信（daemon 维护）；NULL=未衰减
  conflict_with INTEGER,                            -- v0.3 疑似冲突指向的旧记忆 id
  superseded_by INTEGER,                            -- v0.3 被哪条取代（去重/仲裁）
  derived_from  INTEGER,                            -- v0.3 溯源
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  embedding   BLOB,                                  -- float32[]（v0.2 向量 / 语义路）
  -- ★ P1-2.4：正文被编辑后置 1，表示 embedding 已与正文语义脱节，待 daemon 重算。
  -- 为什么需要它：编辑不重算向量时，语义检索会命中「与正文不符」的记忆 —— 比搜不到更糟。
  embedding_stale INTEGER NOT NULL DEFAULT 0,
  sensitivity   TEXT NOT NULL DEFAULT 'normal',
  -- ★ 批次⑦X2（2026-09-23）：规则强制注入开关 —— 1=除 8 条内置门禁外还注入本条（规则页可切换，变更后自动同步注入段）
  inject  INTEGER NOT NULL DEFAULT 0,
  -- ★ 2026-10-14（③ 记忆来源标签）：来源三名 —— human=人直接写（看板/人工编辑）、agent=AI 工具写入、ingest=外部采集（文件/笔记导入）。
  --   与 agent 正交：agent 记「哪个工具写的」，source 记「谁担保」。规则反思候选只取 human ∪ pinned
  --   （见 rule-reflection.js）—— 即「外部内容不得自动升格为所有 agent 的常驻指令」的判据列。
  source  TEXT    NOT NULL DEFAULT 'agent',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_status_eff ON memories(status, eff_confidence);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  project UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, project) VALUES (new.id, new.content, new.project);
END;
-- ★ P0-3.1：补齐 UPDATE/DELETE 同步。原先只有 AFTER INSERT 触发器：
--   · UPDATE 依赖 updateMemory() 内手动同步 —— 任何绕过它的 UPDATE 都会让 FTS 与正文脱节；
--   · DELETE 完全无人同步 —— FTS 残留脏行，产生"幽灵搜索结果"（能搜到但读不到正文）。
--   content/project 是 FTS 的参与列，故用 OF 限定，避免 type/status 等更新触发无谓的索引写。
CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE OF content, project ON memories BEGIN
  UPDATE memories_fts SET content = new.content, project = new.project WHERE rowid = new.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
END;

-- ★ v0.3 治理：daemon/人工归档/仲裁的审计留痕
CREATE TABLE IF NOT EXISTS daemon_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task        TEXT    NOT NULL,                   -- decay / archive / dedupe / arbitrate / manual-archive
  op          TEXT    NOT NULL,                   -- eff_update / archive / unarchive / merge / supersede / reject
  memory_id   INTEGER,
  detail      TEXT,                               -- 变更理由/前后值要点
  operator    TEXT    NOT NULL DEFAULT 'daemon',  -- daemon 或 human:dashboard / human:arbitrate
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_daemon_log_mem ON daemon_log(memory_id);

-- ★ v0.3 仲裁事件表（M-2.4）：before 快照 + undone 标记，撤销与审计的基础
CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER,                              -- 被仲裁/操作的主记忆 id
  op          TEXT    NOT NULL,                     -- possible-conflict / keep_new / keep_old / merge / no_conflict / undo
  payload     TEXT,                                 -- before 快照 JSON（裁决前双方行状态，供 u 还原）
  operator    TEXT    NOT NULL DEFAULT 'human:arbitrate',
  undone      INTEGER NOT NULL DEFAULT 0,           -- 1=已撤销
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_events_mem ON memory_events(memory_id);

-- ★ 使用埋点表（价值度量基础，M-1.5）
-- event: write / returned / cited；reader_agent≠writer_agent → 跨工具复用（cross-tool）
CREATE TABLE IF NOT EXISTS memory_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     INTEGER NOT NULL,
  event         TEXT    NOT NULL,              -- write / returned / cited
  reader_agent  TEXT,                          -- 消费方（returned/cited；write 时=写入方）
  writer_agent  TEXT,                          -- 写入方
  project       TEXT    NOT NULL DEFAULT 'global',
  session_id    TEXT,                          -- 会话标识（inferred-cited 判定基础）
  task_hint     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON memory_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_memory  ON memory_usage(memory_id);
CREATE INDEX IF NOT EXISTS idx_usage_event   ON memory_usage(event);

-- ★ v0.3 治理规则配置（M-记忆卫生）：KEY→JSON。缺省走代码内默认，本表存在即覆盖
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ★ 采集增量水位（M-采集自动化）：记录每个源文件的 (size, mtime)，
-- 下一轮只处理「变了」的文件 → 让定时采集的空跑成本降到 stat 级（几十 ms）。
CREATE TABLE IF NOT EXISTS ingest_state (
  path       TEXT PRIMARY KEY,                    -- 源文件绝对路径
  size       INTEGER NOT NULL DEFAULT 0,
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  last_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_state_last ON ingest_state(last_at);

-- ★ P1-2.3 索引补齐（依据 EXPLAIN QUERY PLAN 实测，而非猜测）
-- 诊断结论：多数报表查询（write/returned/Top/僵尸/跨工具）已由 idx_usage_event 覆盖，
-- 实测真正的全表扫描只有下面两处，故只补这两个（避免无证据的索引膨胀拖慢写入）：
--   ① 按 agent 统计 GROUP BY agent            → SCAN memories
--   ② trend 按日分组（仅时间条件，无 event）  → SCAN memory_usage
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
CREATE INDEX IF NOT EXISTS idx_usage_created ON memory_usage(created_at);
--   ③ 候选池 SELECT ... WHERE status='active' AND project IN (...)：
--      原走 idx_memories_status_eff(status) 只定位到 status，再逐行过滤 project；
--      建复合后计划变为 (status=? AND project=?) 两级定位，实测被查询规划器选中。
--   ④ 保留 idx_memories_project 不删：复合索引最左前缀是 status，
--      无法服务「只按 project 过滤」的查询（如 getVectorsOnProject 的 activeOnly=false 路径）。
--   ⑤ 不建 memory_usage(reader_agent)：漏斗查询已被 idx_usage_created 覆盖，实测无收益。
CREATE INDEX IF NOT EXISTS idx_memories_status_project ON memories(status, project);

-- ★ P1-2.2 向量独立表。
-- 背景：embedding 原为 memories 表的 BLOB 列（1024 维 float32 ≈ 4KB/行），
--   导致：① memories 行宽膨胀；② 任何 SELECT/全表扫都拖带 BLOB（即便只需正文）；
--   ③ VACUUM 与备份效率下降。
-- 拆表后：正文表瘦身，读正文不再触碰向量；向量仅在语义检索/去重路径按需读取。
-- 迁移见 openDb 内的 migrateVectorsSplit（事务内、幂等、以 config 标记防重复）。
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id INTEGER PRIMARY KEY,
  embedding BLOB    NOT NULL,
  -- ★ 2026-10-15：向量带出处（架构改进第一档①）——防跨模型向量混比导致的静默失真
  embed_model TEXT  NOT NULL DEFAULT 'unknown',
  dim         INTEGER NOT NULL DEFAULT 0
);

-- ★ P0-3.4 CJK 2-gram 倒排索引（修复中文检索全表扫）
-- 背景：memories_fts 用 trigram 分词，对 <3 字符（尤其中文 2 字词）不产 token，
--   导致中文查询一直落到 content LIKE '%q%' —— 前导通配符使索引完全失效，
--   每次中文检索都全表扫描（实测中文正是主要使用场景）。
-- 方案：写入时把正文中「相邻两个 CJK 字符」切为 gram 存入本表；
--   检索时先用 gram 精确点查把候选集收窄，再用 LIKE 精筛。
--   正确性：bigram 命中是「子串命中」的必要条件（content 含 "缓存" 则必含 bigram "缓存"），
--   故索引收窄不会漏召回，LIKE 精筛保证子串语义精确。
--   无 CJK 的正文写入空串哨兵，用于标记「已同步但无 gram」，避免每次启动重复回填。
CREATE TABLE IF NOT EXISTS memories_gram (
  gram      TEXT    NOT NULL,
  memory_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gram_lookup ON memories_gram(gram, memory_id);
-- ★ 2026-10-15 启动性能修复：补 memory_id 单列索引。
--   根因（EXPLAIN QUERY PLAN 实证）：openDb 的 gram 回填候选判定
--   「WHERE NOT EXISTS (SELECT 1 FROM memories_gram g WHERE g.memory_id = m.id) LIMIT 200」
--   只有 (gram, memory_id) 联合索引时子查询退化为 SCAN g 全表扫——2554 条记忆
--   每条全表扫 214k 行 gram ≈ 5.5~7.9s，把每次启动（dashboard 与 daemon 各一次）
--   的 openDb 整个堵死。补本索引后子查询走索引点查，同查询 7917ms → 6ms。
CREATE INDEX IF NOT EXISTS idx_gram_memory ON memories_gram(memory_id);

-- ★ v0.4 记忆类别（10 sector）+ 统一链接图 + 卡片看板
-- 设计依据：OpenMemory HMD 认知分层（sector + λ 衰减 + 权重）、A2A Task 模型、
--   Hermes Kanban（CAS 认领 / lease / 熔断 / 事件流）、Obsidian wikilink 规范。
-- 全部为「附加」结构：旧代码 SELECT 指定列不受影响，可回退。

-- 注：memories 的 sector/valid_until/pinned 索引不在此处建 —— SCHEMA 先于 ALTER TABLE 执行，
--     此时新列尚不存在，建索引会抛 "no such column"。故移至 openDb 的加列之后。

-- 笔记镜像（vault 笔记 + 用户自建笔记统一存放；links 的 note 节点来源）
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_root TEXT    NOT NULL,
  rel_path   TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  aliases    TEXT,
  tags       TEXT,
  sector     TEXT,
  body       TEXT    NOT NULL,
  hash       TEXT    NOT NULL,
  memory_id  INTEGER,
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  origin     TEXT    NOT NULL DEFAULT 'vault',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  UNIQUE(vault_root, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
CREATE INDEX IF NOT EXISTS idx_notes_mem   ON notes(memory_id);

-- 统一链接图：note / memory / card 三类节点共用（双向链接 + 卡片互联同一套存储）
-- vault_root：M12 多 vault 隔离 —— 链接解析/回填一律限定在源笔记所属 vault 域内，
--   杜绝 A vault 的 [[X]] 错解到 B vault 同名笔记。memory/card 源时可为空。
CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_root TEXT,
  src_kind   TEXT NOT NULL,
  src_id     INTEGER NOT NULL,
  dst_kind   TEXT NOT NULL,
  dst_id     INTEGER,
  dst_title  TEXT,
  kind       TEXT NOT NULL,
  anchor     TEXT,
  alias      TEXT,
  context    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_links_src   ON links(src_kind, src_id);
CREATE INDEX IF NOT EXISTS idx_links_dst   ON links(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS idx_links_title ON links(dst_title);
CREATE INDEX IF NOT EXISTS idx_links_vault ON links(vault_root);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_uniq ON links(
  src_kind, src_id, kind, IFNULL(dst_id, -1), IFNULL(dst_title, ''), IFNULL(anchor, ''), IFNULL(alias, '')
);

-- 卡片看板（权威存储；任务 = 卡片的一种 kind）
CREATE TABLE IF NOT EXISTS cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  board          TEXT    NOT NULL DEFAULT 'default',
  kind           TEXT    NOT NULL DEFAULT 'task',
  title          TEXT    NOT NULL,
  body           TEXT,
  status         TEXT    NOT NULL DEFAULT 'triage',
  assignee       TEXT,
  lane           TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  claim_lock     TEXT,
  lease_expires_at TEXT,
  heartbeat_at   TEXT,
  workspace      TEXT,
  workspace_kind TEXT    DEFAULT 'scratch',
  ref_kind       TEXT,
  ref_id         INTEGER,
  meta           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_board_status ON cards(board, status);
CREATE INDEX IF NOT EXISTS idx_cards_assignee     ON cards(assignee);
CREATE INDEX IF NOT EXISTS idx_cards_lease        ON cards(lease_expires_at);

-- ★ H1（R4 裁决）：废弃独立 card_links 表 —— 卡片互链统一写入 links（src_kind='card'），
--   单一存储单一写路径；"强制 card 类型"约束改由 /api/cards/:id/links 应用层校验。
-- ★ H2（R4 裁决）：working 记忆独立成表（随会话生命周期建立/销毁），不进 memories ——
--   否则 working 行只做软衰减、永远留在库里，会话结束即变僵尸。
CREATE TABLE IF NOT EXISTS working_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,                -- 注入隔离的唯一键
  key         TEXT,                            -- 会话内逻辑键（upsert 用，如 "tool:last_result"）
  kind        TEXT    NOT NULL DEFAULT 'note', -- note / tool_result / task_state / context
  content     TEXT    NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT,
  UNIQUE(session_id, key)
);
CREATE INDEX IF NOT EXISTS idx_working_session ON working_memory(session_id);

CREATE TABLE IF NOT EXISTS card_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_card_events_card ON card_events(card_id);

CREATE TABLE IF NOT EXISTS card_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL,
  author       TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  ref_card_ids TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_card_comments_card ON card_comments(card_id);

CREATE TABLE IF NOT EXISTS card_memory (
  card_id    INTEGER NOT NULL,
  memory_id  INTEGER NOT NULL,
  relation   TEXT    NOT NULL DEFAULT 'context',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (card_id, memory_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_card_memory_mem ON card_memory(memory_id);

-- ★ 2026-10-02 Dispatch 语义（对标 orca orchestration「one authoritative Task attempt」）：
--   把「谁有权改这个任务」从散落的 memories.version / cards.claim_lock / session_id / 任务头，
--   收敛为一个显式实体。权威**只**来自 active dispatch——任务头 / 卡片 / DB 行都不能单独授权写。
--   idx_dispatches_active 与 idx_resource_locks_active 同构：机器保证「一任务同时只有一个 active 尝试」。
CREATE TABLE IF NOT EXISTS dispatches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_key     TEXT    NOT NULL UNIQUE,           -- 对外句柄（纯 hex，与 lease_token 同值同形态）；取代「查不出持有者的裸锁」
  memory_id        INTEGER NOT NULL,                  -- 关联任务
  agent            TEXT    NOT NULL,                  -- 持有者（AGENT_NAME_RE 口径）
  session_id       TEXT,                              -- 会话隔离（原问题 #7：同 agent 名多会话串号）
  credential_id    INTEGER,                           -- A1 凭据追溯
  state            TEXT    NOT NULL DEFAULT 'active', -- active/settled/released/superseded/stale
  generation       INTEGER NOT NULL DEFAULT 1,        -- 尝试世代（仅接管/换代 +1）；与 memories.version 分工不同
  outcome          TEXT,                              -- succeeded/failed（结算必填，orca 口径：禁止只在散文里编码失败）
  evidence         TEXT,                              -- 结构化终态 JSON（回执）
  lease_expires_at TEXT    NOT NULL,
  heartbeat_at     TEXT,
  started_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at       TEXT,
  superseded_by    INTEGER                            -- 被哪次 dispatch 取代
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatches_active ON dispatches(memory_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS idx_dispatches_agent ON dispatches(agent, state);
CREATE INDEX IF NOT EXISTS idx_dispatches_lease ON dispatches(lease_expires_at) WHERE state='active';

-- ═══ 节点画布（P0，2026-10-04）：类型注册表 / 卡片边 / 智能体档案（只增不改，drop 即回滚）═══
-- 卡片类型注册表：内置四种种子不可改删；连线方向校验按四个端口行为档位判定（先建卡后选型交互的必需件）
CREATE TABLE IF NOT EXISTS card_types (
  type_key         TEXT PRIMARY KEY,               -- 'task'|'agent'|'handoff'|'doc'|'aux' + 自定义（禁 aux 前缀）
  label            TEXT NOT NULL,                  -- 显示名
  color            TEXT,                           -- 徽标色
  builtin          INTEGER NOT NULL DEFAULT 0,     -- 内置类型不可改删
  can_dispatch_out INTEGER NOT NULL DEFAULT 0,     -- 可发起派发边
  can_dispatch_in  INTEGER NOT NULL DEFAULT 0,     -- 可接收派发边
  can_inject_out   INTEGER NOT NULL DEFAULT 0,     -- 可发起前情注入边
  can_inject_in    INTEGER NOT NULL DEFAULT 0,     -- 可接收前情注入边
  meta             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO card_types(type_key,label,builtin,can_dispatch_out,can_dispatch_in,can_inject_out,can_inject_in) VALUES
  ('task','任务',1,1,0,0,1),
  ('agent','智能体',1,0,1,0,0),
  ('handoff','交接文档',1,0,0,1,0),
  ('doc','文档',1,0,0,0,0),
  -- ★ 2026-10-06 修复（L-09 致命）：右键菜单 5 个「📎挂相关项目/用户记忆/规则定义/
  --   Skill 技能/历史错误」走 POST /api/cards {kind:'aux'}，但本表**从未注册 aux**
  --   → dashboard-reg-cards.js:648-650 以「未知卡片类型：aux」400 拒绝 → 5 类辅助卡全部无法创建，
  --   卫星卡体系实为空壳。aux 此前被注释标为「禁前缀」而未落种子，这里补上正式注册。
  --   注：aux 卡仍**不能**作 depends 前置（后端 :1044-1052 白名单只含 task/handoff），
  --   它只作为宿主卡的附属说明卡存在。
  ('aux','辅助卡',1,0,0,0,0);

-- 智能体档案：纯配置实体（无位置无状态）——Agent 卡 = cards.kind='agent' 投影卡 + meta.profile_id 指向此表
CREATE TABLE IF NOT EXISTS agent_profiles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,                  -- 卡片显示名
  agent_key        TEXT,                           -- scanAgents() id；NULL=待选
  channel          TEXT NOT NULL DEFAULT 'queue',  -- 'cli'|'cdp'|'queue'（探测定档；UIA 仅作 CDP 内部兜底，不设独立通道）
  workspace        TEXT,                           -- 工作区绝对路径
  model            TEXT,                           -- 模型名
  context_tokens   INTEGER,                        -- 上下文配置
  reasoning        TEXT,                           -- 推理强度（按 agent 枚举）
  concurrency      INTEGER NOT NULL DEFAULT 1,     -- 串行队列上限（仅约束直控/驾驶通道）
  launch_overrides TEXT,                           -- JSON：启动参数模板 / CDP 选择器热修描述
  meta             TEXT,                           -- carrier_missing 等对账标记
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_key ON agent_profiles(agent_key);

-- 卡片边：派发边（任务→智能体，锚定工作证，换代链可审计）与前情注入边（交接→任务）
-- status 为纯投影字段（真源在 dispatches），边表永不参与对账裁决
CREATE TABLE IF NOT EXISTS card_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL,                    -- cards.id
  target_id   INTEGER NOT NULL,                    -- cards.id
  kind        TEXT NOT NULL CHECK (kind IN ('dispatch','inject')),
  dispatch_id INTEGER,                             -- kind='dispatch' 时锚定 dispatches.id
  status      TEXT NOT NULL DEFAULT 'active',      -- active|superseded|completed|cancelled
  meta        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_card_edges_source ON card_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_card_edges_target ON card_edges(target_id);
-- 同一任务卡→同一智能体卡同时最多一条 active 派发边（幂等连线）
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_edges_active_dispatch ON card_edges(source_id, target_id) WHERE kind='dispatch' AND status='active';
-- 同一交接文档对同一任务卡最多注入一次
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_edges_inject ON card_edges(source_id, target_id) WHERE kind='inject';

-- ★ R4-1（第四轮评审）：长期治理保留策略归档目标表（只归档不删除，对齐 v1.1 纪律）
CREATE TABLE IF NOT EXISTS card_events_archive (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_events_archive_ts ON card_events_archive(created_at);

CREATE TABLE IF NOT EXISTS memory_usage_archive (
  id           INTEGER PRIMARY KEY,
  memory_id    INTEGER NOT NULL,
  event        TEXT    NOT NULL,
  reader_agent TEXT,
  writer_agent TEXT,
  project      TEXT NOT NULL DEFAULT 'global',
  session_id   TEXT,
  task_hint    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_archive_ts ON memory_usage_archive(created_at);

-- ★ P0 执行面：工具调用审计（append-only）。任何执行类工具的每次调用都留痕，
--   审批结论（auto / preauth / gate-allowed / gate-denied / off）在此可查 —— B1 的审计证据链。
--   纪律：args_digest / detail 由调用方截断后写入，**绝不写入凭据或大文本全文**（大输出走 artifact 文件）。
CREATE TABLE IF NOT EXISTS exec_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT    NOT NULL,                   -- file_read / file_write / exec_run ...
  agent       TEXT    NOT NULL DEFAULT 'unknown',
  risk        TEXT    NOT NULL DEFAULT '',        -- L0..L4
  approval    TEXT    NOT NULL DEFAULT 'auto',    -- auto / preauth / gate-allowed / gate-denied / off
  args_digest TEXT,                               -- 参数摘要（已截断）
  detail      TEXT,                               -- 结果/错误摘要（已截断）
  duration_ms INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exec_audit_agent_ts ON exec_audit(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_audit_tool_ts  ON exec_audit(tool, created_at);

-- ★ 2026-10-14（方案 B · 服务端挂起审批）：exec_run 高风险命令的待批队列。
--   为什么另建表而不复用 exec_audit：audit 是 append-only 流水；本表需要**可变状态**（pending →
--   approved/denied/expired/executed）承载「谁在什么时候批了这一条」与执行结果摘要。
--   语义：AI 发起高风险命令 → 落 pending 并挂起等待 → 人在看板点同意才执行；无人处理则到期自动作废
--   （按拒绝处理，绝不"默认放行"）。审批闸关闭时（env）本表不产生行。
--   结构为纯新增：由本 SCHEMA 的 CREATE IF NOT EXISTS 覆盖（老库每次 openDb 自动建表，无需加列迁移）。
CREATE TABLE IF NOT EXISTS exec_approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT    NOT NULL,                    -- 发起方（哪个 agent 要用这条命令）
  cmd          TEXT    NOT NULL,                    -- 命令全文（数组空格连接；展示给审批人）
  cwd          TEXT,                                -- 工作目录（审批人判断影响范围用）
  reason       TEXT,                                -- 判为高风险的人话原因
  status       TEXT    NOT NULL DEFAULT 'pending',   -- pending/approved/denied/expired/executed
  result       TEXT,                                -- 执行后摘要（exit/耗时/输出字节）
  session_id   TEXT,
  requested_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT    NOT NULL,                    -- 逾期时刻；到来即作废（按拒绝处理）
  decided_at   TEXT,
  decided_by   TEXT                                 -- 例：human:dashboard / system:timeout
);
CREATE INDEX IF NOT EXISTS idx_exec_appr_status ON exec_approvals(status, id);

/* ── ★ P2-5（E-1 / MACP 资源锁）：跨 agent 互斥资源占用 ─────────────────────
 * 目的：让「同一份资源同一时刻只有一个写者」由**数据库**保证，而非靠 agent 自觉。
 * 关键设计：idx_resource_locks_active 是**部分唯一索引**（仅约束 released_at IS NULL 的行）
 *   ⇒ 同一 resource 同时最多存在一把活跃锁；重复获取会被 SQLite 直接拒绝（而不是"约定上不该"）。
 * 租约语义（与 P2-6 的 heartbeat/release 配套）：
 *   expires_at 到期即视为可被接管（接管方写新行 + 旧行补 released_at，fencing_token 递增）；
 *   因此**过期的锁不会永久阻塞**，但会留下可追溯的历史行。 */
CREATE TABLE IF NOT EXISTS resource_locks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resource      TEXT    NOT NULL,                 -- 资源标识，如 file:<abs> / port:8787 / db:memory
  holder        TEXT    NOT NULL,                 -- 持有者 agent
  session_id    TEXT,
  purpose       TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,       -- 同一 resource 的获取序号（接管时递增，用于拒过期写）
  acquired_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at  TEXT,
  expires_at    TEXT    NOT NULL,                 -- 租约到期时间
  released_at   TEXT,                             -- 显式释放时间（NULL = 活跃）
  meta          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locks_active ON resource_locks(resource) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_resource_locks_holder ON resource_locks(holder, released_at);
CREATE INDEX IF NOT EXISTS idx_resource_locks_expiry ON resource_locks(expires_at) WHERE released_at IS NULL;

-- ★ Agent 会话（dashboard 内置 agent 的对话历史持久化）。
--   session_key 为前端生成的稳定键（uuid）；messages 为 JSON 数组 [{role, content}]，
--   纪律（与 exec_audit 同口径）：**不存敏感凭据**，超长历史由写入方截断（最新 200 条），
--   行内 JSON 控制在 2KB 级（page_size 4096 不产生 overflow 页）。
CREATE TABLE IF NOT EXISTS agent_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT    NOT NULL UNIQUE,             -- 前端 uuid，稳定幂等键
  title       TEXT    NOT NULL DEFAULT '',          -- 会话标题（前端可改）
  messages    TEXT    NOT NULL DEFAULT '[]',        -- JSON: [{role:"user|assistant", content}]
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);

/* ── ★ A1 身份与认证层：短生命周期凭据 + 可撤销信任 ─────────────────────────
 * 融合架构「动态短生命周期凭据、Agent 级最小权限、可撤销信任」的落地：
 *   - credential：随机 hex（随机数生成，非口令），不存任何明文口令
 *   - scope：最小权限（read / write / admin），默认 read
 *   - expires_at：短生命周期到期时刻（默认 1h），过期凭据视为无效
 *   - revoked_at：显式撤销（可撤销信任）；NULL=未撤销
 *   - session_id：绑定会话标识，供审计反查。
 * 凭据验证纪律：只存 credential 本体 + 时间戳，**绝不**把凭据当命令拼接/执行。 */
CREATE TABLE IF NOT EXISTS agent_credentials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,                   -- 持有方 agent（与 memories.agent 同口径）
  credential  TEXT    NOT NULL UNIQUE,             -- 随机 hex 凭据
  scope       TEXT    NOT NULL DEFAULT 'read',     -- read / write / admin
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT    NOT NULL,                    -- 短生命周期到期（ISO8601）
  revoked_at  TEXT,                                -- 撤销时刻；NULL=未撤销
  session_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_creds_agent ON agent_credentials(agent, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_creds_expiry ON agent_credentials(expires_at) WHERE revoked_at IS NULL;

/* ── ★ DSH 参考「持久 run 日志」：run 终态落 SQLite（跨重启可查回放；内存态仅保留最近 50）
 *  run_id = 内存 registry 的 runId（幂等键；同 run 重复 finish 走 upsert 更新终态字段）。
 *  纪律（与 agent_sessions/exec_audit 同口径）：写入方负责截断 —— answer ≤2000 字、
 *  error ≤500 字、steps_json ≤200 步且单 JSON ≤32KB（超即截断 + 标记），不存敏感凭据。 */
CREATE TABLE IF NOT EXISTS agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT    NOT NULL UNIQUE,             -- 内存 registry 的 runId
  title       TEXT    NOT NULL DEFAULT '',          -- run 标题（≤120 字，写入方截断）
  status      TEXT    NOT NULL,                     -- done / failed / aborted
  answer      TEXT    NOT NULL DEFAULT '',          -- 最终答案（≤2000 字）
  steps_json  TEXT    NOT NULL DEFAULT '[]',        -- JSON: 步骤摘要（≤200 步，≤32KB）
  tool_calls  INTEGER NOT NULL DEFAULT 0,
  usage       TEXT,                                  -- JSON {prompt,completion,total}；无则 NULL
  fanout      INTEGER NOT NULL DEFAULT 1,            -- fan-out 子执行数（1=单 run）
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  error       TEXT    NOT NULL DEFAULT '',          -- 失败原因（≤500 字）
  llm_model   TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_finished ON agent_runs(finished_at DESC);

/* ── ★ 批次 D1（2026-10-03，对标 orca 的 --retry-request <id>）：写类工具的「请求回执」 ──
 * 目的：agent 网络超时后无法判定「是否已生效」，只能重试 → 重复 done / 重复 release。
 *   同 request_id 二次到达时**复用首次回执、不重复执行**（幂等重放）。
 * 语义边界（对齐 orca）：本表只证「该 request_id 已被处理过」；**无记录 ≠ 未发生**——
 *   没带 request_id 的调用一律不查不落，行为与改动前完全一致（零回归）。
 * 键口径：request_id 由客户端生成、全局唯一（PRIMARY KEY 即约束）；tool 仅作错配校验不参与键。
 *   回执**不存敏感内容**：写入的是工具的正常业务回执串（与 MCP 返回同体）。 */
CREATE TABLE IF NOT EXISTS request_receipts (
  request_id TEXT PRIMARY KEY,                  -- 客户端生成的请求身份（复用 orca --retry-request 语义）
  tool       TEXT    NOT NULL,                  -- 首次处理该请求的工具名（重放错配 → 拒绝，防串号）
  agent      TEXT,                              -- 首办 agent（审计用）
  memory_id  INTEGER,                           -- 关联任务（审计用，可空）
  result     TEXT    NOT NULL,                  -- 首次执行的原始回执（重放原样返回）
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ★ P0-A（2026-10-13）：任务级记忆效果关联——哪条记忆被注入后任务成功/失败
CREATE TABLE IF NOT EXISTS memory_task_outcomes (
  memory_id    INTEGER NOT NULL,
  task_card_id INTEGER NOT NULL,
  outcome      TEXT NOT NULL,           -- 'success' | 'failed' | 'unverified'
  session_id   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mto_memory ON memory_task_outcomes(memory_id);
CREATE INDEX IF NOT EXISTS idx_mto_task   ON memory_task_outcomes(task_card_id);

-- ★ P0-C（2026-10-13）：检索评测集（query → 期望命中 memory_id 列表）
CREATE TABLE IF NOT EXISTS eval_queries (
  id           INTEGER PRIMARY KEY,
  query        TEXT NOT NULL,
  expected_ids TEXT NOT NULL,            -- JSON 数组，期望命中的 memory_id 列表
  project      TEXT DEFAULT 'global',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;
/** 读配置（KEY 不存在返回默认值，JSON 解析失败也返回默认值） */
export function readConfig(db, key, def) {
    const row = db
        .prepare(`SELECT value FROM config WHERE key = ?`)
        .get(key);
    if (!row)
        return def;
    try {
        return JSON.parse(row.value);
    }
    catch {
        return def;
    }
}
/** 写配置（UPSERT，覆盖旧值并刷新 updated_at） */
export function writeConfig(db, key, value) {
    db.prepare(`INSERT INTO config(key, value, updated_at) VALUES(?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value));
}
/** 读全部采集水位（path → {size, mtime_ms}），用于增量跳过未变文件 */
export function getIngestStates(db) {
    const rows = db.prepare(`SELECT path, size, mtime_ms FROM ingest_state`).all();
    const m = new Map();
    for (const r of rows)
        m.set(r.path, { size: r.size, mtime_ms: r.mtime_ms });
    return m;
}
/** 写单个源文件的采集水位（UPSERT） */
export function setIngestState(db, path, size, mtime_ms) {
    db.prepare(`INSERT INTO ingest_state(path, size, mtime_ms, last_at) VALUES(?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, last_at = excluded.last_at`).run(path, size, mtime_ms);
}
/* ── P1-5 / T14：查询可观测性（进程内，零依赖，不改任何语义）──────────────
 *  背景：全仓无慢查询日志、无耗时分位、无锁等待统计；性能退化只能靠人工 EXPLAIN
 *  发现（历史 B 系列瓶颈全部靠实测）。本模块补最小可观测面。
 *  ① 执行耗时采样：包装 db.prepare() 返回语句的 all/get/run，单次耗时写入定长
 *     环形缓冲（默认 500 条）→ 供 p50/p95/max；≥50ms 额外记入慢查询环（默认 200 条）。
 *  ② busy 重试计数：withTx 在 busy_timeout 溢出后的自动重试次数（锁竞争真实水位）。
 *  安装点：openDb() 内自动安装 → 调用方（server/dashboard/daemon/smoke）零改动。
 *  开销：每次执行 +2 次 hrtime 调用 +1 次数组写；无字符串拼接、无 I/O。
 *  关闭：MEMORYOS_QT_OFF=1。 */
const _QT_OFF = process.env.MEMORYOS_QT_OFF === "1";
const _QT = { total: 0, slow: 0, busyRetry: 0, slowMs: 50, durMax: 500, ringMax: 200, n: 0, idx: 0, durs: null, slowRing: [] };
const _QT_EXEC_METHODS = new Set(["all", "get", "run"]);

/** 安装查询计时采样（幂等；已安装则直接返回）。opts: {slowMs, ringMax, durMax} */
export function installQueryTiming(db, opts = {}) {
    if (!db || db.__qtInstalled || _QT_OFF)
        return db;
    if (Number(opts.slowMs) > 0)
        _QT.slowMs = Number(opts.slowMs);
    if (Number(opts.ringMax) > 0)
        _QT.ringMax = Number(opts.ringMax);
    if (Number(opts.durMax) > 0)
        _QT.durMax = Number(opts.durMax);
    _QT.durs = new Float64Array(_QT.durMax);
    const orig = db.prepare.bind(db);
    db.prepare = (sql) => {
        const stmt = orig(sql);
        return new Proxy(stmt, {
            get(target, prop, recv) {
                const v = Reflect.get(target, prop, recv);
                if (typeof v !== "function")
                    return v;
                if (!_QT_EXEC_METHODS.has(prop))
                    return v.bind(target); // 其余方法（columns/sourceSQL 等）原样透传
                return (...args) => {
                    const t0 = process.hrtime.bigint();
                    try {
                        return v.apply(target, args);
                    }
                    finally {
                        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                        _QT.total++;
                        _QT.durs[_QT.idx] = ms;
                        _QT.idx = (_QT.idx + 1) % _QT.durMax;
                        if (_QT.n < _QT.durMax)
                            _QT.n++;
                        if (ms >= _QT.slowMs) {
                            _QT.slow++;
                            _QT.slowRing.push({ ms: Number(ms.toFixed(1)), sql: String(sql).replace(/\s+/g, " ").trim().slice(0, 160), at: new Date().toISOString() });
                            if (_QT.slowRing.length > _QT.ringMax)
                                _QT.slowRing.shift();
                        }
                    }
                };
            },
        });
    };
    db.__qtInstalled = true;
    return db;
}
/** busy_timeout 溢出后的自动重试计数（由 withTx 调用） */
export function noteBusyRetry() {
    _QT.busyRetry++;
}
/** 查询耗时快照：p50/p95/max + 慢查询 Top10 + 锁重试次数 */
export function queryStats() {
    const d = _QT.durs ? Array.from(_QT.durs.slice(0, _QT.n)).sort((a, b) => a - b) : [];
    const pick = (p) => (d.length ? Number(d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1)) : null);
    return {
        enabled: !_QT_OFF,
        total: _QT.total,
        slow: _QT.slow,
        sampled: d.length,
        slowMs: _QT.slowMs,
        busyRetry: _QT.busyRetry,
        p50: pick(0.5),
        p95: pick(0.95),
        max: d.length ? Number(d[d.length - 1].toFixed(1)) : null,
        slowTop: _QT.slowRing.slice(-10).reverse(),
    };
}
export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath);
    installQueryTiming(db); // ★ P1-5：先装采样，后续所有 prepare 都被覆盖
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // ★ P1-1.2 PRAGMA 调优（不改语义，只调性能；均为跨版本安全的选项）
    //   synchronous=NORMAL：WAL 下兼顾安全与吞吐 —— 默认 FULL 每次提交都 fsync，
    //     而 WAL 模式下 NORMAL 只在 checkpoint 时 fsync，崩溃最多丢失最后一个事务（可接受）。
    //   cache_size=-64000：64MB 页缓存（负值表示 KB），减少直接读 I/O。
    //   mmap_size=256MB：内存映射读，避免 read() 系统调用。
    //   temp_store=MEMORY：排序/临时表走内存（gram 回填、报表聚合等受益）。
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA cache_size = -64000");
    db.exec("PRAGMA mmap_size = 268435456");
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec(SCHEMA);
    // 迁移：旧库缺 v0.2 列则补
    const cols = db.prepare(`PRAGMA table_info(memories)`).all().map((c) => c.name);
    const add = [
        ["status", "TEXT NOT NULL DEFAULT 'active'"],
        ["confidence", "REAL NOT NULL DEFAULT 0.8"],
        ["hit_count", "INTEGER NOT NULL DEFAULT 0"],
        ["last_hit_at", "TEXT"],
        ["embedding", "BLOB"],
        // v0.3 增量
        ["eff_confidence", "REAL"],
        ["conflict_with", "INTEGER"],
        ["superseded_by", "INTEGER"],
        ["derived_from", "INTEGER"],
        // P1-2.4 增量
        ["embedding_stale", "INTEGER NOT NULL DEFAULT 0"],
        // ★ v0.4 记忆类别（10 sector）+ 时态/情感/溯源
        ["sector", "TEXT NOT NULL DEFAULT 'episodic'"],
        ["form", "TEXT NOT NULL DEFAULT 'textual'"],
        ["salience", "REAL NOT NULL DEFAULT 1.0"],
        ["decay_lambda", "REAL"],
        ["last_seen_at", "TEXT"],
        ["valid_from", "TEXT"],
        ["valid_until", "TEXT"],
        ["trigger_cond", "TEXT"],
        ["trigger_kind", "TEXT NOT NULL DEFAULT 'pattern'"], // H6: cron | pattern | llm
        ["trigger_action", "TEXT"],
        ["valence", "REAL"],
        ["arousal", "REAL"],
        ["source_ref", "TEXT"],
        ["sensitivity", "TEXT NOT NULL DEFAULT 'normal'"],
        ["pinned", "INTEGER NOT NULL DEFAULT 0"],
        // ★ P2-5（E-1 / MACP 强一致字段）：多 agent 并发下的「过期写 / 重复写 / 因果乱序」治理基础。
        //   version/fencing_token/epoch 由 P2-6 的生命周期工具维护；idempotency_key 供重试去重；
        //   causal_parent 记录因果前驱（同一结论的修订链）。均为附加列 → 老库可读、旧 dist 不受影响。
        ["version", "INTEGER NOT NULL DEFAULT 1"],
        ["fencing_token", "INTEGER NOT NULL DEFAULT 0"],
        ["epoch", "TEXT"],
        ["idempotency_key", "TEXT"],
        ["causal_parent", "INTEGER"],
        // ★ 批次⑦X2（2026-09-23）：规则强制注入开关（gate 模式下 inject=1 的 active 规则进注入段）
        ["inject", "INTEGER NOT NULL DEFAULT 0"],
        // ★ 2026-10-14（③）：记忆来源标签（human/agent/ingest）。存量库默认 'agent'，随后由 migrateMemorySource 回填。
        ["source", "TEXT NOT NULL DEFAULT 'agent'"],
    ];
    for (const [name, def] of add) {
        if (!cols.includes(name))
            db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`);
    }
    // ★ P2-5（E-1）：cards 表同样补强一致字段（与 memories 同名同义，便于双层对账）
    const cardCols = db.prepare(`PRAGMA table_info(cards)`).all().map((c) => c.name);
    const addCards = [
        ["version", "INTEGER NOT NULL DEFAULT 1"],
        ["fencing_token", "INTEGER NOT NULL DEFAULT 0"],
        ["epoch", "TEXT"],
        ["idempotency_key", "TEXT"],
        ["causal_parent", "INTEGER"],
        // ★ 一致性⑦（2026-09-19）：租约到期「贴条」标记 —— 到期不自动抢回（防误杀在岗认领者 + 防与任务头
        //   对账震荡）。NULL=未贴条。
        ["lease_notice_at", "TEXT"],
        // ★ 批次 B1（2026-10-03，对标 orca「absence never authorizes destruction」）：贴条超期后的**裁决标记**。
        //   打上即"只标不回收"——卡片保持 running、锁/assignee 保留、dispatch 置 stale；回收或继续必须走正向动作
        //   （heartbeat 复活 / task_claim(takeover) 换代接管 / task_release 显式归还）。NULL=未到裁决点。
        //   与 lease_notice_at 两段式配合：贴条（阶段一）→ 裁决标记（阶段二）；本列兼作阶段二幂等键。
        ["lease_stale_at", "TEXT"],
        // ★ 2026-09-20：卡片主题（归档中心按主题分组用）。NULL=未分类；解析优先级见
        //   dashboard-reg-cards.js 的 topicOfCardRow（topic 列 > meta.topic > 标题 [topic:xxx] > 未分类）。
        ["topic", "TEXT"],
        // ★ B3（2026-10-18 · P2）：门控连续失败计数 —— 与 failure_count（failed 态业务失败）分立：
        //   gate 失败卡回 ready（fail-closed 可重试），原熔断判据 status='failed' 永远看不到它，
        //   缺陷任务被反复领取而熔断失明（问题 #6）。扩展判据：ready 且本列≥2 → blocked。
        //   清零点：成功收口（done/accept）或人工介入流转（human:  actor）——**agent 重领不清零**
        //   （否则每次重试都经 claim 清零，计数永远到不了 2，熔断器永不可达，见报告 §3-B3 偏离说明）。
        ["gate_fail_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    if (cardCols.length) {
        for (const [name, def] of addCards) {
            if (!cardCols.includes(name))
                db.exec(`ALTER TABLE cards ADD COLUMN ${name} ${def}`);
        }
    }
    // 幂等键唯一化：**部分唯一索引**（NULL 不受约束，故存量行与"不带幂等键"的写入都不受影响）
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idem ON memories(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_fencing ON memories(epoch, fencing_token);
  `);
    if (cardCols.length) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_idem ON cards(idempotency_key) WHERE idempotency_key IS NOT NULL;`);
    }
    // ★ M12（R4 裁决）：老库 links 表补 vault_root 列（多 vault 隔离域）。SCHEMA 的 CREATE IF NOT EXISTS 只对新库生效。
    const linkCols = db.prepare(`PRAGMA table_info(links)`).all().map((c) => c.name);
    if (linkCols.length && !linkCols.includes("vault_root")) {
        db.exec(`ALTER TABLE links ADD COLUMN vault_root TEXT`);
    }
    // ★ 2026-10-15：老库 memory_vectors 表补 embed_model / dim 两列（向量出处，防跨模型混比静默失真）。
    //   SCHEMA 的 CREATE IF NOT EXISTS 只对新库生效；老库须 ALTER 补列，缺省值使已有行立即可读。
    const vecCols = db.prepare(`PRAGMA table_info(memory_vectors)`).all().map((c) => c.name);
    if (vecCols.length) {
        if (!vecCols.includes("embed_model"))
            db.exec(`ALTER TABLE memory_vectors ADD COLUMN embed_model TEXT NOT NULL DEFAULT 'unknown'`);
        if (!vecCols.includes("dim"))
            db.exec(`ALTER TABLE memory_vectors ADD COLUMN dim INTEGER NOT NULL DEFAULT 0`);
    }
    // ★ P2：老库 idx_links_uniq 缺 alias 列 → 重建（否则 [[b]] 与 [[b|别名]] 被误去重）。索引是可重建派生结构，幂等。
    const uniqDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_links_uniq'`).get();
    if (uniqDef && !/alias/i.test(uniqDef.sql)) {
        db.exec(`DROP INDEX IF EXISTS idx_links_uniq`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_links_uniq ON links(
         src_kind, src_id, kind, IFNULL(dst_id, -1), IFNULL(dst_title, ''), IFNULL(anchor, ''), IFNULL(alias, '')
       )`);
    }
    // ★ v0.4 索引：必须在加列之后建（见 SCHEMA 内注释）；idx_memories_last_seen 供 H5 hit 批量刷盘用
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_sector ON memories(sector, status);
    CREATE INDEX IF NOT EXISTS idx_memories_valid  ON memories(valid_until);
    CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
    CREATE INDEX IF NOT EXISTS idx_memories_last_seen ON memories(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_memories_stale  ON memories(embedding_stale);
    CREATE INDEX IF NOT EXISTS idx_daemon_log_ts   ON daemon_log(created_at);
  `);
    // ★ 架构重构 1c（2026-10-14）：跨进程缓存失效「向量代数」计数行 + 触发器。
    //   **必须在此处（全部 ALTER 加列之后）调用** —— 触发器 OF 列表引用 sector/salience/
    //   decay_lambda/pinned/valid_until/embedding_stale/version，老库上这些列是 ALTER 后才有的，
    //   先建会 `no such column` 直接把 openDb 打崩。幂等（INSERT OR IGNORE + CREATE TRIGGER IF NOT EXISTS）。
    ensureVecGen(db);
    // fts 补齐
    db.exec(`
    INSERT INTO memories_fts(rowid, content, project)
    SELECT id, content, project FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.rowid = m.id);
  `);
    // ★ P0-3.4 gram 回填：为「尚无 gram 记录」的记忆补齐 CJK 2-gram 索引（首次升级 / 历史数据）。
    // 无 CJK 的正文会写入空串哨兵，因此该判定不会对纯英文/代码类记忆反复触发。
    // ★ 启动阻塞修复（2026-10-09）：原实现用 NOT EXISTS 全表扫（2345条→5230ms），阻塞 startCore()。
    //   改为 LIMIT 分批（每批 200 条）+ setImmediate 让出事件循环，首次启动只回填一批即返回，
    //   其余批次由 daemon 每日 gram 回填收口，对用户完全无感。
    try {
        const GRAM_BATCH = 200;
        const missing = db
            .prepare(`SELECT id, content FROM memories m
         WHERE NOT EXISTS (SELECT 1 FROM memories_gram g WHERE g.memory_id = m.id)
         LIMIT ?`)
            .all(GRAM_BATCH);
        if (missing.length) {
            const ins = db.prepare(`INSERT INTO memories_gram(gram, memory_id) VALUES (?, ?)`);
            db.exec("BEGIN");
            try {
                for (const m of missing) {
                    const grams = gramTokens(m.content);
                    if (grams.length === 0)
                        ins.run("", m.id);
                    else
                        for (const g of grams)
                            ins.run(g, m.id);
                }
                db.exec("COMMIT");
            }
            catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
            console.error(`[db] gram 回填完成（本批）: ${missing.length} 条记忆（更多批次由 daemon 后台补齐）`);
        }
    }
    catch (e) {
        console.error(`[db] gram 回填失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ P1-2.2 向量表迁移（幂等、单事务、以 config 标记防重复）
    migrateVectorsSplit(db);
    // ★ 2026-10-15 向量出处回填（embed_model/dim 列迁移 + 存量 dim 回填，幂等、config 标记防重复）
    try {
        migrateVectorProvenance(db);
    }
    catch (e) {
        console.error(`[db] 向量出处迁移失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ v0.4 记忆类别迁移（幂等；按旧 type 回填 sector + λ）
    try {
        migrateSectors(db);
    }
    catch (e) {
        console.error(`[db] 记忆类别迁移失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ 2026-10-14（③ 记忆来源标签）：来源回填（幂等；人工/采集识别，其余保持默认 'agent'）
    try {
        migrateMemorySource(db);
    }
    catch (e) {
        console.error(`[db] 记忆来源迁移失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ P0-5.1 启动自检：打印「实际库路径 + 记忆条数 + project 数」。
    // 本项目曾并存三处 memory.db（手动版 / 桌面内嵌版 / %APPDATA% 版），
    // 配错路径时工具只回一句"暂无相关记忆"，从外部完全无法区分「空库」与「连错库」——
    // 本次故障排查即耗费大量往返。写 stderr：stdout 是 MCP stdio 协议通道，不可污染。
    try {
        const one = (sql) => db.prepare(sql).get().c;
        const total = one(`SELECT COUNT(*) AS c FROM memories`);
        const active = one(`SELECT COUNT(*) AS c FROM memories WHERE status='active'`);
        const projects = one(`SELECT COUNT(DISTINCT project) AS c FROM memories`);
        const grams = one(`SELECT COUNT(*) AS c FROM memories_gram`);
        console.error(`[db] ${dbPath} | memories=${total} active=${active} projects=${projects} grams=${grams}`);
    }
    catch (e) {
        console.error(`[db] ${dbPath} | 自检失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    installKeywordIndex(db);
    installCheckpointStore(db);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name GLOB 'memory_body_v[123]_*'").get()) installMemoryBodyGuard(db);

    return db;
}
/**
 * ★ P1-1.2 WAL 检查点。
 *
 * 背景：WAL 只增不减 —— 实测 data/memory.db-wal 曾达 28MB（与 53MB 主库同量级）。
 * 后果：① 每次读都要先合并 WAL，性能随其增长而衰减；② 异常退出后恢复时间变长。
 *
 * TRUNCATE 会把已提交页合并回主库并**截断** WAL 文件；若此时有其他连接在读，
 * SQLite 会返回 busy 而只做部分合并 —— 故不视为失败，下轮再试即可。
 *
 * @returns 是否成功（busy=0 视为成功）与详情，便于 daemon 记日志
 */
export function checkpointWal(db, mode = "TRUNCATE") {
    try {
        const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
        const busy = Number(row?.busy ?? 0);
        return {
            ok: busy === 0,
            busy,
            detail: `mode=${mode} busy=${busy} log=${row?.log ?? "?"} checkpointed=${row?.checkpointed ?? "?"}`,
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[db] wal_checkpoint(${mode}) 失败: ${msg}`);
        return { ok: false, busy: -1, detail: `mode=${mode} error=${msg}` };
    }
}
/** WAL 文件当前大小（字节）；文件不存在返回 0。用于监控与验收。 */
export function walSizeBytes(dbPath) {
    try {
        return fs.statSync(`${dbPath}-wal`).size;
    }
    catch {
        return 0;
    }
}
/* ---------- ★ P1-2.2 向量读写封装（vector 已独立成表，所有路径必须经此访问） ---------- */
/**
 * 写入/替换某条记忆的向量（幂等 upsert）。vec=null 时删除该行。
 *
 * ★ 2026-10-15 向量带出处（架构改进第一档①）：
 *   · 新增可选 opts { model, dim }：model 记当时 EMBED_MODE 对应的真实模型名（local→EMBED_MODEL，api→EMBED_MODEL，fake→'fake'），
 *     缺省 'unknown'；dim 缺省按 vec.length 推导。
 *   · **fake 模式 fail-closed**：若调用方未显式传 model（即 opts.model===undefined）且当前 EMBED_MODE 解析为
 *     'fake'，本函数抛出错误，而非静默写入假向量污染语义空间——这是「静默失败」根治点之一
 *     （此前 fake 是缺省值且写入通道从不校验，见 #4451「EMBED_MODE 兜底」规则）。
 *   · 读侧（readVector / getVectorsOnProject 等）应配合检查 embed_model，同库内混用不同模型向量时按 stale 同等降权
 *     （search.js 已约定）。
 */
export function upsertVector(db, memoryId, vec, opts = {}) {
    if (!vec) {
        db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memoryId);
        return;
    }
    // 惰性读取当前 EMBED_MODE（不 import embed.js，避免 db.js 反向依赖 ML 层——沿用既有铁律）：
    // 只读 process.env，embed.js 的 resolveMode() 与此口径一致（同为「缺省 fake」），此处仅用于 fail-closed 判据。
    const mode = process.env.EMBED_MODE ?? "fake";
    const fakeMode = mode === "fake";
    if (fakeMode && opts.model === undefined) {
        throw new Error(
            `[upsertVector] EMBED_MODE=fake 但调用方未显式声明 model 出处——拒绝静默写入假向量污染语义空间（见 #4451）。` +
            ` 请：① 生产环境显式设 EMBED_MODE=local/api 后重试；或 ② 管线自测场景显式传 opts.model='fake' 以声明这是测试向量。`
        );
    }
    const model = opts.model ?? "unknown";
    const dim = opts.dim ?? vec.length;
    db.prepare(`INSERT INTO memory_vectors(memory_id, embedding, embed_model, dim) VALUES (?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding, embed_model = excluded.embed_model, dim = excluded.dim`
    ).run(memoryId, vecToBuf(vec), model, dim);
}
/** 读取单条记忆的向量；不存在返回 null。 */
export function readVector(db, memoryId) {
    const r = db.prepare(`SELECT embedding FROM memory_vectors WHERE memory_id = ?`).get(memoryId);
    return r ? bufToVec(r.embedding) : null;
}
/**
 * ★ 2026-10-15 读取单条记忆的向量出处（embed_model / dim）；不存在返回 null。
 * 供检索侧判断「跨模型向量」降权（同库内不同模型/维度的向量不可直接 cosine 比较）。
 */
export function readVectorProvenance(db, memoryId) {
    const r = db.prepare(`SELECT embed_model, dim FROM memory_vectors WHERE memory_id = ?`).get(memoryId);
    return r ? { model: r.embed_model, dim: Number(r.dim) } : null;
}
/** 删除某条记忆的向量（记忆被物理删除时调用）。 */
export function deleteVector(db, memoryId) {
    db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memoryId);
}
/**
 * ★ P1-2.2 迁移：把 memories.embedding 搬入 memory_vectors，并置空旧列以真正瘦身。
 *
 * 安全性设计：
 *   ① 全程单事务 —— 任一步失败即回滚，不会出现"搬了一半"；
 *   ② 先复制、后置空 —— 置 NULL 之前数据已确认在新表中（INSERT OR IGNORE 幂等）；
 *   ③ config 标记防重复 —— 迁移只跑一次，后续启动零成本；
 *   ④ 保留 memories.embedding 列 —— 结构向后兼容，老代码若遗漏改动会被 NULL 暴露而非静默读错。
 */
const VECTOR_MIGRATION_KEY = "migration.vectors_split_v1";
const VECTOR_PROVENANCE_MIGRATION_KEY = "migration.vectors_provenance_v1";
function migrateVectorsSplit(db) {
    if (readConfig(db, VECTOR_MIGRATION_KEY, false) === true)
        return;
    const legacy = db.prepare(`SELECT COUNT(*) c FROM memories WHERE embedding IS NOT NULL`).get().c;
    db.exec("BEGIN");
    try {
        db.exec(`
      INSERT OR IGNORE INTO memory_vectors(memory_id, embedding)
      SELECT id, embedding FROM memories WHERE embedding IS NOT NULL;
    `);
        db.exec(`UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL;`);
        writeConfig(db, VECTOR_MIGRATION_KEY, true);
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    if (legacy)
        console.error(`[db] 向量表迁移完成: ${legacy} 条向量移入 memory_vectors（memory 表已瘦身）`);
}
/**
 * ★ 2026-10-15 向量出处迁移：给已有向量行回填 embed_model / dim 两列。
 * 背景：memory_vectors 表新增 embed_model（TEXT，缺省 'unknown'）与 dim（INTEGER，缺省 0）两列，
 *   用于在检索时只比对同模型同维度的向量，防止不同模型/维度的向量混比导致静默失真
 *   （EMBED_MODE 在 local/api/fake 之间切换时，历史向量与新向量不在同一语义空间/维度空间）。
 *
 * 回填策略（幂等、单事务、config 标记防重复）：
 *   ① dim：直接由 BLOB 长度推导（float32 每维 4 字节，length/4 即 dim），**不猜测模型名**；
 *   ② embed_model：现有向量无法反推真实模型（历史上 EMBED_MODE 缺省为 fake、无标记列），
 *      统一回填为 'unknown'，交由 reembed.js（现成全量重算入口，重算时按当时 EMBED_MODE 打真实标记）
 *      或 embed-backfill.js 逐步修正——在此之前，'unknown' 视为需要重算的待办，检索侧对
 *      embed_model='unknown' 的向量按 stale 同等降权处理（见 upsertVector 与 search.js 侧的约定）。
 *   ③ 只处理「新列尚缺、或 embed_model='unknown' 且 dim=0」的行，已完成回填的行（dim>0 且
 *      embed_model!='unknown'）绝不覆盖，保证多次 openDb 启动零成本、零副作用。
 */
function migrateVectorProvenance(db) {
    if (readConfig(db, VECTOR_PROVENANCE_MIGRATION_KEY, false) === true)
        return;
    db.exec("BEGIN");
    try {
        const missing = db
            .prepare(`SELECT memory_id, embedding FROM memory_vectors
                      WHERE dim = 0 OR dim IS NULL`)
            .all();
        if (missing.length) {
            const upd = db.prepare(
                `UPDATE memory_vectors SET dim = ?, embed_model = COALESCE(embed_model, 'unknown') WHERE memory_id = ?`
            );
            for (const r of missing) {
                const blobLen = r.embedding?.byteLength ?? 0;
                const dim = Math.floor(blobLen / 4); // float32：4 字节/维
                upd.run(dim, r.memory_id);
            }
            console.error(`[db] 向量出处回填: ${missing.length} 条向量补 dim（embed_model 保留/默认 'unknown'，待 reembed 逐步修正）`);
        }
        writeConfig(db, VECTOR_PROVENANCE_MIGRATION_KEY, true);
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
/* ---------- ★ v0.4 记忆类别（10 sector） ---------- */
/**
 * 记忆类别定义。来源：OpenMemory HMD 认知分层 + 本需求 8 类清单 + 调研补充 2 类。
 *   λ = 衰退率（越大越快被遗忘，daemon 按此算 eff_confidence）
 *   w = 检索权重（越大越优先召回）
 *   form 为**正交维度**（存储形态），不参与内容分类。
 */
export const SECTORS = {
    working: { cn: "工作记忆", desc: "当前上下文、临时变量、工具返回、任务状态", lambda: 0.05, w: 0.9, legacy: [] },
    episodic: { cn: "情景记忆", desc: "原始对话、时间、参与者、事件链、代码行号", lambda: 0.015, w: 1.2, legacy: ["experience"] },
    semantic: { cn: "语义记忆", desc: "事实、偏好、结论、概念关系", lambda: 0.005, w: 1.0, legacy: [] },
    procedural: { cn: "程序记忆", desc: "SOP、规约、工具用法、提示词、技能", lambda: 0.008, w: 1.1, legacy: ["convention", "rule", "example"] },
    meta: { cn: "元记忆", desc: "来源、置信度、决策理由、冲突记录、复盘（含反思）", lambda: 0.001, w: 0.8, legacy: ["decision", "pitfall"] },
    social: { cn: "社会/共享记忆", desc: "任务分派、交接、权限、共享黑板", lambda: 0.01, w: 1.0, legacy: ["task"] },
    user: { cn: "用户记忆", desc: "用户画像、偏好与历史交互信息", lambda: 0.003, w: 1.0, legacy: [] },
    prospective: { cn: "前瞻记忆", desc: "触发条件 + 行动建议 + 有效期", lambda: 0.0, w: 1.0, legacy: [] },
    affective: { cn: "情感记忆", desc: "情绪极性/强度、挫败点、偏好强度", lambda: 0.02, w: 1.3, legacy: [] },
};
export const SECTOR_KEYS = Object.keys(SECTORS);
/** 存储形态（正交维度） */
export const FORMS = ["textual", "graph", "vector"];
/** 旧 type → 新 sector 的映射（迁移回填用；反向取 legacy 数组） */
export const TYPE_TO_SECTOR = (() => {
    const m = {};
    for (const [sector, def] of Object.entries(SECTORS))
        for (const t of def.legacy)
            m[t] = sector;
    return m;
})();
/** 取某类的默认 λ（无定义时给一个中性值，避免 0 导致永不衰减） */
export function sectorLambda(sector) {
    return SECTORS[sector ?? ""]?.lambda ?? 0.01;
}
/** 归一化 sector 值：非法/空 → 由 type 推导 → 兜底 episodic */
export function normalizeSector(sector, type) {
    const s = String(sector ?? "").trim().toLowerCase();
    if (SECTOR_KEYS.includes(s))
        return s;
    const t = String(type ?? "").trim().toLowerCase();
    return TYPE_TO_SECTOR[t] ?? "episodic";
}
const SECTOR_MIGRATION_KEY = "migration.sectors_v1";
/**
 * 记忆类别迁移（幂等、单事务、以 config 标记防重复）。
 * 只做两件事：① 按旧 type 回填 sector ② 写入 λ 默认值。
 * 不触碰 content / embedding / FTS / 向量表 —— 故旧代码仍可正常读取。
 */
export function migrateSectors(db) {
    if (readConfig(db, SECTOR_MIGRATION_KEY, false) === true)
        return;
    const rows = db
        .prepare(`SELECT id, type, sector FROM memories`)
        .all();
    db.exec("BEGIN");
    try {
        const upd = db.prepare(`UPDATE memories SET sector = ?, decay_lambda = COALESCE(decay_lambda, ?) WHERE id = ?`);
        let n = 0;
        for (const r of rows) {
            const target = normalizeSector(r.sector, r.type);
            // 默认值 'episodic' 视为「未回填」：仅当 sector 缺省或与 type 映射不符时改写
            const mapped = TYPE_TO_SECTOR[String(r.type ?? "").toLowerCase()];
            if (!r.sector || (mapped && r.sector === "episodic" && mapped !== "episodic")) {
                upd.run(target, sectorLambda(target), r.id);
                n++;
            }
        }
        writeConfig(db, SECTOR_MIGRATION_KEY, true);
        // M11（R4 裁决）：迁移完成即标记旧 type 列 deprecated —— 读层只用 sector，写层 type 参数仅映射后丢弃。
        //   前端旧筛选进入「兼容模式」折叠；不物理删列（旧代码仍可读，回退安全）。
        writeConfig(db, "type.deprecated", 1);
        db.exec("COMMIT");
        if (n)
            console.error(`[db] 记忆类别迁移完成: ${n} 条记忆回填 sector`);
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
const SOURCE_MIGRATION_KEY = "migration.memory_source_v1";
/**
 * ★ 2026-10-14（③ 记忆来源标签）来源列回填（幂等、单事务、以 config 标记防重复）。
 * 只做两件事：① 人工通道写的（agent LIKE 'human%'）→ human；② 采集/笔记镜像 → ingest；其余保持默认 'agent'。
 * 采集判定用三条确定性证据（互补，不用启发式猜测）：
 *   ① agent='obsidian' —— 三个 vault 导入入口（CLI / MCP 工具 / 看板路由）统一传该 agent，无其他用途；
 *   ② obsidian_sync 映射表命中的 memory_id —— 笔记 ↔ 记忆的显式映射；
 *   ③ agent_fpath ∈ ingest_state.path —— 文件采集写入时把源文件绝对路径记为 agent_fpath。
 * 实测（生产库副本）：仅靠 ② 只覆盖 5 条（映射表只登记了 5 篇镜像笔记），而 agent='obsidian' 实际有 97 条
 *   （vault 导入未登记映射）；故 ① 是必需项，②③ 负责 trae/workbuddy/codex 等文件采集面。
 * 两表都可能因功能未启用而不存在，故先探测再拼语句。不触碰 content/embedding/FTS —— 结构附加，回退安全。
 */
export function migrateMemorySource(db) {
    if (readConfig(db, SOURCE_MIGRATION_KEY, false) === true)
        return;
    const hasTable = (n) => db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`).get(n).c > 0;
    const conds = [`agent = 'obsidian'`];
    if (hasTable("obsidian_sync"))
        conds.push(`id IN (SELECT memory_id FROM obsidian_sync WHERE memory_id IS NOT NULL)`);
    if (hasTable("ingest_state"))
        conds.push(`agent_fpath IN (SELECT path FROM ingest_state)`);
    db.exec("BEGIN");
    try {
        const human = Number(db.prepare(`UPDATE memories SET source='human' WHERE agent LIKE 'human%'`).run().changes ?? 0);
        const ingest = Number(db
            .prepare(`UPDATE memories SET source='ingest' WHERE source <> 'human' AND (${conds.join(" OR ")})`)
            .run().changes ?? 0);
        writeConfig(db, SOURCE_MIGRATION_KEY, true);
        db.exec("COMMIT");
        if (human || ingest)
            console.error(`[db] 记忆来源迁移完成: human=${human} ingest=${ingest} 条`);
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
/** upsert 一条会话内 working 记忆（key 为会话内逻辑键，同 key 覆盖） */
export function setWorkingMemory(db, sessionId, key, content, kind = "note") {
    db.prepare(`INSERT INTO working_memory(session_id, key, kind, content, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(session_id, key)
     DO UPDATE SET kind = excluded.kind, content = excluded.content, updated_at = excluded.updated_at`).run(sessionId, key, kind, content);
}
/** 取某会话的 working 记忆（key 缺省 = 全量；按 updated_at 倒序，注入取前 N 条用） */
export function listWorkingMemory(db, sessionId, key) {
    const rows = key
        ? db
            .prepare(`SELECT * FROM working_memory WHERE session_id = ? AND key = ?`)
            .all(sessionId, key)
        : db
            .prepare(`SELECT * FROM working_memory WHERE session_id = ? ORDER BY updated_at DESC`)
            .all(sessionId);
    return rows.map((r) => ({
        id: Number(r.id),
        session_id: r.session_id,
        key: r.key,
        kind: r.kind,
        content: r.content,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }));
}
/** 删除某会话的 working 记忆（key 缺省 = 清空该会话；会话结束 / daemon 清理用） */
export function clearWorkingMemory(db, sessionId, key) {
    const info = key
        ? db.prepare(`DELETE FROM working_memory WHERE session_id = ? AND key = ?`).run(sessionId, key)
        : db.prepare(`DELETE FROM working_memory WHERE session_id = ?`).run(sessionId);
    return Number(info.changes);
}
/**
 * ★ P1-1.1 数据库备份（VACUUM INTO）。
 *
 * 为什么**不能**直接 copy 文件：
 *   WAL 模式下 .db 主文件并不含最新已提交事务（它们还在 -wal 里），直接复制 .db
 *   会得到一个**缺失最新数据、甚至页不一致**的备份 —— 这正是「备份了但备份是坏的」。
 *   VACUUM INTO 是 SQLite 官方在线备份机制：在事务一致点上产出单个自包含、已整理
 *   （无碎片）的库文件，且不阻塞其他连接。
 *
 * 幂等设计：daemon 每小时跑一轮，但备份是「每日一次」——以「当日目标文件已存在」
 * 作为判据跳过，无需额外状态表；跨天自然产生新文件。
 *
 * @param keep 保留最近 N 份（按文件名日期排序），超出的最旧文件被删除
 */
export function backupDb(db, dbPath, opts = {}) {
    const dir = opts.dir ?? path.join(path.dirname(dbPath), "backup");
    const keep = opts.keep ?? 7;
    const now = opts.now ?? new Date();
    const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const target = path.join(dir, `memory-${stamp}.db`);
    fs.mkdirSync(dir, { recursive: true });
    // 今日已备份 → 跳过（幂等；daemon 每小时一轮但只需每日一份）
    if (fs.existsSync(target)) {
        return { created: null, removed: [], note: `今日已备份（${path.basename(target)}）` };
    }
    // VACUUM INTO 要求目标文件不存在；路径中的单引号需转义
    const escaped = target.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    // 滚动删除：只保留最近 keep 份
    const removed = [];
    try {
        const all = fs
            .readdirSync(dir)
            .filter((f) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(f))
            .sort(); // 文件名含 ISO 日期 → 字典序即时间序
        const excess = all.slice(0, Math.max(0, all.length - keep));
        for (const f of excess) {
            try {
                fs.unlinkSync(path.join(dir, f));
                removed.push(f);
            }
            catch (e) {
                /* 删除失败不阻断备份主流程，但必须留痕（B2：备份链路失败不允许静默） */
                console.error(`[backup] 旧备份删除失败（${f}）: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    catch (e) {
        /* 目录列举失败不影响已完成的备份，留痕供排查 */
        console.error(`[backup] 备份目录列举失败（滚动清理跳过，${dir}）: ${e instanceof Error ? e.message : String(e)}`);
    }
    const sizeMB = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
    return {
        created: target,
        removed,
        note: `已备份 ${path.basename(target)}（${sizeMB}MB）${removed.length ? `，清理 ${removed.length} 份旧备份` : ""}`,
    };
}
export function rowOf(r) {
    return {
        id: Number(r.id),
        content: r.content,
        type: r.type,
        agent: r.agent,
        agent_fpath: r.agent_fpath,
        project: r.project,
        status: r.status,
        confidence: Number(r.confidence),
        eff_confidence: r.eff_confidence == null ? null : Number(r.eff_confidence),
        conflict_with: r.conflict_with == null ? null : Number(r.conflict_with),
        superseded_by: r.superseded_by == null ? null : Number(r.superseded_by),
        derived_from: r.derived_from == null ? null : Number(r.derived_from),
        hit_count: Number(r.hit_count),
        last_hit_at: r.last_hit_at,
        created_at: r.created_at,
        // ★ v0.4 记忆类别（10 sector）+ 时态/情感/溯源（R4 修订补 trigger_kind）
        sector: String(r.sector ?? "episodic"),
        form: String(r.form ?? "textual"),
        salience: r.salience == null ? 1.0 : Number(r.salience),
        decay_lambda: r.decay_lambda == null ? null : Number(r.decay_lambda),
        last_seen_at: r.last_seen_at ?? null,
        valid_from: r.valid_from ?? null,
        valid_until: r.valid_until ?? null,
        trigger_cond: r.trigger_cond ?? null,
        trigger_kind: String(r.trigger_kind ?? "pattern"),
        trigger_action: r.trigger_action ?? null,
        valence: r.valence == null ? null : Number(r.valence),
        arousal: r.arousal == null ? null : Number(r.arousal),
        source_ref: r.source_ref ?? null,
        sensitivity: String(r.sensitivity ?? "normal"),
        pinned: Number(r.pinned ?? 0),
        // ★ P2-5（E-1）：MACP 字段（未迁移的老库读到 undefined → 此处给安全默认值）
        version: Number(r.version ?? 1),
        fencing_token: Number(r.fencing_token ?? 0),
        epoch: r.epoch ?? null,
        idempotency_key: r.idempotency_key ?? null,
        causal_parent: r.causal_parent == null ? null : Number(r.causal_parent),
        // ★ 批次⑦X2：规则强制注入开关（老库未迁移读到 undefined → 安全默认 0）
        inject: Number(r.inject ?? 0),
        // ★ 2026-10-14（③）：来源标签（老库未迁移读到 undefined → 安全默认 'agent'，与列默认值一致）
        source: String(r.source ?? "agent"),
    };
}
/**
 * 内容归一化：Windows 笔记常带 \r\n，统一转 \n 入库，保证内容 hash 稳定
 * （否则 LF/CRLF 两版本判为"不同内容"，去重失效）。
 * ★ P0-3.2：原 updateMemory 只 trim 不归一化 → 「写入后编辑」会让同一内容 hash 变化、去重失效。
 * 抽成单一真源供写入与编辑共用。
 */
function normalizeContent(s) {
    return s.replace(/\r\n?/g, "\n");
}
export function writeMemory(db, args) {
    args.content = normalizeContent(args.content);
    const status = args.status ?? "active";
    // ★ v0.4：sector 缺省时由 type 推导；λ 缺省取类默认（daemon 按此衰减）
    const sector = normalizeSector(args.sector, args.type);
    const lambda = args.decay_lambda ?? sectorLambda(sector);
    // ★ 2026-10-14（③ 记忆来源标签）：缺省推导 —— agent 以 'human' 开头（human:dashboard / human:test /
    //   human:arbitrate 等人工通道）→ source='human'，其余 AI 工具写入 → 'agent'；采集/笔记导入显式传 'ingest'。
    const source = args.source ?? (String(args.agent ?? "").startsWith("human") ? "human" : "agent");
    // ★ 一致性⑤（2026-09-19）：INSERT + 向量 + grams + 缓存失效包成真事务 —— 原 catch DELETE 伪回滚
    //  在「INSERT 成功 → 进程崩溃」窗口会留下无向量孤儿记忆（FTS 可见、语义检索不可见、永不自愈）。
    //  现在要么全写、要么全不算；嵌入计算由调用方在锁外完成、经 args.embedding 传入（慢活不进事务）；
    //  withTx 可重入：被 task_assign/task_delegate/memory_write 外层事务包裹时并入外层，原子性由最外层保证。
    let newId = 0;
    withTx(db, () => {
        const info = db
            .prepare(`INSERT INTO memories(
         content,type,agent,agent_fpath,project,confidence,status,
         sector,form,salience,decay_lambda,valid_from,valid_until,
         trigger_cond,trigger_kind,trigger_action,valence,arousal,source_ref,sensitivity,pinned,
         epoch,idempotency_key,causal_parent,source
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(args.content, args.type, args.agent, args.agent_fpath, args.project, args.confidence ?? 0.8, status, sector, String(args.form ?? "textual"), args.salience ?? 1.0, lambda, args.valid_from ?? null, args.valid_until ?? null, args.trigger_cond ?? null, String(args.trigger_kind ?? "pattern"), args.trigger_action ?? null, args.valence ?? null, args.arousal ?? null, args.source_ref ?? null, String(args.sensitivity ?? "normal"), args.pinned ?? 0,
            // ★ P2-5（E-1）：MACP 可写字段。version/fencing_token 走 DDL 默认值（1/0），只在接管/修订时由工具递增，
            //   故此处不接受外部传值，避免调用方伪造版本号破坏单调性。
            args.epoch ?? null, args.idempotency_key ?? null, args.causal_parent ?? null, source);
        newId = Number(info.lastInsertRowid);
        if (args.embedding) {
            // P1-2.2：向量入独立表；★ 2026-10-15 向量带出处：按当时 EMBED_MODE/EMBED_MODEL 打真实标签
            //   （writeMemory 是同步路径，直接读 env 与 upsertVector 的 fail-closed 判据同源，不走 embedderProvenance）
            const _mode = process.env.EMBED_MODE ?? "fake";
            const _model = _mode === "local" ? (process.env.EMBED_MODEL ?? "Xenova/bge-m3")
                : _mode === "api" ? (process.env.EMBED_MODEL ?? "bge-m3")
                    : "fake";
            upsertVector(db, newId, args.embedding, { model: _model, dim: args.embedding.length });
        }
        syncGrams(db, newId, args.content); // P0-3.4：维护 CJK 2-gram 索引
        invalidateVectorCache(db); // P0-4.1：新记忆进入候选池
    });
    return readMemory(db, newId);
}
export function updateMemory(db, id, args) {
    if (!readMemory(db, id))
        return null;
    const content = args.content != null ? normalizeContent(args.content).trim() : null;
    if (content !== null && !content)
        throw new Error("content 不能为空");
    // ★ 2026-09-19（实操复盘并发竞态）：乐观锁 CAS —— expectedVersion 给出时，content 写与 version 递增
    //   原子化（WHERE version=?）。两会话同时认领同一任务只有一个命中，另一个拿 null 由调用方拒绝。
    //   FTS/2-gram 同步与向量失效仅在校验通过后执行（漂移写不产生任何副作用）。
    if (args.expectedVersion != null) {
        if (content === null)
            throw new Error("expectedVersion 仅支持 content 写入");
        const cas = db
            .prepare(`UPDATE memories SET content=?, embedding_stale=1, version=version+1 WHERE id=? AND version=?`)
            .run(content, id, args.expectedVersion);
        if (Number(cas.changes) === 0)
            return null; // 版本漂移：未写入任何内容
        db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(content, id);
        syncGrams(db, id, content);
        invalidateVectorCache(db);
        return readMemory(db, id);
    }
    if (content !== null) {
        // ★ P1-2.4：正文变更 → 向量失效。置 embedding_stale=1，由 daemon 异步重算
        //   （此处不重算：updateMemory 是同步 API，而嵌入计算是异步且耗时的）。
        db.prepare(`UPDATE memories SET content=?, embedding_stale=1 WHERE id=?`).run(content, id);
        // P0-3.1：FTS 同步现已由 trg_memories_au 触发器保证；此处保留为幂等兜底
        // （对触发器创建之前就已存在的旧库仍然有效，重复写入同值无副作用）。
        db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(content, id);
    }
    if (args.type)
        db.prepare(`UPDATE memories SET type=? WHERE id=?`).run(args.type, id);
    if (args.sector !== undefined)
        db.prepare(`UPDATE memories SET sector=? WHERE id=?`).run(args.sector || null, id);
    if (content !== null)
        syncGrams(db, id, content); // P0-3.4：正文已改，重建 CJK 2-gram
    invalidateVectorCache(db); // P0-4.1：正文已变（注：向量未重算，见上方 v0.3 约定）
    return readMemory(db, id);
}
/** 独立验收或人工仲裁的置信度调整，限于 0..1；重复写入和引用不得调用。 */
export function bumpConfidence(db, id, delta = 0.1) {
    if (!Number.isFinite(delta)) throw new TypeError("置信度增量必须是有限数值");
    db.prepare(`UPDATE memories SET confidence = MIN(1.0, MAX(0.0, confidence + ?)) WHERE id = ?`).run(delta, id);
}
/**
 * 并发守卫：写事务重试封装。多客户端（MCP 多会话）同时写时，busy_timeout 只负责"等锁"，
 * 超时后仍会抛 `database is locked`——这里在锁竞争下自动重试并重开事务，避免写入方直接崩。
 * 用法：withTx(db, () => { 写操作 })；fn 抛非锁错误则吞掉后回滚并抛给上层。
 */
/** ★ 一致性⑤（2026-09-19）：事务重入深度 —— writeMemory 内部也开事务（INSERT+向量+grams 一笔成），
 *  而 writeMemory 又被 task_assign/task_delegate/memory_write 的外层事务包裹调用；node:sqlite 不支持
 *  嵌套 BEGIN，深度 > 0 时直接在当前事务内执行（外层回滚会一并回滚，原子性由最外层保证）。
 *  本项目单进程单 db 句柄，进程级计数即可（同步执行无并发重排）。 */
let __txDepth = 0;
export function withTx(db, fn, retries = 3) {
    if (__txDepth > 0) {
        fn(); // 已在事务内：并入当前事务，不重复 BEGIN
        return;
    }
    for (let attempt = 0;; attempt++) {
        try {
            // BEGIN IMMEDIATE：立即获取写锁，锁竞争在此即抛，便于在 BEGIN 层就能重试
            // （普通 BEGIN 是 deferred，写发生在 COMMIT 时，锁错误延后到 COMMIT 才抛——不利于 retry 对齐）
            db.exec("BEGIN IMMEDIATE");
            __txDepth = 1;
            try {
                fn();
                db.exec("COMMIT");
            }
            catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
            return;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
            const locked = msg.includes("database is locked") || msg.includes("busy");
            if (locked && attempt < retries) {
                // 锁竞争：让出后重试（busy_timeout 已让锁释放，多试几次竞争窗口很小）
                noteBusyRetry(); // ★ P1-5：锁竞争真实水位（/api/health 可见）
                continue;
            }
            throw e;
        }
        finally {
            __txDepth = 0;
        }
    }
}
export function readMemory(db, id) {
    const r = db.prepare(`SELECT ${BASE_COLUMNS} FROM memories WHERE id = ?`).get(id);
    return r ? rowOf(r) : null;
}
/** project 内（含 global）所有带向量记录，供语义 KNN。
 *  activeOnly=true 时仅取 status='active'（检索路径用：非 active 候选最终必被 search.js 过滤掉，
 *  提前在 SQL 收窄可显著缩小候选池，且避免无关候选挤占 topK）。去重预检请传 false（需覆盖全部状态）。 */
export function getVectorsOnProject(db, project, activeOnly = false) {
    // ★ P1-2.2：向量已独立成表 → JOIN 取代原来的 `embedding IS NOT NULL` 过滤
    //   （JOIN 天然只返回「有向量」的行），且 memories 侧不再读取 BLOB。
    // ★ 2026-10-15：附带 embed_model/dim 出处字段（跨模型降权判据见 search.js）。
    const rows = db
        .prepare(`SELECT m.id, v.embedding, m.embedding_stale, v.embed_model, v.dim
       FROM memories m
       JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.project COLLATE NOCASE IN (?, 'global')` + (activeOnly ? ` AND m.status = 'active'` : ""))
        .all(project);
    return rows.map((r) => ({
        id: Number(r.id),
        vec: bufToVec(r.embedding),
        stale: Number(r.embedding_stale) === 1,
        embedModel: r.embed_model ?? "unknown",
        dim: Number(r.dim) || 0,
    }));
}
/** 归档层语义检索专用：project 内**仅 status='archived'** 且带向量的记忆。
 *  不走向量缓存 —— 冷层（归档兜底）是低频路径，且缓存键只有 activeOnly 0/1 两档，
 *  为它单开第三档会扩大热路径改动面（沿用「热路径零改动」取向）。
 *  口径：只认 archived（rejected/superseded 天然排除）。
 *  ★ 2026-10-15：同样附带 embed_model/dim 出处字段。 */
export function getArchivedVectorsOnProject(db, project) {
    const rows = db
        .prepare(`SELECT m.id, v.embedding, m.embedding_stale, v.embed_model, v.dim
       FROM memories m
       JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.project COLLATE NOCASE IN (?, 'global') AND m.status = 'archived'`)
        .all(project);
    return rows.map((r) => ({
        id: Number(r.id),
        vec: bufToVec(r.embedding),
        stale: Number(r.embedding_stale) === 1,
        embedModel: r.embed_model ?? "unknown",
        dim: Number(r.dim) || 0,
    }));
}
/* ---------- ★ P0-4.1 向量缓存：消除"每次检索全表反序列化 embedding" ---------- */
/**
 * 检索路径每次 hybridSearch 都会拉取整个 project 的向量并逐条反序列化
 * （bge-m3 1024 维 float32 ≈ 4KB/条 → 516 条≈2MB/次，万条级≈40MB/次），
 * 而同一 project 在两次写入之间这份数据完全不变。故加进程内缓存：
 *   · 以 db 实例为键（WeakMap），多库并存互不干扰；
 *   · 写入/状态流转后 version++ 整体失效（候选池已变）；
 *   · TTL 兜底（60s），即使遗漏某个失效点也不会长期读到陈旧候选。
 * 去重预检（dedupeDecision）需要写入后的实时数据 → 仍走非缓存的 getVectorsOnProject。
 */
const VEC_CACHE_TTL_MS = 60_000;
const vecCache = new WeakMap();
function vecState(db) {
    let s = vecCache.get(db);
    if (!s) {
        s = {
            version: 0, byKey: new Map(), annByKey: new Map(), // ★ P0-ANN：ANN 索引与向量缓存同生命周期
            // ★ 架构重构 1c：跨进程失效状态 —— lastGen=上次对账到的全局代数（null=尚未建立基线）
            lastGen: null, pendingLocal: 0, genStmt: null,
        };
        vecCache.set(db, s);
    }
    return s;
}
/* ── ★ 架构重构 1c（2026-10-14）：跨进程缓存失效「向量代数」───────────────
 * 缺陷（改前）：vecCache.version 只在**本进程写入**时 ++，别的进程（daemon / ingest CLI /
 *   另一个 direct 模式 MCP 进程）写库本进程察觉不到，只能靠 60s TTL 兜底 ⇒ 首次查询可能读到陈旧池。
 * 已否决（用 `PRAGMA data_version` 当失效信号，两条连接探针实测）：同连接自写不改自己看到的值（安全），
 *   但**其他连接的任何提交都会改** —— 包括别的进程搜索时写的 hit_count/last_seen_at 回血（实测 +1）
 *   ⇒ 迁移期一搜索就打掉核心缓存，比 60s TTL 更差。
 * 采用：只在「会改变候选池」的写发生时，由 SQLite 触发器把 config 单行 `vec_gen` +1；
 *   检索入口读该单行（主键点查 O(1)）与上次基线比对，变了即 `vecState.version++` —— **一处 bump
 *   同时失效向量缓存与 L1 结果缓存**（search.js 的 L1 失效键就是 `vectorCacheVersion`，无需改 search.js）。
 * 判据（本批核心目的）：纯命中回血（只写 hit_count/last_hit_at/last_seen_at）**不得**递增代数。
 * 兜底：60s TTL 保留 —— 漏掉某个写点只退化到现状，不会永久陈旧。
 * 边界（如实）：任何进程的任何「候选池相关写」都会让**所有**进程失效；范围与代价见 `ensureVecGen` 注释。
 * 未纳入（如实列报）：`links` 表改动（只影响排序加分、不改变候选集合，且 obsidian 笔记同步会批量写
 *   —— 纳入即风暴）与派生表（memories_fts / memories_gram），二者陈旧上限 = TTL（30s / 60s）。
 * 开销：读侧每次检索多 2 次 config 主键点查（`vectorCacheVersion` 与 `getVectorsOnProjectCached` 各一次，
 *   后者覆盖不经前者的调用方），量级 μs，远小于查询嵌入推理（~27-33ms）。 */
const VEC_GEN_KEY = "vec_gen";
/** memories 的「候选池相关列」—— **精确**清单（勿随意增删）：凡参与「某 project 的候选记忆集合 /
 *  过滤 / 打分 / L1 返回内容」者。
 *   content(词法候选+L1 正文) project(WHERE 子句) status(activeOnly + 状态过滤) type(类型前置过滤/过滤/decision 豁免)
 *   sector·salience·decay_lambda(打分与 eff≤0.15 排除) pinned(免衰减) valid_until(过期排除)
 *   sensitivity(secret 过滤) source_ref(card: 任务排除) embedding_stale(stale 降权与 stale 标记) version(生命周期修订)。
 *  排除及依据：
 *   · hit_count / last_hit_at / last_seen_at —— 命中回血，**本批核心目的就是不触发**；
 *   · confidence / eff_confidence —— 检索层不读（全仓 search.js 无 `eff_confidence` 引用；`confidence` 只作
 *     返回对象里的展示字段、不参与打分），而 daemon 每小时治理会**批量**写 eff_confidence ⇒ 纳入即每小时
 *     全库缓存风暴，换来「展示字段最多陈旧 60s」的收益，不成比例；
 *   · valid_from(检索只读 valid_until) agent / agent_fpath / source(展示与溯源) created_at(只增不改，INSERT 已覆盖)
 *     conflict_with / superseded_by / derived_from / causal_parent / fencing_token / epoch / idempotency_key
 *     (生命周期与溯源，不进候选集与打分) inject(规则注入开关，与检索结果缓存无关)
 *     trigger_cond / trigger_kind / trigger_action / valence / arousal / form(检索层不读)
 *     embedding(P1-2.2 后恒为 NULL，向量在 memory_vectors)。 */
const VEC_GEN_MEM_COLS = "content, project, status, type, sector, salience, decay_lambda, pinned, valid_until, sensitivity, source_ref, embedding_stale, version";
/** 进程内失效统计（验收埋点；进程重启归零；byHour 只保留最近 24 个小时桶）。 */
const _vecInv = { total: 0, lastAt: null, lastSource: null, bySource: { "local-write": 0, "gen-change": 0 }, byHour: new Map() };
function noteVecInvalidation(source) {
    _vecInv.total++;
    _vecInv.lastAt = new Date().toISOString();
    _vecInv.lastSource = source;
    _vecInv.bySource[source] = (_vecInv.bySource[source] ?? 0) + 1;
    const hour = _vecInv.lastAt.slice(0, 13); // YYYY-MM-DDTHH
    _vecInv.byHour.set(hour, (_vecInv.byHour.get(hour) ?? 0) + 1);
    if (_vecInv.byHour.size > 24)
        for (const k of [..._vecInv.byHour.keys()].sort().slice(0, _vecInv.byHour.size - 24))
            _vecInv.byHour.delete(k);
}
/** ★ 1c 验收埋点：向量缓存 / L1 的失效次数与来源（进程内累计，零 I/O）。 */
export function vecInvalidationStats() {
    return {
        total: _vecInv.total,
        lastAt: _vecInv.lastAt,
        byHour: Object.fromEntries([..._vecInv.byHour.entries()].sort()),
        bySource: { ..._vecInv.bySource },
        lastSource: _vecInv.lastSource,
    };
}
/** 读全局向量代数（config 主键点查；语句按 db 实例缓存，避免热路径重复 prepare）。 */
function readVecGen(db) {
    const s = vecState(db);
    if (s.genStmt === null)
        s.genStmt = db.prepare(`SELECT value FROM config WHERE key = ?`);
    const row = s.genStmt.get(VEC_GEN_KEY);
    return row ? Number(row.value) || 0 : 0;
}
/** DDL 侧（openDb 内、**加列迁移之后**调用）：建计数行 + 六个触发器（幂等）。
 *
 *  落到生产库的 DDL 对象（④ 如实盘清）：
 *   · 数据行：`config('vec_gen','0')`（幂等 INSERT OR IGNORE；仅这一行，不改任何既有 config 行）。
 *   · 触发器 6 个：
 *     `trg_vecgen_mi` memories AFTER INSERT / `trg_vecgen_mu` memories AFTER UPDATE OF <VEC_GEN_MEM_COLS>
 *     / `trg_vecgen_md` memories AFTER DELETE；
 *     `trg_vecgen_vi` memory_vectors AFTER INSERT / `trg_vecgen_vu` memory_vectors AFTER UPDATE OF embedding
 *     / `trg_vecgen_vd` memory_vectors AFTER DELETE。
 *   · 无新增表、无新增列、无索引、无数据回填（生产库既有行一行未改）。
 *
 *  运行时开销与行为边界（如实）：
 *   · 触发体是一次 `config` 主键 UPDATE（每受影响**行**执行一次）——相对该行本身的写，开销可忽略
 *     （WAL 下同事务内的一条 PK 更新）；INSERT/UPDATE 触发器均不递归（config 上无触发器）。
 *   · 边界：**任何进程**的任何相关写都会递增，于是**所有**进程下次检索时整体失效。
 *     逐项判断：daemon 每小时治理里**量最大的一支**（decay → 批量 `eff_confidence`）不在列内 ⇒ 不触发；
 *     会触发的是「归档（status）」「重嵌（memory_vectors upsert + embedding_stale 清零）」「降权（salience）」
 *     ——量级为每轮被治理的条数（归档由 computeArchives 决定，通常个位数；重嵌受 stale 集合上限约束；
 *     降权 `pruneLowEfficiency` 每轮 ≤20）。即每小时数十次失效，而非全库风暴。
 *   · 真正修掉的一处漏点：向量重算/回填**只写 memory_vectors、不改 memories 任何列**，
 *     改前既无 version++ 也无任何信号 ⇒ 别的进程重嵌完，本进程语义检索仍用旧向量（60s 内）。本次由
 *     `trg_vecgen_*`(memory_vectors) 覆盖。
 *   · 自愈：若有人误删 `config('vec_gen')` 行，触发器 UPDATE 命中 0 行即静默不增（退化为 TTL 兜底）；
 *     下次 `openDb` 的 INSERT OR IGNORE 会补回该行。
 *
 *  回滚（本批要撤时）：`DROP TRIGGER IF EXISTS trg_vecgen_mi/trg_vecgen_mu/trg_vecgen_md/trg_vecgen_vi/`
 *   `trg_vecgen_vu/trg_vecgen_vd;` + `DELETE FROM config WHERE key='vec_gen';`（纯附加对象，drop 即回到改前，
 *   本批未改任何生产数据行）。 */
function ensureVecGen(db) {
    db.exec(`INSERT OR IGNORE INTO config(key, value) VALUES('${VEC_GEN_KEY}', '0');`);
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_vecgen_mi AFTER INSERT ON memories BEGIN
      UPDATE config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='${VEC_GEN_KEY}';
    END;
    CREATE TRIGGER IF NOT EXISTS trg_vecgen_mu AFTER UPDATE OF ${VEC_GEN_MEM_COLS} ON memories BEGIN
      UPDATE config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='${VEC_GEN_KEY}';
    END;
    CREATE TRIGGER IF NOT EXISTS trg_vecgen_md AFTER DELETE ON memories BEGIN
      UPDATE config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='${VEC_GEN_KEY}';
    END;
    CREATE TRIGGER IF NOT EXISTS trg_vecgen_vi AFTER INSERT ON memory_vectors BEGIN
      UPDATE config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='${VEC_GEN_KEY}';
    END;
    CREATE TRIGGER IF NOT EXISTS trg_vecgen_vu AFTER UPDATE OF embedding ON memory_vectors BEGIN
      UPDATE config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='${VEC_GEN_KEY}';
    END;
    CREATE TRIGGER IF NOT EXISTS trg_vecgen_vd AFTER DELETE ON memory_vectors BEGIN
      UPDATE config SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='${VEC_GEN_KEY}';
    END;
  `);
}
/** 跨进程对账：代数与基线不同 ⇒ version++（同时失效向量缓存与 L1）并记一次失效。
 *  归因：本地写入已在 `invalidateVectorCache` 里 bump 过（pendingLocal>0）→ 不重复 bump；
 *  否则视为「他写」→ bump + 记 gen-change。（绕过 `invalidateVectorCache` 的本进程裸 SQL 也会落进
 *  gen-change —— 标签不同，但失效行为正确，属保守侧。） */
function reconcileVecGen(db) {
    const s = vecState(db);
    const gen = readVecGen(db);
    if (s.lastGen === null) { s.lastGen = gen; s.pendingLocal = 0; return false; } // 首次：仅建立基线（此刻缓存尚空）
    if (gen === s.lastGen) { s.pendingLocal = 0; return false; }
    s.lastGen = gen;
    if (s.pendingLocal > 0) { s.pendingLocal = 0; return false; }
    s.version++;
    noteVecInvalidation("gen-change");
    return true;
}
/** 任何改变「向量候选池」的写入后调用：新增记忆、编辑正文、状态流转。 */
export function invalidateVectorCache(db) {
    const s = vecState(db);
    s.version++;
    s.pendingLocal++; // ★ 1c：本地 bump 记账 —— 让对账不把「自己刚写的」重复算成他写
    noteVecInvalidation("local-write");
}
/** ★ 2026-10-13（检索优化）：向量缓存版本号只读访问 —— 供检索结果层缓存（L1）做失效键：
 *  版本一变即代表底层记忆/向量池已改，L1 必须整体作废（比时间 TTL 更严格，杜绝读到旧正文）。
 *  ★ 1c（2026-10-14）：**先对账跨进程代数**再返回 —— hybridSearch 在算 L1 键时**最先**读本函数
 *  （早于 getVectorsOnProjectCached），若在此不对账，L1 会先于向量缓存命中「他写前」的陈旧结果。 */
export function vectorCacheVersion(db) {
    reconcileVecGen(db);
    return vecState(db).version;
}
/** 带缓存的 getVectorsOnProject —— 仅供检索路径使用。 */
export function getVectorsOnProjectCached(db, project, activeOnly = false) {
    const s = vecState(db);
    reconcileVecGen(db); // ★ 1c（任务指定落点）：覆盖不经 vectorCacheVersion 的调用方（如 calibrate-simfloor）
    const key = `${project}\u0000${activeOnly ? 1 : 0}`;
    const hit = s.byKey.get(key);
    const now = Date.now();
    if (hit && hit.version === s.version && now - hit.at < VEC_CACHE_TTL_MS)
        return hit.vectors;
    const vectors = getVectorsOnProject(db, project, activeOnly);
    s.byKey.set(key, { version: s.version, at: now, vectors });
    return vectors;
}
/**
 * ★ P0-ANN：带缓存的 IVF-Flat ANN 索引，与向量缓存同失效周期。
 * 首次查询（或缓存失效后）同步构建索引（n<400 时 build() 直接返回，query() 返回 null，降级全量扫描）。
 * @param {ReturnType<typeof getVectorsOnProjectCached>} vectors - 已从缓存取得的向量列表（直接传入避免重复查询）
 */
export function getAnnIndexCached(db, project, activeOnly, vectors) {
    const s = vecState(db);
    const key = `${project}\u0000${activeOnly ? 1 : 0}`;
    const hit = s.annByKey.get(key);
    if (hit && hit.version === s.version) return hit.ann;
    const ann = new IvfAnnIndex();
    ann.build(vectors); // 同步构建；n<IVF_MIN_N 时即刻返回（不设 built=true）
    s.annByKey.set(key, { version: s.version, ann });
    return ann;
}
const ID_CHUNK = 400; // SQLite 变量数上限保护（默认 999，留足余量）
/** 批量读（供检索回填，避免 N+1 逐条 SELECT）；返回 id→行 映射，未命中的 id 不在 Map 中 */
export function readMemoriesByIds(db, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const part = ids.slice(i, i + ID_CHUNK);
        const ph = part.map(() => "?").join(",");
        const rows = db
            .prepare(`SELECT ${BASE_COLUMNS} FROM memories WHERE id IN (${ph})`)
            .all(...part);
        for (const r of rows)
            out.set(Number(r.id), rowOf(r));
    }
    return out;
}
/**
 * 写入决策：对 project 内现有向量做去重/冲突预检（M-1.3）
 * @returns insert=直接写；merge=命中高相似(≥0.92)已记录,conf信心+0.1；conflict=疑似冲突(0.85~0.92)
 *
 * ★ 2026-10-18（收尾 P2）：余弦只用于**选候选**，不再直接等于冲突判决。
 *   传 opts.newContent + opts.contentOf 时，用 proposition.js::classifyRelation 对候选正文做关系判定：
 *     duplicate → merge；conflict（有显式不相容信号）→ conflict；related → insert（同主题但可分辨）；
 *     unknown → insert + review=true（**待复核**，不落 conflict_with、不降置信度）。
 *   不传 opts（旧调用点/单元测试）→ 逐字保留原逐档行为，避免破坏既有断言。
 */
export function dedupeDecision(existing, newVec, newId, mergeThresh = 0.92, conflictThresh = 0.85, opts = {}) {
    let best = { id: newId, sim: -1 };
    for (const e of existing) {
        if (e.id === newId)
            continue;
        // ★ 2026-10-15 跨模型守卫：候选行若已带 embed_model/dim 出处字段（getVectorsOnProject 附带），
        //   且该条是 'unknown' 或 dim=0（尚未被 reembed 回填真实模型）→ 其向量与 newVec 不在同一
        //   语义/维度空间，cosine 比较结果接近随机数，跳过不计入 best.sim。
        //   兼容期口径：调用方传入的行若**没有** embedModel 字段（undefined，旧调用点未升级）→ 沿用原行为不跳过，
        //   不破坏未改动的调用方。
        //   方向性：宁可漏掉一条「可能本可合并」的机会（等 reembed 修正出处后补跑），
        //   不可把跨模型噪声相似度误判成 ≥0.92 强合并。
        if (e.embedModel !== undefined && (e.embedModel === "unknown" || !e.dim))
            continue;
        const s = cosine(e.vec, newVec);
        if (s > best.sim)
            best = { id: e.id, sim: s };
    }
    // 关系判定（仅当调用方提供正文与取文回调时启用；否则走旧逐档行为）
    const rel = (best.id != null && best.id !== newId && typeof opts.newContent === "string" && typeof opts.contentOf === "function")
        ? classifyRelation(opts.newContent, opts.contentOf(best.id) ?? "", { sim: best.sim })
        : null;
    if (best.sim >= mergeThresh) {
        if (rel && rel.relation !== "duplicate")
            return { action: rel.relation === "conflict" ? "conflict" : "insert", targetId: rel.relation === "conflict" ? best.id : null, sim: best.sim, relation: rel.relation, reason: rel.reason };
        return { action: "merge", targetId: best.id, sim: best.sim, relation: rel?.relation ?? null, reason: rel?.reason ?? null };
    }
    if (best.sim >= conflictThresh) {
        if (!rel || rel.relation === "conflict")
            return { action: "conflict", targetId: best.id, sim: best.sim, relation: rel?.relation ?? null, reason: rel?.reason ?? null };
        // 非冲突：related 直接入库；unknown 入库并标记待复核（既不污染 conflict_with 也不提权）
        return { action: "insert", targetId: null, sim: best.sim, relation: rel.relation, reason: rel.reason, review: rel.relation === "unknown", suspectId: best.id };
    }
    return { action: "insert", targetId: null, sim: best.sim, relation: rel?.relation ?? null, reason: rel?.reason ?? null };
}
/* ---------- ★ P0-3.4 CJK 2-gram 索引维护 ---------- */
const CJK_RE = /[\u4e00-\u9fff]/;
const GRAM_MAX_PER_DOC = 4000; // 单条正文最多建多少 gram（超长文档防写放大）
/** 抽取正文中相邻两个 CJK 字符组成的 2-gram（已去重）。非 CJK 字符会打断连续性。 */
export function gramTokens(content) {
    const out = new Set();
    let prev = "";
    for (const ch of content) {
        if (CJK_RE.test(ch)) {
            if (prev)
                out.add(prev + ch);
            prev = ch;
            if (out.size >= GRAM_MAX_PER_DOC)
                break;
        }
        else {
            prev = "";
        }
    }
    return [...out];
}
/** 取查询中「前两个连续 CJK 字符」作为索引探针；不足两个则返回 null（回退 LIKE）。 */
function cjkProbe(q) {
    const chars = [...q];
    for (let i = 0; i + 1 < chars.length; i++) {
        if (CJK_RE.test(chars[i]) && CJK_RE.test(chars[i + 1]))
            return chars[i] + chars[i + 1];
    }
    return null;
}
/** ★ P0-2.1 快速去重预检：先用 gram 粗筛候选，再 cosine 精排；降级到全量确保安全。 */
const DEDUPE_FAST_TOPK = 100; // 粗筛候选上限
/** 从内容提取 bigram 探针（同 cjkProbe 逻辑，导出供外部使用） */
export function gramProbe(content) {
    return cjkProbe(content);
}
/** 按 id 列表批量拉取 embedding（避免全表扫描）；跳过 embedding 为 null 的记录 */
export function getVectorsByIds(db, ids) {
    if (ids.length === 0)
        return [];
    const out = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const ph = chunk.map(() => "?").join(",");
        const rows = db
            .prepare(`SELECT m.id, v.embedding, m.embedding_stale
         FROM memories m
         JOIN memory_vectors v ON v.memory_id = m.id
         WHERE m.id IN (${ph})`)
            .all(...chunk);
        for (const r of rows) {
            out.push({ id: Number(r.id), vec: bufToVec(r.embedding), stale: Number(r.embedding_stale) === 1 });
        }
    }
    return out;
}
/**
 * 快速去重预检（★ P0-2.1）。
 *
 * 设计要点（含一次正确性修正）：
 *   词法粗筛**不能**安全替代全量向量比对 —— 用词完全不同但语义高度相似的记忆
 *   （如「向量检索慢」vs「embedding 查询效率低」）cosine 可能 ≥0.9，却没有任何
 *   共同 bigram。因此粗筛只作「快路径」，一旦没能拿到 ≥conflictThresh 的结果，
 *   一律降级到全量确认，绝不因为「粗筛 0 候选」就直接判 insert。
 *
 *   兜底走 getVectorsOnProjectCached：写入后会 invalidateVectorCache，故缓存内容
 *   始终等于库内最新状态（正确性不受影响），同时避免重复读取 4KB/条的 BLOB。
 */
export function dedupeDecisionFast(db, project, newVec, newContent, mergeThresh = 0.92, conflictThresh = 0.85, opts = {}) {
    const probe = gramProbe(newContent);
    if (probe) {
        const candidateRows = db
            .prepare(`SELECT DISTINCT memory_id FROM memories_gram WHERE gram = ? LIMIT ?`)
            .all(probe, DEDUPE_FAST_TOPK);
        if (candidateRows.length > 0) {
            const existing = getVectorsByIds(db, candidateRows.map((r) => r.memory_id));
            if (existing.length > 0) {
                const fast = dedupeDecision(existing, newVec, -1, mergeThresh, conflictThresh, opts);
                // 快路径成立的条件：词法候选里已存在「足够相似」的记忆。
                // 此时结果与全量一致（全量的最大值不可能小于候选子集的最大值）。
                if (fast.sim >= conflictThresh && fast.action !== "insert")
                    return fast;
            }
        }
    }
    // 兜底：粗筛无候选 / 候选不够相似 → 全量确认（走缓存，避免重复 BLOB IO）
    return dedupeDecision(getVectorsOnProjectCached(db, project), newVec, -1, mergeThresh, conflictThresh, opts);
}
/** 同步单条记忆的 gram 索引（先删后插，幂等）。无 CJK 时写空串哨兵，标记「已同步」。 */
function syncGrams(db, id, content) {
    db.prepare(`DELETE FROM memories_gram WHERE memory_id = ?`).run(id);
    const grams = gramTokens(content);
    const ins = db.prepare(`INSERT INTO memories_gram(gram, memory_id) VALUES (?, ?)`);
    if (grams.length === 0) {
        ins.run("", id); // 哨兵：避免每次启动重复回填纯英文/代码类记忆
        return;
    }
    for (const g of grams)
        ins.run(g, id);
}
/** LIKE 元字符转义：查询词里的 % _ \ 应作字面量匹配，否则 "%x%" 会退化为匹配任意内容。 */
function escapeLike(q) {
    return q.replace(/[\\%_]/g, (c) => "\\" + c);
}
/* ---------- 词法路（保留 v0.1 语义，含 scope 隔离 + 短查询 LIKE 兜底） ---------- */
/** ★ H4（R4 裁决）：词法候选池第一步强制过滤 secret —— secret 不出任何非本机前端通道。所有分支 SQL 均加。 */
const LEX_SECRET = ` AND sensitivity != 'secret'`;
export function lexSearch(db, query, project, limit = 20, statuses = ["active", "trial"]) {
    const q = query.trim();
    const stPlace = statuses.map(() => "?").join(","); // 状态白名单（默认 active/trial；归档层传 ['archived']）
    let rows;
    // FTS5 trigram 对 <3 字符（尤其中文 2 字词）不产 token；中文改为走 LIKE 兜底（实证中文 LIKE 可靠、trigram 0 命中）。
    // 判定：含 CJK → LIKE；否则按长度（>=3 走 FTS trigram，英文友好）
    const HAS_CJK = /[\u4e00-\u9fff]/;
    if (!HAS_CJK.test(q) && q.length >= 3) {
        const esc = q.replace(/"/g, '""');
        rows = db
            .prepare(`SELECT m.id, m.content, m.type, m.agent, m.project, m.status, m.confidence, m.created_at
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND m.project COLLATE NOCASE IN (?, 'global')
           AND m.status IN (${stPlace})${LEX_SECRET}
         ORDER BY bm25(memories_fts) LIMIT ?`)
            // FTS5 trigram：整体作短语查询（双引号包裹，内容含引号用 " 转义），不能用 [ ] 包裹（非法语法）
            .all(`"${esc}"`, project, ...statuses, limit);
    }
    else {
        // LIKE 元字符转义后再拼 pattern：否则查询词里的 % 会被当成通配符（"%x%" 匹配任意内容）。
        const like = `%${escapeLike(q)}%`;
        const probe = cjkProbe(q);
        if (probe) {
            // ★ P0-3.4：先用 2-gram 倒排索引把候选集收窄，再 LIKE 精筛。
            // 原实现直接 `content LIKE '%q%'` —— 前导通配符使索引完全失效，中文查询每次全表扫描。
            // bigram 命中是子串命中的必要条件，故收窄安全（不漏召回），LIKE 保证语义精确。
            // ★ 2026-09-25 P0④：排序改为「命中位置优先」——原按 created_at 倒序，会让关键词落在
            //   结尾的旧记忆压过开头即命中的新记忆，与检索意图相反。INSTR 必须用裸查询词 q
            //   （LIKE 转义串含 \ 前缀，拿去字面匹配会永远 -1）。下方纯 LIKE 兜底分支同口径。
            rows = db
                .prepare(`SELECT id, content, type, agent, project, status, confidence, created_at
           FROM memories
           WHERE id IN (SELECT memory_id FROM memories_gram WHERE gram = ?)
             AND content LIKE ? ESCAPE '\\'
             AND project COLLATE NOCASE IN (?, 'global')
             AND status IN (${stPlace})${LEX_SECRET}
           ORDER BY INSTR(content, ?) ASC, created_at DESC LIMIT ?`)
                .all(probe, like, project, ...statuses, q, limit);
        }
        else {
            // 单个 CJK 字 / <3 字符非 CJK：没有可用的 2-gram 探针，只能回退 LIKE
            rows = db
                .prepare(`SELECT id, content, type, agent, project, status, confidence, created_at
           FROM memories WHERE content LIKE ? ESCAPE '\\' AND project COLLATE NOCASE IN (?, 'global')
             AND status IN (${stPlace})${LEX_SECRET}
           ORDER BY INSTR(content, ?) ASC, created_at DESC LIMIT ?`)
                // 实参顺序必须跟随 SQL 中的占位符次序（project 在 ORDER BY 之前）
                .all(like, project, ...statuses, q, limit);
        }
    }
    return rows.map((r, i) => ({ ...rowOf(r), score: rows.length - i }));
}
/** 语义路：余弦 topN */
export function vecSearch(hitEmbed, existing, project, topN) {
    return existing
        .map((e) => ({ id: e.id, sim: cosine(hitEmbed, e.vec) }))
        .filter((x) => x.sim > 0.4)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, topN);
}
export function ftsCount(db) {
    return db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get().c;
}
export function logUsage(db, a) {
    db.prepare(`INSERT INTO memory_usage(memory_id,event,reader_agent,writer_agent,project,session_id,task_hint)
     VALUES (?,?,?,?,?,?,?)`).run(a.memory_id, a.event, a.reader_agent, a.writer_agent, a.project, a.session_id ?? null, a.task_hint ?? null);
}
export function usageCount(db, event) {
    const r = event
        ? db.prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event = ?`).get(event)
        : db.prepare(`SELECT COUNT(*) c FROM memory_usage`).get();
    return r.c;
}
/** 审计留痕（daemon/人工归档共用同一通道） */
export function logDaemon(db, t) {
    db.prepare(`INSERT INTO daemon_log(task,op,memory_id,detail,operator) VALUES (?,?,?,?,?)`).run(t.task, t.op, t.memory_id ?? null, t.detail ?? null, t.operator ?? "daemon");
}
/**
 * 执行面工具调用审计（append-only，P0 exec-audit）。
 * 调用方负责截断：argsDigest/detail 均不得写入凭据或大文本全文（大输出走 artifact 文件）。
 * 审计写入失败绝不阻断工具执行本身 —— 由调用方 try/catch 包裹。
 */
export function logExecAudit(db, r) {
    db.prepare(`INSERT INTO exec_audit(tool,agent,risk,approval,args_digest,detail,duration_ms) VALUES (?,?,?,?,?,?,?)`)
        .run(r.tool, r.agent ?? "unknown", r.risk ?? "", r.approval ?? "auto", r.argsDigest ?? null, r.detail ?? null, r.durationMs ?? null);
}
/** 读最近 N 条执行审计（看板/CLI 查证用） */
export function recentExecAudit(db, limit = 20) {
    return db.prepare(`SELECT id,tool,agent,risk,approval,args_digest,detail,duration_ms,created_at
                       FROM exec_audit ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 20)));
}
/** ★ A4：导出用全量执行审计（append-only 只读；limit 上限 5000 防内存爆，超出由调用方分页）。
 *  参数绑定（外部输入 limit 走 prepare ? 占位，绝不拼接 SQL）。 */
export function allExecAudit(db, limit = 2000) {
    return db.prepare(`SELECT id,tool,agent,risk,approval,args_digest,detail,duration_ms,created_at
                       FROM exec_audit ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(5000, Number(limit) || 2000)));
}
/* ── Agent 会话（dashboard 内置 agent 对话历史）──────────────────
 * 纪律：messages 为 JSON [{role,content}]，写入方负责截断（最新 200 条、单条 ≤3000 字，
 * 与 /api/agent/chat 的 history 截断口径一致），不存敏感凭据。
 * session_key 前端生成（uuid）；同 key 重复 save = upsert（幂等）。 */
export function listAgentSessions(db, limit = 50) {
    return db.prepare(`SELECT session_key,title,updated_at,created_at,
                              length(messages) AS msg_bytes,
                              (SELECT count(*) FROM json_each(messages)) AS msg_count
                       FROM agent_sessions ORDER BY updated_at DESC
                       LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 50)));
}
export function getAgentSession(db, sessionKey) {
    const row = db.prepare(`SELECT session_key,title,messages,created_at,updated_at FROM agent_sessions WHERE session_key = ?`).get(sessionKey);
    if (!row)
        return null;
    let messages = [];
    try { messages = JSON.parse(row.messages || "[]"); } catch { messages = []; }
    return { ...row, messages };
}
/** 新增/覆盖一个会话（upsert by session_key）。messages 数组由调用方保证已截断。 */
export function saveAgentSession(db, { sessionKey, title = "", messages = [] }) {
    db.prepare(`INSERT INTO agent_sessions(session_key,title,messages,updated_at)
               VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               ON CONFLICT(session_key) DO UPDATE SET
                 title = excluded.title,
                 messages = excluded.messages,
                 updated_at = excluded.updated_at`)
        .run(sessionKey, String(title || "").slice(0, 200), JSON.stringify(Array.isArray(messages) ? messages : []));
}
/** 向既有会话追加消息（不存在则建；幂等追加，调用方控制总长与截断） */
export function appendAgentSession(db, { sessionKey, role, content, title }) {
    const cur = getAgentSession(db, sessionKey);
    const msgs = cur ? cur.messages.slice() : [];
    msgs.push({ role: role === "assistant" ? "assistant" : "user", content: String(content ?? "") });
    // 截断：最新 200 条 + 单条 3000 字（行内 2KB 级口径，与 chat history 截断一致）
    const trimmed = msgs.slice(-200).map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 3000) }));
    saveAgentSession(db, { sessionKey, title: title ?? cur?.title ?? "", messages: trimmed });
    return trimmed.length;
}
export function deleteAgentSession(db, sessionKey) {
    const r = db.prepare(`DELETE FROM agent_sessions WHERE session_key = ?`).run(sessionKey);
    return r.changes > 0;
}
/** ★ A2：会话压缩 —— 只保留最近 keepRecent 轮（上下文管理；不改其他会话，幂等）。
 *  keepRecent 为「消息条数」而非轮数（一轮 = user+assistant 2 条）；钳制 2..200。 */
export function compactAgentSession(db, sessionKey, keepRecent = 20) {
    const cur = getAgentSession(db, sessionKey);
    if (!cur) return null;
    const keep = Math.max(2, Math.min(200, Number(keepRecent) || 20));
    const before = cur.messages.length;
    const trimmed = cur.messages.slice(-keep).map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 3000) }));
    saveAgentSession(db, { sessionKey, title: cur.title, messages: trimmed });
    return { before, after: trimmed.length };
}
/* ── ★ DSH 参考「持久 run 日志」：run 终态写读（agent_runs 表；写入方截断纪律见 schema 注释）──
 * insertAgentRun 幂等（run_id UNIQUE upsert）：内存 registry 的 finish 只在首次终态落库，
 * 重放/补写同 run_id 不产生重复行。steps_json 由调用方（路由层）做 ≤200 步 / ≤32KB 截断。 */
export function insertAgentRun(db, { runId, title = "", status, answer = "", steps = [], toolCalls = 0, usage = null, fanout = 1, elapsedMs = 0, error = "", llmModel = "" }) {
    db.prepare(`INSERT INTO agent_runs(run_id,title,status,answer,steps_json,tool_calls,usage,fanout,elapsed_ms,error,llm_model,finished_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               ON CONFLICT(run_id) DO UPDATE SET
                 status = excluded.status,
                 answer = excluded.answer,
                 steps_json = excluded.steps_json,
                 tool_calls = excluded.tool_calls,
                 usage = COALESCE(excluded.usage, agent_runs.usage),
                 fanout = excluded.fanout,
                 elapsed_ms = excluded.elapsed_ms,
                 error = excluded.error,
                 llm_model = excluded.llm_model,
                 finished_at = excluded.finished_at`)
        .run(runId, String(title || "").slice(0, 120), String(status || "failed"),
            String(answer || "").slice(0, 2000), JSON.stringify(Array.isArray(steps) ? steps : []),
            Math.max(0, Number(toolCalls) || 0),
            usage ? JSON.stringify(usage) : null,
            Math.max(1, Math.min(4, Number(fanout) || 1)),
            Math.max(0, Number(elapsedMs) || 0), String(error || "").slice(0, 500), String(llmModel || "").slice(0, 120));
}
/** 历史 run 列表（终态落库；limit 上限 100；steps_json 返回解析后数组，坏 JSON 回落 []） */
export function listAgentRuns(db, limit = 50) {
    const rows = db.prepare(`SELECT run_id,title,status,answer,tool_calls,usage,fanout,elapsed_ms,error,llm_model,created_at,finished_at
                              FROM agent_runs ORDER BY finished_at DESC LIMIT ?`)
        .all(Math.max(1, Math.min(100, Number(limit) || 50)));
    return rows.map((r) => ({ ...r, usage: r.usage ? safeParseJson(r.usage) : null }));
}
/** 单 run 全量（含 steps_json）；不存在返回 null */
export function getAgentRun(db, runId) {
    const row = db.prepare(`SELECT run_id,title,status,answer,steps_json,tool_calls,usage,fanout,elapsed_ms,error,llm_model,created_at,finished_at
                             FROM agent_runs WHERE run_id = ?`).get(runId);
    if (!row)
        return null;
    return { ...row, usage: row.usage ? safeParseJson(row.usage) : null, steps: safeParseJson(row.steps_json || "[]") };
}
function safeParseJson(s) {
    try { const v = JSON.parse(s); return v; } catch { return null; }
}
export function daemonLogCount(db, task, op) {
    const where = [];
    const args = [];
    if (task) {
        where.push("task = ?");
        args.push(task);
    }
    if (op) {
        where.push("op = ?");
        args.push(op);
    }
    const r = (where.length
        ? db.prepare(`SELECT COUNT(*) c FROM daemon_log WHERE ${where.join(" AND ")}`).get(...args)
        : db.prepare(`SELECT COUNT(*) c FROM daemon_log`).get());
    return r.c;
}
export function listEffRows(db) {
    // ★ P1-2.2：向量从独立表 JOIN（原为 memories.embedding + IS NOT NULL 过滤）
    const rows = db
        .prepare(`SELECT m.id,m.type,m.content,m.agent,m.project,m.status,m.confidence,m.eff_confidence,
              m.hit_count,m.last_hit_at,m.last_seen_at,m.created_at,
              m.sector,m.salience,m.decay_lambda,m.pinned, v.embedding
       FROM memories m
       JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.status='active'`)
        .all();
    return rows.map((r) => ({ ...rowOf(r), vec: bufToVec(r.embedding) }));
}
/** 更新有效置信（衰减/回血），并回写 eff_confidence */
export function setEff(db, id, eff) {
    db.prepare(`UPDATE memories SET eff_confidence = ? WHERE id = ?`).run(eff, id);
}
/** 归档 active 记忆（daemon 与 human 共用；留痕由调用方 logDaemon 负责） */
/** ★ 2026-09-19（实操复盘查漏）：列状态落 archived/merged 时同步任务头文本 —— 归档/合并只改列不碰头
 *  是「27 条 pending|archived 可被按 id 领取」脏数据的生产侧根源（消费侧已由 server.js assertTaskAlive 堵住）。
 *  规则：merged 列 → 头一律归一为 merged；archived 列 → 仅开放态头（pending/in_progress/blocked/review）
 *  改写为 archived（done/failed/cancelled 等终态头信息量更大，保留不动）。非任务记忆正文不动。 */
function syncTaskHeaderOnTerminal(db, id, colStatus) {
    const row = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(id);
    if (!row)
        return;
    const content = String(row.content ?? "");
    const m = content.match(/^\[task\]\[assignee:[^\]]*\]\[status:([a-z_]+)\]/);
    if (!m)
        return;
    const OPEN = new Set(["pending", "in_progress", "blocked", "review"]);
    const to = colStatus === "merged" ? "merged" : (OPEN.has(m[1]) ? "archived" : m[1]);
    if (m[1] === to)
        return;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(
        content.replace(/^(\[task\]\[assignee:[^\]]*\]\[status:)[a-z_]+(\])/, `$1${to}$2`),
        id,
    );
}
/* ★ 2026-09-25 方案A（任务看板僵尸卡·写时收敛）：卡片事件推送器注入。
 *  dashboard 进程（dashboard-reg-cards.js registerCards）启动时注入 pushCardEvt；MCP 等独立进程不注入 → 收敛仅落库（card_events 行仍在，看板水印轮询/刷新可拾）。 */
let cardEvtPusher = null;
export function setCardEvtPusher(fn) { cardEvtPusher = fn; }
/** 任务记忆的关联卡集合：cards.ref_kind='memory' 直连 + card_memory 镜像卡（去重）。 */
function linkedCardsOf(db, memoryId) {
    const out = [];
    const seen = new Set();
    for (const r of db.prepare(`SELECT id, status, meta FROM cards WHERE ref_kind='memory' AND ref_id=?`).all(memoryId)) { out.push(r); seen.add(r.id); }
    for (const r of db.prepare(`SELECT c.id, c.status, c.meta FROM card_memory cm JOIN cards c ON c.id=cm.card_id WHERE cm.memory_id=?`).all(memoryId))
        if (!seen.has(r.id)) out.push(r);
    return out;
}
/** ★ 2026-09-25 方案A：记忆终态（done 头 / archived / merged / rejected）→ 关联卡收敛。
 *  根治「活干完了、卡永远 ready」导致的任务看板「未完成」虚高（2026-09-25 实证 24 张僵尸卡）。
 *  规则：
 *   - 仅收敛开放态卡（triage/todo/ready/blocked）；running/review 在途归租约/验收主，不抢；终态不覆盖；
 *   - toStatus='done' 且卡带验收标准（meta.acceptance 非空）→ 不自动 done（M2 验收门），只留事件贴条；
 *   - 逐卡：状态守卫 UPDATE + card_events 审计 + SSE 推送（pusher 已注入时）；
 *   - 收敛失败不阻断记忆主流程（与 syncCardToTask 同口径：留痕 + 回填/对账兑底）。
 *  返回实际收敛的卡数。 */
export function convergeLinkedCards(db, memoryId, toStatus, actor = "memory-sync", detail = "") {
    try {
        const OPEN = new Set(["triage", "todo", "ready", "blocked"]);
        let changed = 0;
        for (const c of linkedCardsOf(db, memoryId)) {
            if (!OPEN.has(c.status))
                continue;
            if (toStatus === "done") {
                let meta = null;
                try {
                    meta = c.meta ? JSON.parse(c.meta) : null;
                }
                catch { meta = { acceptance: "parse-error" }; } // meta 损坏 → 保守按有验收标准处理
                const acc = meta?.acceptance;
                const hasAcc = acc != null && !(Array.isArray(acc) && acc.length === 0);
                if (hasAcc) {
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, actor, "memory_done_hold", c.status, c.status, `任务 #${memoryId} 已 done 但卡带验收标准，留 /accept 人工验收；${detail}`);
                    continue;
                }
            }
            const prev = c.status;
            db.prepare(`UPDATE cards SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status=?`).run(toStatus, c.id, prev);
            if (toStatus !== "blocked")
                db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(c.id); // 终态清租约残留（与 /status done 收口同口径）
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, actor, "memory_sync", prev, toStatus, detail || `任务 #${memoryId} → ${toStatus} 卡侧收敛`);
            if (cardEvtPusher)
                try { cardEvtPusher({ type: "memory_sync", cardId: c.id, from: prev, to: toStatus, actor, ts: Date.now() }); } catch { /* 推送失败不影响落库 */ }
            changed++;
        }
        return changed;
    }
    catch (e) {
        console.error(`[convergeLinkedCards] 卡侧收敛失败（记忆 #${memoryId} → ${toStatus}）：${e.message}`);
        return 0;
    }
}
export function archiveMemory(db, id) {
    db.prepare(`UPDATE memories SET status='archived' WHERE id = ? AND status='active'`).run(id);
    syncTaskHeaderOnTerminal(db, id, "archived"); // ★ 2026-09-19：开放态任务头随归档归一（堵脏数据生产侧）
    convergeLinkedCards(db, id, "archived", "governance:archive"); // ★ 2026-09-25 方案A：任务卡侧收敛
    invalidateVectorCache(db); // P0-4.1：active → archived 会缩小 activeOnly 候选池
}
/**
 * 归档（试用考核专用）：trial → archived。
 * ⚠️ 不可复用 archiveMemory —— 它带 `AND status='active'` 守卫（为 active 归档设计），
 * 对 trial 行会静默匹配 0 行：daemon_log 照记 archive、状态却没变。
 * 实测后果：533 条试用考核「归档」全部空转，trial 只增不减。
 */
export function archiveTrial(db, id) {
    db.prepare(`UPDATE memories SET status='archived' WHERE id = ? AND status='trial'`).run(id);
    syncTaskHeaderOnTerminal(db, id, "archived"); // ★ 2026-09-19：同 archiveMemory（堵脏数据生产侧）
    convergeLinkedCards(db, id, "archived", "governance:archive-trial"); // ★ 2026-09-25 方案A：任务卡侧收敛
    invalidateVectorCache(db); // P0-4.1
}
/** 去重合并：把 loser 置 merged + superseded_by；递增算子放在 daemon 单事务内
 *  ★ 2026-09-18（实操问题 #2，P0）：同步重写任务头文本 [status:xxx]→[status:merged]。
 *  原实现只改列 —— 头仍 pending，「移出可做集」在按 id 分支不成立（readMemory 不看列，#4256/#4257 实证）。
 *  仅当内容带任务头时改写，非任务记忆正文不动。 */
export function markMerged(db, loserId, winnerId) {
    db.prepare(`UPDATE memories SET status='merged', superseded_by = ? WHERE id = ?`).run(winnerId, loserId);
    syncTaskHeaderOnTerminal(db, loserId, "merged"); // ★ 2026-09-18（实操问题 #2，P0）：头文本同步 merged
    convergeLinkedCards(db, loserId, "archived", "governance:merge", `记忆 #${loserId} 被去重合并（主 #${winnerId}），卡片随归一`); // ★ 2026-09-25 方案A：任务卡侧收敛
    invalidateVectorCache(db); // P0-4.1：merged 不再进入检索候选
}
export { joinPrefix }; // 保留出口（格式工具，备用）
/** 写仲裁事件（before 快照 + undone 标记；撤销与审计基础） */
export function appendEvent(db, e) {
    db.prepare(`INSERT INTO memory_events(memory_id,op,payload,operator) VALUES (?,?,?,?)`).run(e.memory_id, e.op, e.payload, e.operator ?? "human:arbitrate");
}
export function pendingConflicts(db) {
    const rows = db
        .prepare(`SELECT id FROM memories WHERE status='active' AND conflict_with IS NOT NULL ORDER BY id`)
        .all();
    return rows.map((r) => {
        const pending = readMemory(db, r.id);
        const old = pending.conflict_with == null ? null : readMemory(db, pending.conflict_with);
        return { pending, old };
    });
}
/** 仲裁状态转移。key ∈ 1/2/3/4（s/q 由 TUI 处理，不落库）。写 memory_events before 快照。返回人类可读结果。 */
export function applyArbitration(db, pendingId, key) {
    const pending = readMemory(db, pendingId);
    if (!pending || pending.conflict_with == null)
        return `#${pendingId} 无待仲裁或已处理`;
    const old = readMemory(db, pending.conflict_with);
    const snap = { pending: snapRow(pending), old: old ? snapRow(old) : null, insertedId: null };
    const op = { "1": "keep_new", "2": "keep_old", "3": "merge", "4": "no_conflict" }[key];
    switch (key) {
        case "1": // 保留新：旧→superseded（检索不再出现旧值——R1 active 过滤）
            setStatus(db, old.id, "superseded", pending.id);
            clearConflict(db, pending.id, 0.8);
            break;
        case "2": // 保留旧：新→rejected，旧 conf+0.05
            setStatus(db, pending.id, "rejected");
            bumpConfidence(db, old.id, 0.05);
            clearConflict(db, pending.id, null);
            break;
        case "3": {
            // 合并：双方→merged + 新插合并行（derived_from=新id）；insertedId 记入快照供 u 撤销删除
            const ins = insertMerged(db, pending, old);
            setStatus(db, old.id, "merged", ins.id);
            setStatus(db, pending.id, "merged", ins.id);
            snap.insertedId = ins.id;
            break;
        }
        case "4": // 不冲突：双方去标签，conf 恢复 0.8
            clearConflict(db, pending.id, 0.8);
            restore(db, snapRow(readMemory(db, old.id)), 0.8);
            break;
    }
    // 引用正文保留审计；人工“不冲突”裁决解除该对来源的pending反驳关系。
    if (key === "4" && old && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_evidence'").get()) {
        db.prepare(`UPDATE knowledge_evidence SET resolution='reviewed_no_conflict'
          WHERE relation='refutes' AND resolution='pending'
            AND ((memory_id=? AND source_id=?) OR (memory_id=? AND source_id=?))`).run(pending.id,old.id,old.id,pending.id);
    }
    appendEvent(db, { memory_id: pending.id, op, payload: JSON.stringify(snap) });
    return SUMMARY[key];
}
const SUMMARY = {
    "1": "保留新：旧已 superseded（检索不再出现旧值）",
    "2": "保留旧：新已 rejected，旧 conf+0.05",
    "3": "合并：双方 -> merged，新插合并记忆",
    "4": "不冲突：双方去标签，conf 恢复 0.8",
};
/** 撤销最近一条未撤销仲裁：按 before 快照恢复双方状态，删 merge 插入行，标 undone */
export function undoLastArbitration(db) {
    const e = db
        .prepare(`SELECT id, memory_id, op, payload FROM memory_events WHERE op IN ('keep_new','keep_old','merge','no_conflict') AND undone=0 ORDER BY id DESC LIMIT 1`)
        .get();
    if (!e)
        return "无可撤销的仲裁记录";
    const snap = JSON.parse(e.payload);
    restore(db, snap.pending);
    if (snap.old)
        restore(db, snap.old);
    if (snap.insertedId != null)
        db.prepare(`DELETE FROM memories WHERE id = ?`).run(snap.insertedId);
    db.prepare(`UPDATE memory_events SET undone=1 WHERE id=?`).run(e.id);
    appendEvent(db, { memory_id: e.memory_id, op: "undo", payload: JSON.stringify({ undoEventId: e.id }) });
    return `已撤销 ${e.op}（#${e.memory_id}），状态已还原`;
}
function snapRow(r) {
    return {
        id: r.id,
        status: r.status,
        confidence: r.confidence,
        eff_confidence: r.eff_confidence,
        conflict_with: r.conflict_with,
        superseded_by: r.superseded_by,
    };
}
/** 按快照覆盖状态列（不动内容/向量/时间），conf 可选覆盖为另一值（如 4 恢复 0.8） */
function restore(db, s, confOverride) {
    db.prepare(`UPDATE memories SET status=?, confidence=?, eff_confidence=?, conflict_with=?, superseded_by=? WHERE id=?`).run(s.status, confOverride ?? s.confidence, s.eff_confidence, s.conflict_with, s.superseded_by, s.id);
    invalidateVectorCache(db); // P0-4.1：撤销仲裁会把记忆还原回 active，必须让候选池重载
}
/** 软删：置 status='rejected'（保留原文/向量/审计），供规则页删除与人仲裁复用。可选传入 operator 自动写审计。 */
export function rejectMemory(db, id, operator = "unknown") {
    setStatus(db, id, "rejected");
    // ★ 2026-10-15（架构改进第一档④）：负反馈加速衰减 —— 被显式标记过时/有误的记忆，
    //   立即把 salience 压到 0.3（×0.3），使其在**同类型、同命中量**的其他记忆之前更快跌过归档阈值
    //   （daemon archiveEff=0.1 / 45 天无曝光双判据）。rejected 状态本身已排除在检索结果之外，
    //   这里压 salience 是为了让「若有人仲裁恢复成 active」（applyArbitration 撤销 reject）时，
    //   其衰减从更低基线起跑，不会立刻回到正常活跃状态——负反馈信号被真正用上，而非只做一次性软删标记。
    // ★ 2026-10-15 修（代为提交时发现并修掉，否则本批提交门禁必红）：
    //   原写法用了 `GREATEST(salience, 0)` —— 那是 **MySQL/Oracle 的专有函数，SQLite 没有**
    //   ⇒ 该语句在本库直接抛 `no such function: GREATEST`，反馈路径（memory_feedback soft-reject）
    //   与依赖衰减评分的归档候选判定一起失效（实证：smoke-mcp / smoke-daemon 各 1 FAIL）。
    //   SQLite 的多参标量取大应写 **`max(a, b)`**（等价语义，≥2 参时 `max` 是标量函数而非聚合）。
    db.prepare(`UPDATE memories SET salience = max(salience, 0) * 0.3 WHERE id = ?`).run(id);
    convergeLinkedCards(db, id, "cancelled", "governance:reject", `记忆 #${id} 软删 rejected（${operator}），关联卡取消`); // ★ 2026-09-25 方案A：任务卡侧收敛
    logDaemon(db, { task: "reject", op: "reject", memory_id: id, operator, detail: "软删 rejected（负反馈加速衰减：salience ×0.3）" });
}
/** 按类型查列表（规则页用 type='rule'），status 为空则不限；created 倒序 */
export function queryByType(db, type, opts = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    const where = opts.status ? `status=? AND type=?` : `type=?`;
    const params = opts.status ? [opts.status, type, limit] : [type, limit];
    const rows = db
        .prepare(`SELECT ${BASE_COLUMNS} FROM memories WHERE ${where} ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`)
        .all(...params);
    return rows.map(rowOf);
}
export function setStatus(db, id, status, supersededBy) {
    if (supersededBy != null) {
        db.prepare(`UPDATE memories SET status=?, superseded_by=? WHERE id=?`).run(status, supersededBy, id);
    }
    else {
        db.prepare(`UPDATE memories SET status=? WHERE id=?`).run(status, id);
    }
    if (status === "archived" || status === "merged") {
        syncTaskHeaderOnTerminal(db, id, status); // ★ 2026-09-19：终态列流转同步任务头（堵脏数据生产侧）
        convergeLinkedCards(db, id, "archived", "governance:set-status"); // ★ 2026-09-25 方案A：任务卡侧收敛（非任务记忆无关联卡，空转）
    }
    // P0-4.1：状态流转直接决定 activeOnly 候选池；本次带出的 rejectMemory / applyArbitration 亦经此路径。
    invalidateVectorCache(db);
}
function clearConflict(db, id, confWhenNonNull) {
    if (confWhenNonNull != null) {
        db.prepare(`UPDATE memories SET conflict_with=NULL, confidence=? WHERE id=?`).run(confWhenNonNull, id);
    }
    else {
        db.prepare(`UPDATE memories SET conflict_with=NULL WHERE id=?`).run(id);
    }
    invalidateVectorCache(db); // P0-4.1
}
function insertMerged(db, a, b) {
    const content = `${a.content}\n--- 并入 #${a.id}\n${b?.content ?? ""}`.trim();
    const out = writeMemory(db, {
        content,
        type: a.type === (b?.type ?? a.type) ? a.type : "experience",
        agent: `${a.agent}+${b?.agent ?? "?"}`, // 合并为双方贡献
        agent_fpath: null,
        project: a.project,
        confidence: Math.round(((a.confidence + (b?.confidence ?? a.confidence)) / 2) * 100) / 100,
    });
    db.prepare(`UPDATE memories SET derived_from=? WHERE id=?`).run(a.id, out.id);
    db.prepare(`UPDATE memories SET embedding_stale=1 WHERE id=?`).run(out.id); // M1: 合并行无向量，置 stale 待 daemon 补算
    return out;
}

const FOLD_MAX_CHARS = 3000;
export function foldInto(db, winnerId, loserContent, meta = {}) {
    const winner = readMemory(db, winnerId);
    if (!winner) return { ok: false, reason: 'missing' };
    const loserNorm = (loserContent ?? '').trim();
    if (!loserNorm) return { ok: true, skipped: 'empty' };
    const diffSegs = _diffSegments(winner.content, loserNorm);
    const basePayload = { fromId: meta.fromId ?? null, agent: meta.agent ?? null, beforeLen: winner.content.length };
    if (diffSegs.length === 0) {
        appendEvent(db, { memory_id: winnerId, op: 'fold', payload: JSON.stringify({ ...basePayload, skipped: 'duplicate' }), operator: meta.agent ?? 'daemon' });
        return { ok: true, skipped: 'duplicate' };
    }
    const appendText = diffSegs.join('\n');
    const separator = `\n--- 并入 #${meta.fromId ?? 'new'}（${meta.agent ?? '?'}·${new Date().toISOString().slice(0, 10)}）\n`;
    const newContent = winner.content + separator + appendText;
    if (newContent.length > FOLD_MAX_CHARS) {
        appendEvent(db, { memory_id: winnerId, op: 'fold', payload: JSON.stringify({ ...basePayload, skipped: 'too_long', appendLen: appendText.length }), operator: meta.agent ?? 'daemon' });
        return { ok: true, skipped: 'too_long' };
    }
    db.prepare(`UPDATE memories SET content=?, embedding_stale=1, version=version+1 WHERE id=?`).run(newContent, winnerId);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(newContent, winnerId);
    syncGrams(db, winnerId, newContent);
    invalidateVectorCache(db);
    appendEvent(db, { memory_id: winnerId, op: 'fold', payload: JSON.stringify({ ...basePayload, afterLen: newContent.length }), operator: meta.agent ?? 'daemon' });
    return { ok: true, newLen: newContent.length };
}
function _diffSegments(winnerContent, loserContent) {
    const winFlat = winnerContent.replace(/\s+/g, ' ').toLowerCase();
    return loserContent
        .split(/(?<=[。！？\n])\s*/)
        .map(s => s.trim())
        .filter(s => s.length >= 10 && !winFlat.includes(s.replace(/\s+/g, ' ').toLowerCase()));
}

/* ── ★ 2026-10-02 Dispatch 语义（对标 orca orchestration「one authoritative Task attempt」）──
 * 权威规则：写权限**只**来自 active dispatch —— 任务头 / 卡片 / DB 行都不能单独授权写。
 * 与既有字段分工（避免「两套版本」）：
 *   - memories.version      管并发写冲突（任何改写 +1；现有 CAS 事务不动）
 *   - dispatches.generation 管尝试世代（仅接管/换代 +1）
 *   - cards.claim_lock      继续写 dispatch_key 作**投影**（卡片侧零权威）
 * 存活三态（orca 口径 live/unverifiable/exited）：租约到期只标 stale，不回收、不释放——
 *   回收必须有正向动作（接管 / 人工裁决 / 显式 release）；absence 永不授权破坏性动作。
 * key 生成由调用方负责（server-reg-task.js 已 import randomBytes），本模块零新依赖。
 */
export const DISPATCH_STATES = ["active", "settled", "released", "superseded", "stale"];
/** 按 key 读 dispatch（含非 active）；不存在/异常返回 null */
export function readDispatchByKey(db, key) {
    if (!key)
        return null;
    try {
        return db.prepare(`SELECT * FROM dispatches WHERE dispatch_key=?`).get(String(key)) ?? null;
    }
    catch {
        return null;
    }
}
/** 读某任务当前的 active dispatch（无则 null） */
export function readActiveDispatch(db, memoryId) {
    try {
        return db.prepare(`SELECT * FROM dispatches WHERE memory_id=? AND state='active'`).get(Number(memoryId)) ?? null;
    }
    catch {
        return null;
    }
}
/** 建 dispatch（接管语义）：同任务的 active / **stale** 前驱 → 先置 superseded 并继承 generation+1。
 *  「同时只有一个 active」由 idx_dispatches_active 兜底；本函数需在事务内调用才原子。
 *  ★ 批次 B1（2026-10-03）：取代范围从「仅 active」扩到「active + stale」——reaper 标 stale 的尝试属
 *    「待裁决」，被接管时若不置 superseded，会审计断链（旧记录永留 stale、不指向新世代）。 */
export function createDispatch(db, { key, memoryId, agent, sessionId = null, credentialId = null, leaseMinutes = 10 }) {
    const min = Math.max(1, Math.min(1440, Math.floor(Number(leaseMinutes) || 10)));
    // ★ generation 取该任务历史最大值 +1（不是「仅在有 active 时 +1」）——否则结算后重新认领会拿到相同世代，
    //   旧 token 与新一代无法判序，fencing 的核心（新生代永远更大）就失效了。
    const maxRow = db.prepare(`SELECT MAX(generation) g FROM dispatches WHERE memory_id=?`).get(Number(memoryId));
    const generation = Number(maxRow?.g ?? 0) + 1;
    const priorsActive = db.prepare(`SELECT id FROM dispatches WHERE memory_id=? AND state='active'`).all(Number(memoryId));
    const priorsStale = db.prepare(`SELECT id FROM dispatches WHERE memory_id=? AND state='stale'`).all(Number(memoryId));
    const priors = [...priorsActive, ...priorsStale];
    for (const p of priors)
        db.prepare(`UPDATE dispatches SET state='superseded', settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(Number(p.id));
    const r = db.prepare(`INSERT INTO dispatches(dispatch_key, memory_id, agent, session_id, credential_id, state, generation, lease_expires_at) VALUES (?,?,?,?,?,'active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?))`).run(String(key), Number(memoryId), String(agent), sessionId, credentialId, generation, `+${min} minutes`);
    const id = Number(r.lastInsertRowid);
    for (const p of priors)
        db.prepare(`UPDATE dispatches SET superseded_by=? WHERE id=?`).run(id, Number(p.id));
    const superseded = priorsActive.length ? Number(priorsActive[0].id) : priorsStale.length ? Number(priorsStale[0].id) : null;
    return { id, key: String(key), generation, superseded };
}
/** 结算：settled + outcome + evidence。orca 口径：outcome 必填，禁止只在散文里编码失败。 */
export function settleDispatch(db, dispatchId, outcome, evidence = null) {
    const oc = outcome === "failed" ? "failed" : "succeeded";
    const r = db.prepare(`UPDATE dispatches SET state='settled', outcome=?, evidence=?, settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='active'`).run(oc, evidence ? String(evidence) : null, Number(dispatchId));
    return Number(r.changes ?? 0) > 0;
}
/** 释放：未完工归还（与 settled 区分）。orca：release 是结算后清理，不是取消。 */
export function releaseDispatch(db, dispatchId, reason = null) {
    const r = db.prepare(`UPDATE dispatches SET state='released', evidence=?, settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state IN ('active','stale')`).run(reason ? String(reason) : null, Number(dispatchId));
    return Number(r.changes ?? 0) > 0;
}
/** 续租/心跳：只证存活，不证完成；顺带把 stale 唤醒回 active（absence 不是失败）。 */
export function touchDispatchLease(db, dispatchId, minutes = 10) {
    const min = Math.max(1, Math.min(1440, Math.floor(Number(minutes) || 10)));
    const r = db.prepare(`UPDATE dispatches SET state='active', heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE id=? AND state IN ('active','stale')`).run(`+${min} minutes`, Number(dispatchId));
    return Number(r.changes ?? 0) > 0;
}

/** ★ 节点画布执行器共用：卡片租约 + 工作证租约一次性续期（原三处拷贝合一，字段口径以 knowledge 版为准）。
 *  调用方自包 try/catch（打卡失败不中断执行）与 60s 定时器。 */
export function renewCardLease(db, cardId, dispatchId) {
    db.prepare(`UPDATE cards SET heartbeat_at=datetime('now'), lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), lease_notice_at=NULL, lease_stale_at=NULL WHERE id=? AND status='running'`).run(cardId);
    if (dispatchId)
        touchDispatchLease(db, dispatchId, 10);
}

/* ── ★ 批次 D1（2026-10-03）：request_id 幂等回执读写 ─────────────────────────
 * 两个函数只做「查 / 落」一件事，判定与返回文案由工具层（server-reg-task.js 单点包裹）负责——
 * 保持 db.js 无业务话术、工具层无 SQL，与既有分工一致。 */
/** 读请求回执（幂等重放命中判据）：无 request_id 或未命中 → null。 */
export function readRequestReceipt(db, requestId) {
    if (!requestId)
        return null;
    try {
        return db.prepare(`SELECT request_id, tool, agent, memory_id, result, created_at FROM request_receipts WHERE request_id=?`).get(String(requestId)) ?? null;
    }
    catch {
        return null;
    }
}
/** 落请求回执（INSERT OR IGNORE：并发首达竞争时不覆盖既有回执）。
 *  返回 true = 本次新建；false = 已存在（调用方仍原样返回本次结果即可，不阻断业务）。 */
export function saveRequestReceipt(db, { requestId, tool, agent = null, memoryId = null, result }) {
    if (!requestId)
        return false;
    const r = db.prepare(`INSERT OR IGNORE INTO request_receipts(request_id, tool, agent, memory_id, result) VALUES (?,?,?,?,?)`).run(String(requestId), String(tool), agent, memoryId == null ? null : Number(memoryId), String(result));
    return Number(r.changes ?? 0) > 0;
}
