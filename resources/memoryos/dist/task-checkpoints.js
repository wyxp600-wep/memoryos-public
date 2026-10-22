/** 持久任务检查点：卡片是任务锚点，session 只是某次执行。检查点不改变任务状态。 */
import { z } from 'zod';
const text = z.string().trim().min(1).max(2000);
export const checkpointSchema = z.object({
    goal:text, acceptance:text, completed:z.array(z.object({result:text,evidence:text})).max(30),
    pending:z.array(text).max(30), blockers:z.array(text).max(20),
    decisions:z.array(z.object({decision:text,scope:text,evidence:text})).max(20),
    next_step:text, workspace:text, environment:text,
    verified_at:z.string().datetime().refine(v=>Date.parse(v)<=Date.now(),'核验时间不得晚于现在'),
    review_after:z.string().datetime().optional(),
}).strict().refine(v=>JSON.stringify(v).length<=16000,'检查点总长不得超过16000字符');
export function installCheckpointStore(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_checkpoints(
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, session_id TEXT NOT NULL, author TEXT NOT NULL,
      payload TEXT NOT NULL, task_state TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(card_id,version));`);
}
function stateOf(db, cardId, project) {
    const c = db.prepare('SELECT id,kind,board,title,body,status,assignee,claim_lock,workspace,ref_kind,ref_id,meta,updated_at FROM cards WHERE id=?').get(cardId);
    if (!c || c.kind !== 'task') throw new Error('检查点只接受存在的任务卡');
    const m = c.ref_kind === 'memory' && c.ref_id ? db.prepare('SELECT project,sensitivity FROM memories WHERE id=?').get(c.ref_id) : null;
    if (m?.sensitivity === 'secret') throw new Error('不允许读取秘密任务');
    // board是布局看板而非项目。绑定记忆的项目优先；普通卡使用显式meta.project，否则global。
    let meta={};
    if(c.meta){try{meta=JSON.parse(c.meta);}catch{throw new Error('任务元数据无效，无法确认scope');}}
    const scope = m?.project ?? (typeof meta.project==='string'&&meta.project.trim()?meta.project:'global');
    if (String(scope).toLowerCase() !== String(project).toLowerCase()) throw new Error('任务scope不匹配');
    const d = c.ref_kind==='memory'&&c.ref_id ? db.prepare("SELECT id,generation,state,agent,dispatch_key FROM dispatches WHERE memory_id=? ORDER BY generation DESC LIMIT 1").get(c.ref_id) : null;
    return { card:c, dispatch:d, scope };
}
function publicState(s) {
    const {claim_lock,meta,...card} = s.card;
    const dispatch = s.dispatch ? {id:s.dispatch.id,generation:s.dispatch.generation,state:s.dispatch.state,agent:s.dispatch.agent} : null;
    return {card,dispatch,scope:s.scope};
}
export function writeCheckpoint(db, args, auth) {
    const payload=checkpointSchema.parse(args.checkpoint);
    db.exec('SAVEPOINT task_checkpoint');
    try {
        const s=stateOf(db,args.task_card_id,args.project);
        auth.authorize();
        if (s.card.assignee && s.card.assignee !== auth.agent) throw new Error('当前Agent不是任务认领人');
        if (s.card.claim_lock && args.claim_token !== s.card.claim_lock) throw new Error('卡片认领凭证不匹配');
        if (s.dispatch?.state === 'active' && (s.dispatch.agent !== auth.agent || args.dispatch_key !== s.dispatch.dispatch_key)) throw new Error('活动派发凭证不匹配');
        const current=db.prepare('SELECT version FROM task_checkpoints WHERE card_id=? ORDER BY version DESC LIMIT 1').get(args.task_card_id)?.version ?? 0;
        if (args.expected_version !== current) throw new Error(`检查点版本漂移：当前v${current}，请重新读取`);
        const version=current+1;
        db.prepare('INSERT INTO task_checkpoints(card_id,version,session_id,author,payload,task_state) VALUES(?,?,?,?,?,?)')
            .run(args.task_card_id,version,args.session_id,auth.agent,JSON.stringify(payload),JSON.stringify(publicState(s)));
        db.exec('RELEASE task_checkpoint');
        return {ok:true,card_id:args.task_card_id,version};
    } catch(e) { db.exec('ROLLBACK TO task_checkpoint; RELEASE task_checkpoint'); throw e; }
}
export function readCheckpoint(db,args) {
    const s=stateOf(db,args.task_card_id,args.project);
    const r=db.prepare('SELECT * FROM task_checkpoints WHERE card_id=? ORDER BY version DESC LIMIT 1').get(args.task_card_id);
    const authoritative=publicState(s);
    const checkpoint=r ? {version:r.version,author:r.author,session_id:r.session_id,created_at:r.created_at,...JSON.parse(r.payload)} : null;
    const changed=!!r && r.task_state!==JSON.stringify(authoritative);
    const expired=!!checkpoint?.review_after && Date.parse(checkpoint.review_after)<=Date.now();
    return {task:authoritative,checkpoint,state_changed:changed,review_due:expired,requires_recheck:changed||expired,
        instruction:'任务状态以task为准；检查点是待现场核验的交接说明，不构成认领、重试、部署或完成授权。按next_step检索适用经验，核对工作区与证据后继续。'};
}
