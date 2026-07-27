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
 *
 * 决策 7/11（2026-07-27 治理文档）：匹配器降级为「排序器」——
 * 产出相关度排序全量列表（不封顶），由调用方按注入预算截断；
 * `+skill名` 显式点名在 step 时从 scope 解析（parseSkillHintsFromScope），路由层不认识 skill。
 */
import type { SkillEntry } from './manifest-loader.js';
import { logger, normalizeToStage } from '@dommaker/studio-shared';

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

// ─── 域匹配（§10.3：角色 × skill 动态绑定；决策 7/8/11：排序器 + 阶段词表 + +skill 解耦）───

/**
 * 决策 11: 从 scope 文本解析 `+skill名` 显式点名（全部出现，按序去重）。
 * token 保留在 scope 原文中不改写；DELEGATE 链式继承自动成立（子 WU scope 同路径解析）。
 */
export function parseSkillHintsFromScope(scope: string): string[] {
  const hints: string[] = [];
  for (const match of scope.matchAll(/\+([\w-]+)/g)) {
    if (!hints.includes(match[1])) hints.push(match[1]);
  }
  return hints;
}

/** 「其余 published」排序：引用数降序 > 更新时间降序 > 名称序（manifest 未回填这些字段时兜底） */
function compareByPopularity(a: SkillEntry, b: SkillEntry): number {
  if (a.referenceCount != null && b.referenceCount != null && a.referenceCount !== b.referenceCount) {
    return b.referenceCount - a.referenceCount;
  }
  if (a.updatedAt && b.updatedAt && a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 域匹配 + scope 匹配的合成选择（§10 P0；决策 7：匹配器降级为排序器）。
 *
 * 产出相关度排序的全量列表（不再封顶——由调用方按注入预算截断）：
 *   1. 显式 hints（+skill名，按名精确解析，保持点名顺序）最前
 *   2. 域匹配：(acceptedTypes ∪ wuType) 归一化到阶段词表后 ∩ skill.agentTypes（同样归一化）
 *   3. scope 文本匹配（未声明 agentTypes 的 skill 仍可命中）
 *   4. 其余 published 按引用数/更新时间（未回填则按名称序兜底）
 * 按 name 去重。仅 status 缺省或 'published' 的 skill 参与（防御式过滤——loadManifest 已过滤）；
 * consumers 含 'loop' 的 hub-service skill 不参与（含 hint 点名——hub 专用，不进 WU）。
 */
export function selectSkillsWithDomain(
  scope: string,
  skills: SkillEntry[],
  domain: { acceptedTypes?: string[]; wuType?: string },
  skillHints: string[] = [],
): SkillEntry[] {
  const active = skills.filter(s => (!s.status || s.status === 'published') && !isLoopConsumer(s));

  // 决策 11 显式覆盖：hint 逐名解析，未知/不活跃/loop-only 跳过并记日志
  const hinted: SkillEntry[] = [];
  for (const hint of skillHints) {
    const entry = active.find(e => e.name === hint);
    if (!entry) {
      logger.warn('[SkillDiscovery] Skill hint not found or not eligible (skipped)', { hint });
      continue;
    }
    hinted.push(entry);
  }

  // 决策 8：wuType 与 acceptedTypes（及 skill.agentTypes）先经 normalizeToStage 归一化再求交集
  const domainTypes = new Set(
    [...(domain.acceptedTypes ?? []), domain.wuType]
      .filter((t): t is string => !!t)
      .map(normalizeToStage),
  );
  const domainMatched = domainTypes.size > 0
    ? active.filter(s => Array.isArray(s.agentTypes) && s.agentTypes.some(t => domainTypes.has(normalizeToStage(t))))
    : [];

  const scopeMatched = scope ? selectSkills(scope, active) : [];

  const seen = new Set<string>();
  const merged: SkillEntry[] = [];
  for (const entry of [...hinted, ...domainMatched, ...scopeMatched]) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    merged.push(entry);
  }
  // 其余 published 殿后（热度/名称序），产出全量排序列表
  const rest = active.filter(s => !seen.has(s.name)).sort(compareByPopularity);
  for (const entry of rest) {
    seen.add(entry.name);
    merged.push(entry);
  }

  logger.info(`[SkillDiscovery] domain matched=[${domainMatched.map(s => s.name).join(',')}] ranked=[${merged.map(s => s.name).join(',')}]`);

  return merged;
}
