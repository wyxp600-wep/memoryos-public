/** 智能体新写入统一六字段换行格式；历史正文不迁移。 */
import { z } from 'zod';
import { keywordErrors, keywordValidationSQL } from './memory-keywords.js';
import { BODY_FIELDS, memoryFields, bodyCTE } from './memory-fields.js';
export const MEMORY_BODY_TEMPLATE = '结论：\n在〔具体条件〕下，〔方法〕能够解决〔明确症状〕。\n\n关键词：\n〔3～5个准确的组件名、错误码或症状，分号分隔〕\n\n适用范围：\n〔项目、版本、环境、触发条件及例外〕。\n\n依据：\n〔可回查的日志或代码位置、复现步骤、预期与实际结果〕。\n\n行动：\n先检查〔条件〕；满足后执行〔具体步骤〕；出现〔异常〕时停止。\n\n状态：\n〔待验证／已验证／已替代〕，最后核验日期：〔实际检查日期YYYY-MM-DD〕。';
export const MEMORY_BODY_GUIDE = '所有智能体新增及修订知识记忆统一六字段：结论、关键词、适用范围、依据、行动、状态。字段名单独一行，内容下一行，各字段空一行；关键词3～5个具体组件名、错误码或症状，分号分隔，总长≤160字，每词≤80字且不重复。每条一个可复用判断；明确项目、版本、环境、触发条件和例外，不把一次失败推广为永久不可用。依据须有可回查的日志或代码位置、复现步骤及预期与实际结果，不能只写已测试通过；行动须包含先检查什么、满足何条件再执行及异常停止条件。进度与下一步放任务检查点。状态为待验证/已验证/已替代，缺证据标待验证，最后核验日期只填实际检查日期，不编造。历史五字段仅兼容读取；新写入与正文修订不合格式会拒绝；任务卡、人工内容及原始笔记导入保留各自格式。';
const TASK_HEAD = /^\[task\]\[assignee:[^\]]*\]\[status:/;
export function isStructuredMemoryBody(content) { return /^结论[：:]/.test(String(content).replace(/\*\*/g,'').trim()); }
export function memoryBodyErrors(content, { allowTask = false } = {}) {
    if(typeof content!=='string') return ['正文必须为字符串'];
    if(allowTask&&TASK_HEAD.test(content))return [];
    const fields=memoryFields(content), errors=[];
    if(fields.map(f=>f.name).join('|')!==BODY_FIELDS.join('|')) return ['必须按顺序各填写一次：结论、关键词、适用范围、依据、行动、状态'];
    if(fields[0].index!==0)errors.push('正文从结论字段开始，不加无关前缀');
    for(const f of fields){
        if(f.inline.trim())errors.push(`${f.name}字段名须单独一行，内容放下一行`);
        if(!f.value||/^(?:待填|TODO|TBD|\.\.\.|…|[—-]+)$/i.test(f.value)||/〔|〕/.test(f.value))errors.push(`${f.name}不能为空或占位符`);
    }
    errors.push(...keywordErrors(content,{strict:true}));
    const state=fields.at(-1).value;
    if(!/^(已验证|待验证|已替代)(?=$|[\s;；,，。:：(（/／])/.test(state))errors.push('状态必须为已验证、待验证或已替代');
    const dates=[...state.matchAll(/最后核验日期\s*:\s*(\d{4}-\d{2}-\d{2})(?!\d)/g)];
    if(dates.length!==1)errors.push('状态中须包含一次最后核验日期: YYYY-MM-DD');
    else {
        const day=dates[0][1],parsed=new Date(day+'T00:00:00Z'),now=new Date();
        const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==day||day>today)errors.push('最后核验日期必须有效且不得晚于今天');
    }
    return errors;
}
export function memoryBodySchema(options={}) {
    return z.string().superRefine((content,ctx)=>{const errors=memoryBodyErrors(content,options);if(errors.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:`MEMORY_BODY_FORMAT：${errors.join('；')}。未写入，请按模板修正：\n${MEMORY_BODY_TEMPLATE}`});}).describe(MEMORY_BODY_GUIDE+'\n'+MEMORY_BODY_TEMPLATE);
}
export function installMemoryBodyGuard(db) {
    const fields=BODY_FIELDS;
    const positions=fields.map((f,i)=>`instr(char(10)||s,char(10)||'${f}:') p${i}`).join(',');
    const values=fields.map((f,i)=>`trim(substr(s,p${i}+${f.length+1},${i<5?`p${i+1}-p${i}-${f.length+1}`:'length(s)'}),char(10)||' ') v${i}`).join(',');
    const unique=fields.map(f=>`length(char(10)||s)-length(replace(char(10)||s,char(10)||'${f}:',''))=length(char(10)||'${f}:')`).join(' AND ');
    const standalone=fields.map(f=>`instr(char(10)||(SELECT s FROM body_clean)||char(10),char(10)||'${f}:'||char(10))>0`).join(' AND ');
    const nonempty=fields.map((_,i)=>`length(v${i})>0 AND upper(v${i}) NOT IN ('待填','TODO','TBD','...','…','-','—') AND instr(v${i},'〔')=0 AND instr(v${i},'〕')=0`).join(' AND ');
    const check=`${bodyCTE('NEW.content')}, pos AS (SELECT s,${positions} FROM body_norm), vals AS (SELECT *,${values} FROM pos), dated AS (SELECT *,substr(trim(substr(v5,instr(v5,'最后核验日期:')+7)),1,10) d FROM vals)
      SELECT CASE WHEN coalesce((SELECT p0=1 AND p1>p0 AND p2>p1 AND p3>p2 AND p4>p3 AND p5>p4 AND ${unique} AND ${standalone} AND ${nonempty}
        AND substr(v5,1,3) IN ('已验证','待验证','已替代') AND (length(v5)=3 OR instr(' ;；,，。:：(（/／'||char(10),substr(v5,4,1))>0)
        AND instr(v5,'最后核验日期:')>0 AND length(v5)-length(replace(v5,'最后核验日期:',''))=7
        AND d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(trim(substr(v5,instr(v5,'最后核验日期:')+7)),11,1) NOT GLOB '[0-9]' AND date(d,'+0 days')=d AND d<=date('now','localtime') FROM dated),0)=0
      THEN RAISE(ABORT,'MEMORY_BODY_FORMAT: 六字段名各占一行，内容另起一行；结论、关键词、适用范围、依据、行动、状态及实际核验日期') END;`;
    db.exec('SAVEPOINT body_guard_v3');
    try {
        removeMemoryBodyGuard(db);
        for(const [suffix,event,extra] of [['insert','INSERT',''],['update','UPDATE OF content',' AND NEW.content IS NOT OLD.content']]){
            db.exec(`CREATE TRIGGER memory_body_v3_${suffix} BEFORE ${event} ON memories WHEN NEW.source='agent' AND NEW.type!='task'${extra} BEGIN ${check}
              SELECT CASE WHEN (${keywordValidationSQL('NEW.content',true)})!=1 THEN RAISE(ABORT,'MEMORY_BODY_FORMAT: 关键词须为3～5个非空不重复词，每词≤80字，总长≤160字') END; END;`);
        }
        db.exec('RELEASE body_guard_v3');
    }catch(e){db.exec('ROLLBACK TO body_guard_v3; RELEASE body_guard_v3');throw e;}
}
export function removeMemoryBodyGuard(db) {
    for(const v of [1,2,3]) for(const suffix of ['insert','update'])db.exec(`DROP TRIGGER IF EXISTS memory_body_v${v}_${suffix}`);
}
