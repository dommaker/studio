/**
 * skills 段（#671 自 prompt-composer.ts 拆出）：`## 本次任务 Skills` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { loadManifest } from '../skills/index.js';
import { selectSkillsForInjection, parseSkillHintsFromScope } from '../skills/index.js';
import type { WorkUnitData } from '../workunit/index.js';
import { sliceToTokenBudget } from './prompt-quota.js';

/** skills 段所需的最小依赖面（编排方 PromptComposerDeps 的结构子集，避免类型回引成环） */
export interface SkillSectionDeps {
  role: AgentProfileData;
  acceptedTypes: string[];
}

/**
 * §10 P0 + 决策 7/11 + #92: 组装 `## 本次任务 Skills` 段 —— step 时计算（不再读 claim 落盘的
 * metadata.matchedSkills，消竞态并吃到 skill 库最新版）。
 * #92 硬预裁剪（selectSkillsForInjection）：注入段只含 +skill 显式点名（wu.scope 解析）+
 * role.skills 显式声明（#462：与 +skill 同权，按名去重）+
 * 域匹配（role.acceptedTypes ∪ 归一化 wu.type ∩ skill.agentTypes）三类；scope 文本匹配与
 * 「rest 热度」不再进注入段（由段尾 MANIFEST 指针按需兜底）。预裁剪后仍受 #91 分段定额截断
 * （有效预算 = 定额 + 池余量，块级截断，取代封顶 3）。
 * index-on-demand：索引行 = name + description + triggers 摘要 + 全文指针
 * （~/.studio/skills/<name>/SKILL.md，agent 按需阅读），不注入正文；段首协议行说明按需语义；
 * 段尾一行 MANIFEST 指针（~/.studio/skills/MANIFEST.md，agent 按需读全文清单），恒在段尾（无论是否裁剪）。
 * 返回 matched = 实际进入注入段的 skill 名（预裁剪后、截断后的集合；调用方落盘
 * metadata.matchedSkills）。#172（#60 决策 Q2）：曝光事件发射已删除（常量集合零信息量，
 * 占事件流 ~88%）；knowledge:skill_used 唯一语义 = Skill 加载（skill-loader.ts）。
 */
export async function buildSkillSection(
  wu: WorkUnitData,
  deps: SkillSectionDeps,
  tokenBudget: number,
): Promise<{ section: string; tokens: number; originalTokens: number; matched: string[] }> {
  const manifest = loadManifest();
  if (manifest.length === 0) return { section: '', tokens: 0, originalTokens: 0, matched: [] };

  const hints = parseSkillHintsFromScope(wu.scope ?? '');
  // #462：role.skills 显式声明纳入索引候选（与 +skill 点名同权，按名去重——见 selectSkillsForInjection）
  const ranked = selectSkillsForInjection(manifest, {
    acceptedTypes: deps.acceptedTypes,
    wuType: wu.type,
  }, hints, deps.role.skills ?? []);
  if (ranked.length === 0) return { section: '', tokens: 0, originalTokens: 0, matched: [] };

  const header = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
  // #92: 段尾 MANIFEST 指针（恒在段尾，agent 按需读全文清单）
  const pointer = `完整 skill 清单见 skills MANIFEST.md（${studioPath('skills', 'MANIFEST.md')}）`;
  const pointerTokens = estimateTokens(pointer + '\n\n'); // +\n\n 分隔符
  const fixedTokens = estimateTokens(header) + pointerTokens;

  const candidates = ranked.map(entry => {
    const triggerSummary = Array.isArray(entry.triggers) && entry.triggers.length > 0
      ? `｜触发：${entry.triggers.slice(0, 5).join(', ')}`
      : '';
    const block = `### ${entry.name}\n${entry.description || '（无描述）'}${triggerSummary}\n全文：${studioPath('skills', entry.name, 'SKILL.md')}`;
    return { entry, block, blockTokens: estimateTokens(block + '\n\n') }; // + \n\n 分隔符
  });
  // 未截断的原始尺寸（截断埋点的 originalTokens；块级跳过也计入）
  const originalTokens = fixedTokens + candidates.reduce((sum, c) => sum + c.blockTokens, 0);

  let tokens = fixedTokens;
  const blocks: string[] = [];
  const matched: string[] = [];
  for (const { entry, block, blockTokens } of candidates) {
    if (tokens + blockTokens > tokenBudget) {
      // 首个块即超预算：截断塞入，保证段不为空（沿用原整段截断口径）；
      // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
      if (blocks.length === 0) {
        const sliced = sliceToTokenBudget(block, tokenBudget - tokens);
        blocks.push(sliced);
        matched.push(entry.name);
        tokens = fixedTokens + estimateTokens(sliced);
      }
      break;
    }
    blocks.push(block);
    matched.push(entry.name);
    tokens += blockTokens;
  }

  // #172（#60 决策 Q2）：曝光事件发射已删除 —— 曝光集合为常量（零信息量，占事件流 ~88%），
  // knowledge:skill_used 唯一语义 = Skill 加载（MCP loadSkill 拉取正文，见 skill-loader.ts）。

  return { section: `${header}\n\n${blocks.join('\n\n')}\n\n${pointer}`, tokens, originalTokens, matched };
}
