/**
 * review-adapter (#355) — knowledge 提案审批 adapter（接线 review-proposal 正本）
 *
 * ADR 2026-08-25 决策落地：
 * - 决策 2（业务方只做 adapter）：各拷贝间真正不同的只有「卡片内容」（knowledge_proposal
 *   聚合卡文案原样保留，cardData 在旧形状 { entries, workUnitId, source } 上增 proposalId
 *   供通用端点审批）与「审批后动作」（onApprove → knowledgeService.promote 逐条目
 *   draft→verified；onReject → demote 逐条目 draft→archived——语义自旧前端逐条目调
 *   /knowledge-service/promote|demote 的审核闭环原样搬入）；存取/发卡/approve/reject
 *   生命周期全部归 review-proposal 正本。
 * - 决策 4（通用端点）：提案审批走 /api/v1/review-proposals/knowledge/:id/{approve,reject,status}；
 *   /knowledge-service/promote|demote 为条目生命周期端点（MonitoringPage 人工 promote 等
 *   非提案场景在用），保留不删。
 *
 * 存储：正本默认物化 <dataDir>/knowledge-proposals.jsonl（append-only + 状态墓碑折叠），
 * 词表 pending|executed|rejected|failed|card-failed。旧实现无自持提案存储（条目 maturity=draft
 * 即提案态，卡片直接引用条目 id），故无历史存储迁移问题；接线前发出的存量卡（cardData 无
 * proposalId）不再可审批——条目保持 draft 不注入，同 #354 存量口径。
 */
import { randomUUID } from 'node:crypto';
import { FileStore } from '@dommaker/studio-shared';
import { studioDir } from '@dommaker/studio-shared/studio-dir';
import {
  getReviewProposalAdapter,
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../review-proposal/registry.js';
import { submitProposal } from '../review-proposal/service.js';
import type { ReviewProposalBase, ReviewProposalRecord } from '../review-proposal/store.js';

/** 提案卡条目（γ 轨道契约：cardData.entries=[{id,title,type}]） */
export interface KnowledgeProposalEntry {
  id: string;
  title: string;
  type: string;
}

/** knowledge 提案载荷（行形态：{ kind:'proposal', ... } 落 knowledge-proposals.jsonl） */
export interface KnowledgeReviewProposal extends ReviewProposalBase {
  entries: KnowledgeProposalEntry[];
  workUnitId: string | null;
  source: string;
}

/**
 * 聚合卡渲染：旧卡文案原样保留（行为一致；γ 轨道契约 cardType='knowledge_proposal'）。
 * cardData = 旧形状 { entries, workUnitId, source } + proposalId（通用端点审批接线用）。
 */
function renderKnowledgeCard(p: KnowledgeReviewProposal): { content: string; cardData: Record<string, unknown> } {
  const content = [
    '## 📚 知识提案 — 待人工审核',
    '',
    ...p.entries.map((e, i) => `${i + 1}. **${e.title}**（${e.type}）`),
    '',
    `来源 WorkUnit: ${p.workUnitId ?? 'unknown'}`,
    '审核通过后参与知识注入；拒绝则归档，不再注入。',
  ].join('\n');
  return {
    content,
    cardData: { proposalId: p.id, entries: p.entries, workUnitId: p.workUnitId ?? null, source: p.source },
  };
}

/**
 * approve 后动作：逐条目 promote（draft→verified，参与注入）——
 * 自旧审核闭环（前端逐条目调 /knowledge-service/promote）原样搬入。
 * 动态 import 取 knowledgeService 单例（避免与 knowledge-service.ts 模块加载期循环依赖，
 * 同 review-proposal/card.ts 动态 import channel-message.service 口径）。
 */
async function executeKnowledgeApproval(p: ReviewProposalRecord<KnowledgeReviewProposal>): Promise<ApproveOutcome> {
  try {
    const { knowledgeService } = await import('./knowledge-service.js');
    for (const e of p.entries) {
      await knowledgeService.promote(e.id);
    }
    return { status: 'executed', data: { promoted: p.entries.length } };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** reject 后动作：逐条目 demote（draft→archived，不再注入） */
async function executeKnowledgeRejection(p: ReviewProposalRecord<KnowledgeReviewProposal>): Promise<void> {
  const { knowledgeService } = await import('./knowledge-service.js');
  for (const e of p.entries) {
    await knowledgeService.demote(e.id);
  }
}

/**
 * 注册 knowledge adapter（kind='knowledge'）。同 kind 重复注册后者生效（幂等）。
 * 运行时装配 = knowledge-service.ts 单例创建处（模块加载即注册，保证重启后存量
 * pending 提案可审批）；submitKnowledgeProposal 自助注册兜底（同 #353/#354 口径）。
 */
export function registerKnowledgeReviewAdapter(deps?: {
  fileStore?: FileStore;
  dataDir?: string;
}): ReviewProposalAdapter<KnowledgeReviewProposal> {
  const fileStore = deps?.fileStore ?? new FileStore();
  return registerReviewProposalAdapter<KnowledgeReviewProposal>({
    kind: 'knowledge',
    cardType: 'knowledge_proposal',
    storeNamespace: 'knowledge-proposals',
    dataDir: deps?.dataDir ?? studioDir(),
    fileStore,
    renderCardContent: renderKnowledgeCard,
    onApprove: executeKnowledgeApproval,
    onReject: executeKnowledgeRejection,
  });
}

/** 取 knowledge adapter（未注册则自助注册，幂等） */
export function getKnowledgeReviewAdapter(): ReviewProposalAdapter<KnowledgeReviewProposal> {
  return getReviewProposalAdapter<KnowledgeReviewProposal>('knowledge') ?? registerKnowledgeReviewAdapter();
}

/**
 * 建提案 + 发卡（正本 submitProposal：append-only 落 pending → 发卡 → 失败落 card-failed 墓碑）。
 * 空条目静默跳过（旧 postKnowledgeProposalCard 同款早退）；发卡失败不抛
 * （#101/#143 降级口径，提取链路绝不被通知阻断）。
 */
export async function submitKnowledgeProposal(
  entries: KnowledgeProposalEntry[],
  ctx: { workUnitId?: string; source: string },
): Promise<{ proposalId: string; posted: boolean }> {
  if (entries.length === 0) return { proposalId: '', posted: false };
  const adapter = getKnowledgeReviewAdapter();
  const proposal: KnowledgeReviewProposal = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    entries,
    workUnitId: ctx.workUnitId ?? null,
    source: ctx.source,
  };
  const { posted } = await submitProposal(adapter, proposal);
  return { proposalId: proposal.id, posted };
}
