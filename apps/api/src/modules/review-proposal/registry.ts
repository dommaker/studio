/**
 * review-proposal/registry (#351) — 人审提案卡 adapter 注册表（kind → adapter）
 *
 * 业务方只做 adapter（ADR 决策 2）：注册配置对象，各拷贝间真正不同的只有
 * 「卡片内容」（renderCardContent）与「审批后动作」（onApprove/onReject），
 * 存取/发卡/审批生命周期全部归正本。
 * store 命名空间 → `<dataDir>/<storeNamespace>.jsonl`（存取物化归正本，历史文件不动）。
 */
import * as path from 'node:path';
import type { FileStore } from '@dommaker/studio-shared';
import {
  ReviewProposalStore,
  type ReviewProposalBase,
  type ReviewProposalRecord,
} from './store.js';

/**
 * approve  outcome（adapter.onApprove 返回值）：
 *   - executed：副作用执行成功 → 正本落 executed 墓碑，data 随响应透传（如 productIds/archivedIds）
 *   - failed：执行失败 → 正本落 failed 墓碑，error 随响应返回（HTTP 500）
 *   - pending + skipped：熔断跳过（如预算耗尽）→ 不落墓碑，提案保持 pending 可重试
 *   - aborted：前置条件不可用（如配置文件未装配）→ 不落墓碑，error 随响应返回（HTTP 500）
 */
export type ApproveOutcome =
  | { status: 'executed'; data?: Record<string, unknown> }
  | { status: 'failed'; error: string }
  | { status: 'pending'; skipped: string }
  | { status: 'aborted'; error: string };

/** adapter 注册配置对象（ADR 决策 2 的落地形态） */
export interface ReviewProposalAdapterConfig<P extends ReviewProposalBase> {
  /** 提案种类（通用端点 /:kind/ 分发键，全局唯一） */
  kind: string;
  /** 前端卡片渲染键（cardType，如 distill_proposal） */
  cardType: string;
  /** store 命名空间：提案文件 = <dataDir>/<storeNamespace>.jsonl */
  storeNamespace: string;
  /** 数据区目录 */
  dataDir: string;
  fileStore: FileStore;
  /**
   * 自定义存取（可选）：缺省由正本物化 <dataDir>/<storeNamespace>.jsonl。
   * 仅供存储形态例外域（#353 role-memory：ADR 决策 3 保留 per-role draft.jsonl，
   * 存量历史行不改写）注入自备 store；其余域一律走默认物化。
   */
  store?: ReviewProposalStore<P>;
  /** 卡片内容渲染：提案 → 正文 + cardData */
  renderCardContent(proposal: P): { content: string; cardData: Record<string, unknown> };
  /** approve 后动作（唯一必须的业务副作用）；入参为审批前记录（status=pending） */
  onApprove(proposal: ReviewProposalRecord<P>): Promise<ApproveOutcome>;
  /** reject 后动作（可选；墓碑由正本落，回调只做业务留痕如事件） */
  onReject?(proposal: ReviewProposalRecord<P>): Promise<void>;
}

/** 注册后的 adapter = 配置 + 物化存取 */
export interface ReviewProposalAdapter<P extends ReviewProposalBase> extends ReviewProposalAdapterConfig<P> {
  store: ReviewProposalStore<P>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, ReviewProposalAdapter<any>>();

/** 注册 adapter（运行时装配调用；同 kind 重复注册后注册生效，幂等） */
export function registerReviewProposalAdapter<P extends ReviewProposalBase>(
  config: ReviewProposalAdapterConfig<P>,
): ReviewProposalAdapter<P> {
  const adapter: ReviewProposalAdapter<P> = {
    ...config,
    store: config.store ?? new ReviewProposalStore<P>(
      config.fileStore,
      path.join(config.dataDir, `${config.storeNamespace}.jsonl`),
    ),
  };
  registry.set(config.kind, adapter);
  return adapter;
}

/** 按 kind 取 adapter（通用端点分发用）；未注册 → undefined */
export function getReviewProposalAdapter<P extends ReviewProposalBase = ReviewProposalBase>(
  kind: string,
): ReviewProposalAdapter<P> | undefined {
  return registry.get(kind) as ReviewProposalAdapter<P> | undefined;
}

/** 清空注册表（测试隔离用） */
export function clearReviewProposalAdapters(): void {
  registry.clear();
}
