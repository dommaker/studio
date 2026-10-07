/**
 * roster 段（#671 自 prompt-composer.ts 拆出）：`## 频道成员与委派` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';
import { parseChannels, type AgentProfileData, type FileStore } from '@dommaker/studio-shared';
import { resolveMaxDepth, MAX_DELEGATIONS_PER_PARENT } from '../workunit/index.js';
import type { WorkUnitData } from '../workunit/index.js';
import { sliceToTokenBudget, type BuiltSection } from './prompt-quota.js';

/** roster 段所需的最小依赖面（编排方 PromptComposerDeps 的结构子集，避免类型回引成环） */
export interface RosterSectionDeps {
  role: AgentProfileData;
  fileStore: FileStore;
}

/**
 * A2A §4.1 机制 2: 组装 `## 频道成员与委派` 段（成员花名册 + DELEGATE 协议教学）。
 * 花名册 = 本频道 active 成员的 name + description + provider（排除自己——委派质量取决于
 * 模型对角色能力的理解，没有花名册的 DELEGATE 是盲派）；members 为空（历史频道未回填）
 * 时回退到全部 active profile，与 DelegationGate 的过渡期口径一致。
 * 预算：调用方传入有效预算（#91 定额 + 池余量），超出按 estimateTokens 口径截断。
 */
export async function buildRosterSection(
  wu: WorkUnitData,
  deps: RosterSectionDeps,
  tokenBudget: number,
): Promise<BuiltSection> {
  if (!wu.channelId || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const channel = await deps.fileStore.getChannel(wu.channelId);
  const memberIds = parseChannels(channel?.members);
  let members: AgentProfileData[];
  if (memberIds.length > 0) {
    const resolved = await Promise.all(memberIds.map(id => deps.fileStore.getProfile(id).catch(() => null)));
    members = resolved.filter((p): p is AgentProfileData => !!p && p.status === 'active');
  } else {
    members = await deps.fileStore.listProfiles({ status: 'active' });
  }
  members = members.filter(p => p.id !== deps.role.id);
  if (members.length === 0) return { section: '', tokens: 0, originalTokens: 0 };

  const rosterLines = members.map(p =>
    `- ${p.name}（provider: ${p.provider ?? 'claude'}）：${p.description || '（无描述）'}`
  );
  const full = `## 频道成员与委派

本频道可协作成员：
${rosterLines.join('\n')}

如需把一部分工作交给更合适的成员，输出一行：ACTION: DELEGATE:@<成员名>:<子任务 scope>（scope 为该行剩余内容）。仅可委派给上述成员，不可委派给自己；委派深度上限 ${resolveMaxDepth()} 跳（根任务 depth=0），同一任务最多委派 ${MAX_DELEGATIONS_PER_PARENT} 次，不可对同一成员重复委派。系统校验通过后会创建子任务并在频道发卡片，你继续按 PROGRESS 推进自己的部分；校验不通过则转为 NEED_INPUT 请人裁决。`;

  const originalTokens = estimateTokens(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: estimateTokens(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}
