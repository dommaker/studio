/**
 * skill-selector (AS-025 3.28c-5)
 *
 * 基于 description 的 Skill 匹配。无 LLM，纯代码。
 * 三策略：全文子串 + token 子串 + 4-gram 重叠。
 * 匹配时排除 NOT-for 子句，避免排除项关键词触发误匹配。
 *
 * AC2: 根据 scope 匹配 Skill
 */
import type { SkillEntry } from './manifest-loader.js';
import { logger } from '@dommaker/studio-shared';

/** 去除标点和空白，保留字母数字和中文字符 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s,，。、；;：:！!？?（）()\[\]{}【】「」""''《》<>\-_/\\·…]+/g, '');
}

/**
 * 去除 NOT-for 子句：截断"不用于"或"NOT for"之后的内容。
 * 保留正面描述，排除排除项中的关键词干扰。
 */
function stripNotFor(text: string): string {
  const markers = ['不用于', '不用于', 'NOT for', 'NOT for'];
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx > 0) return text.substring(0, idx);
  }
  return text;
}

/**
 * 按中英文标点分词，返回长度 ≥ 2 的 token。
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。、；;：:！!？?（）()\[\]{}【】「」""''《》<>\-_/\\·…]+/)
    .filter(t => t.length >= 2);
}

/**
 * 策略 1：token 子串匹配
 * 将 scope 按标点分词，检查 scope token（≥4 字符）是否是 description 正面描述的某个 token 的子串。
 * 最小长度 4：避免"用户""知识""测试"等常见 2-3 字符词的误匹配。
 */
function tokenMatch(scopeNorm: string, descPositive: string): boolean {
  const scopeTokens = tokenize(scopeNorm).filter(t => t.length >= 4);
  const descTokens = tokenize(descPositive);
  if (scopeTokens.length === 0 || descTokens.length === 0) return false;

  return scopeTokens.some(st =>
    descTokens.some(dt => dt.includes(st))
  );
}

/**
 * 策略 2：N-gram 重叠
 * 检查 scope 和 description 是否共享 ≥ minLen 连续字符。
 * 用于兜底：当 token 匹配失败时，处理词序差异。
 */
function sharesNgram(a: string, b: string, minLen: number): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i <= shorter.length - minLen; i++) {
    if (longer.includes(shorter.substring(i, i + minLen))) return true;
  }
  return false;
}

/**
 * Select skills matching the given scope text.
 *
 * 匹配策略（按优先级）：
 * 1. 全文子串：scope 是 description 正面描述子串
 * 2. Token 子串：scope 分词后，某 token（≥4字符）是正面描述分词后某 token 的子串
 * 3. 4-gram 重叠：scope 和正面描述共享 ≥4 连续字符
 */
export function selectSkills(scope: string, skills: SkillEntry[]): SkillEntry[] {
  if (!scope) return [];

  const scopeNorm = normalize(scope);
  if (!scopeNorm) return [];

  const matched = skills.filter(skill => {
    const positive = stripNotFor(skill.description);
    const descNorm = normalize(positive);
    if (!descNorm) return false;
    return descNorm.includes(scopeNorm)
      || scopeNorm.includes(descNorm)
      || tokenMatch(scopeNorm, descNorm)
      || sharesNgram(scopeNorm, descNorm, 4);
  });

  // [Skill Discovery] Log matching results
  logger.info(`[SkillDiscovery] scope="${scope}" matched=[${matched.map(s => s.name).join(',')}]`);

  return matched;
}
