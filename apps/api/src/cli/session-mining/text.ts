/**
 * 分词 / 停用词 / 相似度 / 文本清洗
 * （自 harness src/cli/session-mining/text.ts 迁入，ADR-0019；原工单 19-C）
 *
 * 合并 analyze-sessions 与 update-user-model 的重复实现。
 */

/** N-gram 停用词表（中英） */
export const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  '因为', '所以', '但是', '而且', '如果', '虽然', '可以', '这个', '那个',
  '什么', '怎么', '哪', '吗', '吧', '呢', '啊', '嗯', '哦',
]);

const CN_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * 中英文混合分词：中文产出 bigram/trigram（短序列保留整体），
 * 连续的拉丁/数字/路径字符作为整体 token。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';

  for (const char of text) {
    if (CN_CHAR.test(char)) {
      current += char;
    } else if (/[a-zA-Z0-9_\-/.]/.test(char)) {
      current += char;
    } else {
      pushToken(current, tokens);
      current = '';
    }
  }
  pushToken(current, tokens);

  return tokens;
}

function pushToken(current: string, tokens: string[]): void {
  if (current.length < 2) return;
  if (CN_CHAR.test(current)) {
    for (let i = 0; i <= current.length - 2; i++) {
      tokens.push(current.slice(i, i + 2));
    }
    for (let i = 0; i <= current.length - 3; i++) {
      tokens.push(current.slice(i, i + 3));
    }
    if (current.length <= 6) tokens.push(current);
  } else {
    tokens.push(current);
  }
}

/**
 * 基于 tokenize 的 Jaccard 相似度
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * 仅取汉字字符集的 Jaccard 相似度（概念聚类用）
 */
export function jaccardChinese(a: string, b: string): number {
  const charsA = new Set(a.split('').filter(c => /[\u4e00-\u9fff]/.test(c)));
  const charsB = new Set(b.split('').filter(c => /[\u4e00-\u9fff]/.test(c)));
  if (charsA.size === 0 || charsB.size === 0) return 0;
  const intersection = new Set([...charsA].filter(x => charsB.has(x)));
  const union = new Set([...charsA, ...charsB]);
  return intersection.size / union.size;
}

/**
 * 剥离代码块 / 行内代码 / JSON 片段，保留自然语言
 */
export function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\{[^{}]*"[^"]+"\s*:\s*"[^"]*"[^}]*\}/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    .replace(/\\n/g, ' ')
    .replace(/[{}[\]"':,\\]+/g, ' ');
}

/** 是否纯标点/空白 */
export function isPunctuation(str: string): boolean {
  return /^[，。！？、；：""''（）[\]【】「」『』《》〈〉\s]+$/.test(str);
}

/** 是否含语义内容（汉字，或 ≥7 字符的合法英文标识词） */
export function hasSemanticContent(phrase: string): boolean {
  if (/[\u4e00-\u9fff]/.test(phrase)) return true;
  if (phrase.length >= 7 && /^[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z]$/.test(phrase)) return true;
  return false;
}

/** 是否代码噪声（短拉丁片段 / 常见 JSON 字段名碎片） */
export function isCodeNoise(phrase: string): boolean {
  if (!/[\u4e00-\u9fff]/.test(phrase) && phrase.length <= 6) return true;
  if (/^(?:clla|cood|odde|oppe|laaw|peen|enne|ennc|ddec|deco|ecod|code|type|role|name|text|file|path|tool|user|session)$/i.test(phrase)) return true;
  return false;
}
