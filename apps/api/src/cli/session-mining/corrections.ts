/**
 * 纠正信号模式表与概念清洗
 * （自 harness src/cli/session-mining/corrections.ts 迁入，ADR-0019；原工单 19-C）
 *
 * 合并 analyze-sessions 与 update-user-model 两份几乎相同的模式表，
 * 采用较宽窗口（update-user-model 版本）作为唯一实现。
 */

/** 用户纠正/重复强调语句的匹配模式（两命令合并后的超集，取较宽窗口） */
export const CORRECTION_PATTERNS: RegExp[] = [
  /你(?:又|还是)(?:在)?(?:犯|忘|没|不).{0,30}?[了]?/g,
  /我不是(?:说|让|让做|讲)[了过]?.{0,50}?[了吗?？]?/g,
  /怎么(?:又|还|老)(?:是|在)?.{0,30}?[了]?/g,
  /我(?:一直|反复|总是)(?:在|说|强调)?.{0,30}?[了]?/g,
  /老(?:是|在|犯|忘)(?:了)?.{0,20}?[了]?/g,
  /这(?:个|种)(?:问题|模式|错误).{0,20}?[.。！]?/g,
  /(?:第[一二三四五六七八九十\d]+次|反复|重复)(?:说|提醒|强调).{0,20}?/g,
  /不(?:要|能|想|愿意).{0,20}?老.{0,10}?[了]?/g,
  /(?:补上|加上|记上|修复).{0,10}?[了吗?？]?/g,
  /(?:沉淀|监控|日志|记录).{0,5}?[了吗?？]?/g,
];

/** 纠正语句前缀（提取概念时剥离） */
const CORRECTION_PREFIX_STRIP: RegExp[] = [
  /你(?:又|还是)(?:在)?(?:犯|忘|没|不)/g,
  /我不是(?:说|让|让做|讲)[了过]?/g,
  /怎么(?:又|还|老)(?:是|在)?/g,
  /我(?:一直|反复|总是)(?:在|说|强调)?/g,
  /老(?:是|在|犯|忘)(?:了)?/g,
];

/**
 * 从纠正语句中提取概念：剥离纠正前缀与标点
 */
export function cleanCorrectionConcept(sentence: string): string {
  let cleaned = sentence;
  for (const re of CORRECTION_PREFIX_STRIP) {
    re.lastIndex = 0;
    cleaned = cleaned.replace(re, '');
  }
  return cleaned.replace(/[，。！？、；：""''（）\s]+/g, '').trim();
}

/**
 * 用模式表在文本中抽取纠正语句（去重）
 */
export function extractCorrectionMatches(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of CORRECTION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      matches.push(match[0].trim());
    }
  }
  return matches;
}
