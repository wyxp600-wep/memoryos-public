/** 正文保持原样；解析时兼容历史行内格式与六字段换行格式。 */
export const BODY_FIELDS = ['结论','关键词','适用范围','依据','行动','状态'];
export function canonicalBody(content) {
    return String(content).replace(/\r\n?/g,'\n').replace(/\*\*/g,'').replace(/：/g,':').split('\n').map(s=>s.trim()).filter(Boolean).join('\n');
}
export function normalizedBody(content) {
    return canonicalBody(content).replace(/^(结论|关键词|适用范围|依据|行动|状态):\n/gm,'$1:');
}
export function memoryFields(content) {
    const s=canonicalBody(content), heads=[...s.matchAll(/^(结论|关键词|适用范围|依据|行动|状态):([^\n]*)/gm)];
    return heads.map((m,i)=>({name:m[1], inline:m[2], value:s.slice(m.index+m[1].length+1,heads[i+1]?.index??s.length).trim(),index:m.index}));
}
/** SQLite 旧连接也能执行；不依赖连接内 JS 函数。与 canonicalBody/normalizedBody 同口径。 */
export function bodyCTE(expr) {
    let normalized='s';
    for(const f of BODY_FIELDS) normalized=`replace(${normalized},'${f}:'||char(10),'${f}:')`;
    const whitespace=[9,10,11,12,13,32,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279].map(n=>`char(${n})`).join('||');
    return `WITH RECURSIVE body_raw(s) AS (SELECT trim(replace(replace(replace(replace(replace(${expr},char(13)||char(10),char(10)),char(13),char(10)),'**',''),'：',':'),char(9),' '),${whitespace})),
      body_lines(rest,line,n) AS (SELECT s||char(10),'',0 FROM body_raw UNION ALL SELECT substr(rest,instr(rest,char(10))+1),trim(substr(rest,1,instr(rest,char(10))-1),${whitespace}),n+1 FROM body_lines WHERE length(rest)>0),
      body_clean(s) AS (SELECT coalesce(group_concat(line,char(10)),'') FROM (SELECT line FROM body_lines WHERE line!='' ORDER BY n)),
      body_norm(s) AS (SELECT ${normalized} FROM body_clean)`;
}
