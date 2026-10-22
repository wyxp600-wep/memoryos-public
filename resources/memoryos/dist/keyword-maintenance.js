/** 显式索引维护；检查只读，重建需 --rebuild --apply，且必须给MEMORY_DB。 */
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {installKeywordIndex,rebuildKeywordBatch,parseKeywords,keywordNorm,keywordErrors} from './memory-keywords.js';
export function checkKeywordIndex(db) {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_keywords'").get())return {ready:false,mismatches:[],note:'尚未安装关键词索引'};
    const mismatches=[];
    for(const r of db.prepare('SELECT id,content FROM memories').all()) {
        const expected=keywordErrors(r.content).length?[]:parseKeywords(r.content).map(keywordNorm).sort();
        const actual=db.prepare('SELECT term_norm FROM memory_keywords WHERE memory_id=? ORDER BY term_norm').all(r.id).map(x=>x.term_norm);
        if(JSON.stringify(expected)!==JSON.stringify(actual))mismatches.push(r.id);
    }
    const orphans=db.prepare('SELECT DISTINCT memory_id FROM memory_keywords WHERE memory_id NOT IN (SELECT id FROM memories)').all().map(r=>r.memory_id);
    return {ready:true,mismatches,orphans};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
    if(!process.env.MEMORY_DB)throw new Error('显式MEMORY_DB必需，禁止默认连接生产库');
    const rebuild=process.argv.includes('--rebuild');
    if(rebuild&&!process.argv.includes('--apply'))throw new Error('重建需要同时指定--apply');
    const db=new DatabaseSync(process.env.MEMORY_DB,{readOnly:!rebuild});
    try {
        if(rebuild){installKeywordIndex(db);let after=0,total=0;while(true){const r=rebuildKeywordBatch(db,after,200);after=r.afterId;total+=r.processed;if(r.done)break;}console.log(JSON.stringify({rebuilt:total}));}
        const result=checkKeywordIndex(db);console.log(JSON.stringify(result));
        if(!result.ready||result.mismatches.length||result.orphans?.length)process.exitCode=1;
    } finally {db.close();}
}
