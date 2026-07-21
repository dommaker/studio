/**
 * skill-selector (AS-025 3.28c-5)
 *
 * 基于 triggers / description 的 Skill 匹配。无 LLM，纯代码。
 * 三策略：全文子串 + token 子串 + 4-gram 重叠。
 * 匹配时排除 NOT-for 子句，避免排除项关键词触发误匹配。
 * 声明了 triggers 的 skill 用 triggers 匹配（替代 description）；
 * consumers 含 'loop' 的 hub-service skill 不参与 WU 匹配。
 *
 * AC2: 根据 scope 匹配 Skill
 */
import type { SkillEntry } from './manifest-loader.js';
import { logger } from '@dommaker/studio-shared';

/** 判断是否为 hub-service skill（consumers 含 loop）——不参与 WU/角色匹配 */
function isLoopConsumer(skill: SkillEntry): boolean {
  return Array.isArray(skill.consumers) && skill.consumers.some(c => c.toLowerCase() === 'loop');
}

/**
 * 取 skill 的匹配目标文本：
 * - 有 triggers → triggers 拼接（匹配只针对关键词，忽略长 description）
 * - 无 triggers → description 正面描述（保留原有行为）
 */
function matchTarget(skill: SkillEntry): string {
  if (Array.isArray(skill.triggers) && skill.triggers.length > 0) {
    return skill.triggers.join(' ');
  }
  return stripNotFor(skill.description);
}

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
 * 1. 全文子串：scope 是匹配目标（triggers 或 description 正面描述）子串
 * 2. Token 子串：scope 分词后，某 token（≥4字符）是匹配目标分词后某 token 的子串
 * 3. 4-gram 重叠：scope 和匹配目标共享 ≥4 连续字符
 *
 * consumers 含 'loop' 的 hub-service skill 不参与匹配。
 */
export function selectSkills(scope: string, skills: SkillEntry[]): SkillEntry[] {
  if (!scope) return [];

  const scopeNorm = normalize(scope);
  if (!scopeNorm) return [];

  const matched = skills.filter(skill => {
    if (isLoopConsumer(skill)) return false;
    const target = normalize(matchTarget(skill));
    if (!target) return false;
    return target.includes(scopeNorm)
      || scopeNorm.includes(target)
      || tokenMatch(scopeNorm, target)
      || sharesNgram(scopeNorm, target, 4);
  });

  // [Skill Discovery] Log matching results
  logger.info(`[SkillDiscovery] scope="${scope}" matched=[${matched.map(s => s.name).join(',')}]`);

  return matched;
}

// ─── 域匹配（§10.3：角色 × skill 动态绑定）───

/** WU type 关键词集 —— 与 agent-loop parseAcceptedTypes 保持一致 */
export const TYPE_KEYWORDS = ['task', 'bug', 'feature', 'refactor', 'test', 'docs', 'review', 'analysis'];

/**
 * 从角色 description 解析职能域（acceptedTypes）。
 * 与 agent-loop.ts parseAcceptedTypes 同一关键词集（纯代码零 LLM）。
 */
export function parseAcceptedTypesFromDescription(description: string | null | undefined): string[] {
  if (!description) return [];
  return TYPE_KEYWORDS.filter(kw => description.toLowerCase().includes(kw));
}

/**
 * 域匹配 + scope 匹配的合成选择（§10 P0）。
 *
 * 主信号：域交集 (acceptedTypes ∪ wuType) ∩ skill.agentTypes；
 * 次级信号：现有 scope 文本匹配（未声明 agentTypes 的 skill 仍可命中）。
 * 合并顺序：域匹配在前，scope 匹配在后，按 name 去重，封顶 maxSkills 个。
 * 仅 status 缺省或 'published' 的 skill 参与（防御式过滤——loadManifest 已过滤）。
 * consumers 含 'loop' 的 hub-service skill 不参与（域匹配与 scope 匹配均排除）。
 */
export function selectSkillsWithDomain(
  scope: string,
  skills: SkillEntry[],
  domain: { acceptedTypes?: string[]; wuType?: string },
  maxSkills = 3,
): SkillEntry[] {
  const active = skills.filter(s => (!s.status || s.status === 'published') && !isLoopConsumer(s));

  const domainTypes = new Set(
    [...(domain.acceptedTypes ?? []), domain.wuType].filter((t): t is string => !!t),
  );
  const domainMatched = domainTypes.size > 0
    ? active.filter(s => Array.isArray(s.agentTypes) && s.agentTypes.some(t => domainTypes.has(t)))
    : [];

  const scopeMatched = scope ? selectSkills(scope, active) : [];

  const seen = new Set<string>();
  const merged: SkillEntry[] = [];
  for (const entry of [...domainMatched, ...scopeMatched]) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    merged.push(entry);
    if (merged.length >= maxSkills) break;
  }

  logger.info(`[SkillDiscovery] domain matched=[${domainMatched.map(s => s.name).join(',')}] final=[${merged.map(s => s.name).join(',')}]`);

  return merged;
}
