/**
 * review-adapter (#623) — evolution 人审提案 adapter（接线 review-proposal 正本）
 *
 * studio#623 决议（2026-09-22）：evolution 提案归位正本卡片，频道文本审核通道
 * （人类回复 approve/reject + EP 编号的文本解析）整体退役。
 *
 * - 决策落地形态同 ADR 2026-08-25 决策 2（业务方只做 adapter）：卡片内容
 *   （renderCardContent：当前/提案/理由/证据窗口）与审批后动作（onApprove/onReject
 *   → EvolutionService.decide，apply/幂等/APPLY_FAILED 重试语义原样复用，不重写）
 *   归本文件；存取/发卡/审批生命周期归 review-proposal 正本。
 * - 存储形态例外（同 #353 memory 先例）：正本默认物化单文件 JSONL 不适用——evolution
 *   提案是 `<dataDir>/evolution/EP-XXXX.json` 单提案文件 + flock 序号（Requirement 模式），
 *   故经 registry config.store 注入 EvolutionProposalStore 包现有 FileStore 读写，
 *   存量历史提案零迁移。
 * - EP 编号体系保留；admin API decide 路径（evolution.routes.ts）不动。
 */
import * as path from 'node:path';
import {
  FileStore,
  type EvolutionProposalData,
  type EvolutionProposalStatus,
} from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { postReviewProposalCard } from '../review-proposal/card.js';
import {
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../review-proposal/registry.js';
import {
  ReviewProposalStore,
  type ReviewProposalRecord,
  type ReviewProposalStatus,
} from '../review-proposal/store.js';
import { getErrorMessage } from '../../utils/errors.js';
import type { EvolutionService } from './evolution.service.js';

/**
 * evolution 提案状态 → 正本词表读侧归一（同 #353 memory 旧 promoted 归一先例）：
 *   pending → pending；applied → executed；rejected → rejected；stale → stale（原值保留）
 *   approved → pending：approve 后 apply 曾失败（APPLY_FAILED）待重试——映射为正本 pending
 *   态，允许再走一次 approve → decide 重试 apply（重试语义经卡片通道保留）。
 */
export function toReviewProposalStatus(s: EvolutionProposalStatus): ReviewProposalStatus {
  switch (s) {
    case 'pending': return 'pending';
    case 'approved': return 'pending';
    case 'applied': return 'executed';
    case 'rejected': return 'rejected';
    case 'stale': return 'stale';
  }
}

/**
 * 正本载荷类型：evolution 提案去掉自有 status 字段——evolution 词表
 * （pending/approved/rejected/applied/stale）与正本词表（pending/executed/...）不同，
 * 归一后的正本 status 由 ReviewProposalRecord 承载（读侧归一见 toReviewProposalStatus）。
 */
export type EvolutionReviewProposal = Omit<EvolutionProposalData, 'status'>;

/** 归一映射辅助：原始提案 → 正本记录（status 取归一值，statusAt 取最新时间戳） */
function toRecord(p: EvolutionProposalData): ReviewProposalRecord<EvolutionReviewProposal> {
  const { status: _raw, ...payload } = p;
  return {
    ...payload,
    status: toReviewProposalStatus(p.status),
    statusAt: p.appliedAt ?? p.staledAt ?? p.decidedAt ?? p.createdAt,
  };
}

/**
 * evolution 提案存取：包 FileStore 的 evolution 读写（EP-XXXX.json 单提案文件）。
 * 提案创建不归本类（generator 直写 createEvolutionProposal）；appendProposal 仅为
 * 正本 submitProposal 路径兼容而写穿（补 status:'pending' 落盘形态）。appendStatus 是
 * no-op：evolution 状态唯一写入点 = EvolutionService.decide（含 appliedAt/decidedBy/
 * rejectReason/stale 惰性转换元数据），正本墓碑追加在此不落盘，避免与 decide 的落盘形态分叉。
 */
export class EvolutionProposalStore extends ReviewProposalStore<EvolutionReviewProposal> {
  constructor(private fs: FileStore) {
    // 名义路径：自定义存取覆盖全部 I/O，本文件永不落盘
    super(fs, path.join(studioPath('data', 'evolution'), 'proposals.jsonl'));
  }

  /** 写穿到 evolution FileStore（新提案 pending，无需墓碑） */
  override async appendProposal(proposal: EvolutionReviewProposal): Promise<void> {
    await this.fs.createEvolutionProposal({ ...proposal, status: 'pending' });
  }

  /** no-op：状态只经 EvolutionService.decide 落盘（见文件头注释） */
  override async appendStatus(_id: string, _status: ReviewProposalStatus): Promise<void> {
    // intentionally no-op
  }

  /** 全量读 + 读侧归一 */
  override async listProposals(): Promise<ReviewProposalRecord<EvolutionReviewProposal>[]> {
    return (await this.fs.listEvolutionProposals()).map(toRecord);
  }

  /** 按 id 直读单提案文件（免全量扫描）+ 读侧归一 */
  override async getProposal(id: string): Promise<ReviewProposalRecord<EvolutionReviewProposal> | null> {
    const p = await this.fs.getEvolutionProposal(id);
    return p ? toRecord(p) : null;
  }
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** 提案卡渲染：当前/提案/理由/证据窗口（自旧频道文本消息格式改卡片形态） */
function renderEvolutionCard(p: EvolutionReviewProposal): { content: string; cardData: Record<string, unknown> } {
  const counts = Object.entries(p.evidence.eventCounts).map(([k, v]) => `${k}=${v}`).join(', ');
  const content = [
    `## 🧬 约束进化提案 ${p.id} — 待审核`,
    '',
    `目标：${p.targetType} / ${p.targetId}（${p.action}${p.constraintChange ? ` / ${p.constraintChange}` : ''}）`,
    '',
    `当前：${truncate(p.currentText || '（空）', 160)}`,
    `提案：${truncate(p.proposedText, 160)}`,
    `理由：${truncate(p.rationale, 240)}`,
    `证据：${counts || '无'}（窗口 ${p.evidence.windowHours}h，来源 ${p.source}）`,
    '',
    '批准后立即生效到约束配置；拒绝则本轮零副作用。',
  ].join('\n');
  return {
    content,
    cardData: {
      proposalId: p.id,
      targetType: p.targetType,
      targetId: p.targetId,
      action: p.action,
      ...(p.constraintChange ? { constraintChange: p.constraintChange } : {}),
      source: p.source,
      evidence: p.evidence,
    },
  };
}

/**
 * 注册 evolution adapter（kind='evolution'）。运行时装配 = EvolutionService 构造
 * （每个实例携带自有 fileStore 注册，同 kind 重复注册后者生效，幂等）；audit-logs
 * 聚合读面有自助注册兜底。
 */
export function registerEvolutionReviewAdapter(deps: {
  fileStore: FileStore;
  /** decide 路径（复用 apply/幂等/APPLY_FAILED 重试语义）；须与 fileStore 同源 */
  service: EvolutionService;
}): ReviewProposalAdapter<EvolutionReviewProposal> {
  const { fileStore, service } = deps;
  return registerReviewProposalAdapter<EvolutionReviewProposal>({
    kind: 'evolution',
    cardType: 'evolution_proposal',
    // 名义命名空间：自定义 store 覆盖默认物化（存取落 <dataDir>/evolution/EP-XXXX.json）
    storeNamespace: 'evolution',
    dataDir: studioPath('data', 'evolution'),
    fileStore,
    store: new EvolutionProposalStore(fileStore),
    // 卡片作者沿用频道时代的系统作者名
    author: 'Evolution',
    renderCardContent: renderEvolutionCard,
    onApprove: async (p): Promise<ApproveOutcome> => {
      try {
        const decided = await service.decide(p.id, 'approve', { decidedBy: 'card' });
        return { status: 'executed', data: { proposalId: decided.id, appliedAt: decided.appliedAt ?? null } };
      } catch (e) {
        // APPLY_FAILED：decide 已把提案停在 approved（映射回 pending，可重试）；
        // CONFLICT（含超期转 stale）：decide 已落终态——两者都不再由正本补墓碑
        // （appendStatus 对 evolution 为 no-op），故失败只回 error，状态以 evolution 存储为准
        return { status: 'failed', error: getErrorMessage(e) };
      }
    },
    onReject: async p => {
      await service.decide(p.id, 'reject', { decidedBy: 'card' });
    },
  });
}

/**
 * runScan 发布路径：提案已由 generator 落盘（pending），此处只发卡到 #系统
 * （正本 postReviewProposalCard；频道缺失/发卡失败静默 false，不阻塞扫描链路）。
 */
export async function postEvolutionProposalCard(
  adapter: ReviewProposalAdapter<EvolutionReviewProposal>,
  proposal: EvolutionProposalData,
): Promise<boolean> {
  const { content, cardData } = adapter.renderCardContent(proposal);
  return postReviewProposalCard(
    { cardType: adapter.cardType, content, cardData, logTag: adapter.kind, author: adapter.author },
    { fileStore: adapter.fileStore },
  );
}
