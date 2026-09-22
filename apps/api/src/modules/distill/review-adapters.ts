/**
 * review-adapters (#351) — distill 域两个人审提案卡 adapter（接线 review-proposal 正本）
 *
 * ADR 决策 2：业务方只做 adapter。两类提案（蒸馏/GC 候选）真正不同的只有
 * 「卡片内容」（renderCardContent，自旧卡原样搬入，cardType/cardData 形状不变）与
 * 「审批后动作」（onApprove/onReject，委托 DistillService 域方法）；
 * 存取/发卡/approve/reject 生命周期全部归 review-proposal 正本。
 * （存量约束审计 adapter 已随 #617 拆除——审计对象 custom 纯文本约束随 ADR-0029 灭绝。）
 *
 * store 命名空间沿用历史文件名（append-only 历史不改写）：
 *   distill → proposals.jsonl；gc → gc-proposals.jsonl
 */
import type { FileStore } from '@dommaker/studio-shared';
import {
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../review-proposal/registry.js';
import type {
  ReviewProposalBase,
  ReviewProposalRecord,
  ReviewProposalStore,
} from '../review-proposal/store.js';
import type { GcCandidate } from './gc-candidates.js';

/** 蒸馏提案载荷（行形态与旧 distill-store proposals.jsonl 一致） */
export interface DistillProposal extends ReviewProposalBase {
  /** 原料条目 id 清单（门槛命中信号构成，≤ MAX_MATERIALS） */
  materialIds: string[];
  /** 原料快照（提案卡展示用；执行时以 store 内最新状态为准） */
  materials: Array<{ id: string; title: string }>;
  /** 命中信号摘要 */
  signals: { topicTags: string[]; manualCount: number };
  triggerWorkUnitId?: string;
}

/** GC 候选清单提案载荷（行形态与旧 gc-proposals.jsonl 一致） */
export interface GcProposal extends ReviewProposalBase {
  /** 触发本次 GC 的蒸馏运行 id */
  runId: string;
  /** 候选清单（每条附可读理由） */
  candidates: GcCandidate[];
  /** 主区 >200 强制出清单 */
  forced: boolean;
  mainAreaCount: number;
}

/** adapter 审批后动作（由 DistillService 实现） */
export interface DistillReviewEffects {
  executeDistill(proposal: ReviewProposalRecord<DistillProposal>): Promise<ApproveOutcome>;
  onDistillRejected(proposal: ReviewProposalRecord<DistillProposal>): Promise<void>;
  executeGc(proposal: ReviewProposalRecord<GcProposal>): Promise<ApproveOutcome>;
  onGcRejected(proposal: ReviewProposalRecord<GcProposal>): Promise<void>;
}

export interface DistillReviewAdapters {
  distill: ReviewProposalAdapter<DistillProposal>;
  gc: ReviewProposalAdapter<GcProposal>;
}

function renderDistillCard(proposal: DistillProposal): { content: string; cardData: Record<string, unknown> } {
  const signalParts: string[] = [];
  if (proposal.signals.topicTags.length > 0) {
    signalParts.push(`同 topic/tag 新条目 ≥3（${proposal.signals.topicTags.join('、')}）`);
  }
  if (proposal.signals.manualCount > 0) {
    signalParts.push(`manual 过审新条目 ${proposal.signals.manualCount} 条`);
  }
  const content = [
    '## 🧪 知识蒸馏提案 — 待确认',
    '',
    `命中信号：${signalParts.join('；') || '—'}`,
    '',
    `原料（${proposal.materials.length} 条）：`,
    ...proposal.materials.map((m, i) => `${i + 1}. **${m.title}**`),
    '',
    '预期产出：1–5 条蒸馏知识条目（sourceReferences 回指全部原料）。',
    '确认后由 system-executor 执行一次蒸馏调用，原料归档移出主区；拒绝则本轮零副作用。',
  ].join('\n');
  return {
    content,
    cardData: {
      proposalId: proposal.id,
      materials: proposal.materials,
      signals: proposal.signals,
      workUnitId: proposal.triggerWorkUnitId ?? null,
    },
  };
}

function renderGcCard(proposal: GcProposal): { content: string; cardData: Record<string, unknown> } {
  const content = [
    '## 🗑️ 知识库 GC 候选清单 — 待确认',
    '',
    proposal.forced
      ? `主区 ${proposal.mainAreaCount} 条已超容量上限（200），强制出清单。`
      : `按蒸馏周期计龄（连续 3 周期零引用）；主区 ${proposal.mainAreaCount} 条。`,
    '',
    `候选（${proposal.candidates.length} 条）：`,
    ...proposal.candidates.map((c, i) => `${i + 1}. **${c.title}**\n   ${c.reason}`),
    '',
    '确认后候选条目 maturity=archived 移出主区（可恢复）；拒绝则全部保留。',
  ].join('\n');
  return {
    content,
    cardData: {
      gcProposalId: proposal.id,
      runId: proposal.runId,
      candidates: proposal.candidates,
      forced: proposal.forced,
      mainAreaCount: proposal.mainAreaCount,
    },
  };
}

/**
 * 创建并注册 distill 域两个 adapter（kind: distill / gc）。
 * DistillService 构造时调用；同 kind 重复注册后者生效（测试多实例与运行时装配幂等）。
 */
export function registerDistillReviewAdapters(deps: {
  fileStore: FileStore;
  dataDir: string;
  effects: DistillReviewEffects;
}): DistillReviewAdapters {
  const { fileStore, dataDir, effects } = deps;
  return {
    distill: registerReviewProposalAdapter<DistillProposal>({
      kind: 'distill',
      cardType: 'distill_proposal',
      storeNamespace: 'proposals',
      dataDir,
      fileStore,
      renderCardContent: renderDistillCard,
      onApprove: p => effects.executeDistill(p),
      onReject: p => effects.onDistillRejected(p),
    }),
    gc: registerReviewProposalAdapter<GcProposal>({
      kind: 'gc',
      cardType: 'gc_proposal',
      storeNamespace: 'gc-proposals',
      dataDir,
      fileStore,
      renderCardContent: renderGcCard,
      onApprove: p => effects.executeGc(p),
      onReject: p => effects.onGcRejected(p),
    }),
  };
}

/** 曾被 human 驳回的条目 id 集（reject = 人判保留，不再重复提案打扰） */
async function rejectedIds<P extends ReviewProposalBase>(
  store: ReviewProposalStore<P>,
  extract: (p: P) => string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const p of await store.listProposals()) {
    if (p.status !== 'rejected') continue;
    for (const id of extract(p)) ids.add(id);
  }
  return ids;
}

/** 曾被 human 驳回的 GC 候选条目 id */
export function rejectedGcEntryIds(store: ReviewProposalStore<GcProposal>): Promise<Set<string>> {
  return rejectedIds(store, p => p.candidates.map(c => c.entryId));
}
