/**
 * persona 段（#671 自 prompt-composer.ts 拆出）：`## 你的角色` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';
import type { AgentProfileData } from '@dommaker/studio-shared';
import { sliceToTokenBudget, type BuiltSection } from './prompt-quota.js';

/**
 * 决策 13 + #91: 组装 `## 你的角色` 段（角色自述 + preset 声明）。
 * 内容 = role.persona ?? role.description，附 preset 带入的 skills/tools/constraints 行
 * （#91 修复：此前 preset 三字段落盘后无任何消费，角色配置形同虚设）；皆空则段省略。
 * 调用方传入有效预算（#91 定额 + 池余量），超出按 estimateTokens 口径截断。
 */
export function buildPersonaSection(role: AgentProfileData, tokenBudget: number): BuiltSection {
  const persona = role.persona ?? role.description;
  const presetLines: string[] = [];
  if (Array.isArray(role.skills) && role.skills.length > 0) {
    presetLines.push(`技能：${role.skills.join('、')}`);
  }
  if (Array.isArray(role.tools) && role.tools.length > 0) {
    presetLines.push(`工具：${role.tools.join('、')}`);
  }
  if (role.constraints && typeof role.constraints === 'object' && Object.keys(role.constraints).length > 0) {
    presetLines.push(`约束：${Object.entries(role.constraints).map(([k, v]) => `${k}=${String(v)}`).join('；')}`);
  }
  const body = [persona, ...presetLines].filter(s => s && s.length > 0).join('\n');
  if (!body || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const full = `## 你的角色\n\n${body}`;
  const originalTokens = estimateTokens(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: estimateTokens(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}
