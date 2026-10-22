/** 专项与协议测试夹具；不是生产事实或自动证据。 */
export function bodyFixture(text) {
    if(/^结论[：:]\s*\n/.test(String(text)))return text;
    return `结论：\n${text}\n\n关键词：\nMemoryOS；隔离测试；模板探针\n\n适用范围：\n隔离测试环境。\n\n依据：\n本脚本受控样例与断言，非事实证明。\n\n行动：\n先查隔离路径；满足后执行断言；遇生产库停止。\n\n状态：\n待验证；最后核验日期：2026-10-21。`;
}
