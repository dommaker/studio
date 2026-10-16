// 人审提案卡配置（#352，ADR 2026-08-25 决策 5）：6 张提案卡坍缩为「条目清单 + 文案」纯数据配置。
// 壳 = ReviewProposalCard；生命周期 = useProposalReview；action 分发 = useChannelCardActions
// 经 PROPOSAL_ACTION_INDEX 参数化调用 config.exec。
// 端点现状：6 类全部经通用端点 /review-proposals/:kind/:id/*（distill/gc/audit #351，memory #353，
// knowledge #355，auditor #356）。
// 按提案域拆分为多文件（shared = 类型与跨域助手，distill/memory/knowledge/auditor/constraint/evolution
// = 各域一份配置），本 index 合并注册表；import 路径 '../proposalCardConfigs' 不变。
export type { ProposalReviewState, ProposalCardConfig } from './shared';
export { KNOWLEDGE_TYPE_LABELS } from './knowledge';

import type { ProposalCardConfig } from './shared';
import { distillProposalConfig, gcProposalConfig } from './distill';
import { memoryProposalConfig } from './memory';
import { knowledgeProposalConfig } from './knowledge';
import { auditorSuggestionConfig } from './auditor';
import { constraintProposalConfig } from './constraint';
import { evolutionProposalConfig } from './evolution';

export const PROPOSAL_CARD_CONFIGS: Record<string, ProposalCardConfig> = {
  distill_proposal: distillProposalConfig,
  gc_proposal: gcProposalConfig,
  memory_proposal: memoryProposalConfig,
  knowledge_proposal: knowledgeProposalConfig,
  auditor_suggestion: auditorSuggestionConfig,
  constraint_proposal: constraintProposalConfig,
  evolution_proposal: evolutionProposalConfig,
};

/** action → 配置 + 决策方向（useChannelCardActions 参数化调用入口） */
export const PROPOSAL_ACTION_INDEX: Record<string, { config: ProposalCardConfig; decision: 'approve' | 'reject' }> =
  Object.fromEntries(
    Object.values(PROPOSAL_CARD_CONFIGS).flatMap(config => [
      [config.approveAction, { config, decision: 'approve' as const }],
      [config.rejectAction, { config, decision: 'reject' as const }],
    ]),
  );
