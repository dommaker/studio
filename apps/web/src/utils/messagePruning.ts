// 频道消息数据层降级（#326，ADR 2026-08-25 channel-message-data-pruning）：
// 远离视口的上方历史消息剥离 content/meta 大头 = 骨架（degraded 标记 + 结构字段全留）；
// 滚回时整页水合复活。判定全部抽纯函数在此单测；hook 侧只负责接线（useChannelMessages）。
// 骨架保留 meta 的 {status, cardType} 标量子集——deriveStreamView 的 isCompleted（meta.status）
// 与 mergeable（meta.cardType）依赖它们，全剥会使折叠计数/连续合并判定失真（字节量可忽略）。
import type { ChannelMessage } from '../api/channel';
import { parseMeta } from './messageMeta';

/** 最近 K 条永全量（钉底语义区） */
export const PRUNE_KEEP_RECENT = 100;
/** 降级阈值：距首个可见消息超过 D1 条的上方历史降级 */
export const PRUNE_DEGRADE_DISTANCE = 50;
/** 水合阈值：视口距降级区边界不足 D2 条时触发整页水合（D2 < D1 = 迟滞死区，防边界抖动） */
export const PRUNE_HYDRATE_DISTANCE = 30;
/** 水合单页条数（后端硬上限 100） */
export const PRUNE_HYDRATE_PAGE_LIMIT = 100;

export interface PruneOptions {
  keepRecent: number;
  degradeDistance: number;
  hydrateDistance: number;
}

const DEFAULT_OPTS: PruneOptions = {
  keepRecent: PRUNE_KEEP_RECENT,
  degradeDistance: PRUNE_DEGRADE_DISTANCE,
  hydrateDistance: PRUNE_HYDRATE_DISTANCE,
};

/** 全量消息 → 骨架：剥 content/meta 大头（meta 留 status/cardType 标量），结构字段原位保留 */
export function degradeMessage(m: ChannelMessage): ChannelMessage {
  if (m.degraded) return m;
  const meta = parseMeta(m.meta);
  const keep: Record<string, unknown> = {};
  if (typeof meta.status === 'string') keep.status = meta.status;
  if (typeof meta.cardType === 'string') keep.cardType = meta.cardType;
  return {
    ...m,
    content: '',
    meta: Object.keys(keep).length > 0 ? keep : undefined,
    degraded: true,
  };
}

export interface PrunePlan {
  /** 应降级为骨架的消息 id（尚未降级的） */
  degradeIds: string[];
  /** 水合游标 = 首个非骨架消息 id（作分页 before）；undefined = 无需水合 */
  hydrateBefore?: string;
}

/**
 * 降级/水合判定：anchorMid = 首个可见消息 id。
 * 降级：index < anchorIdx - D1 且 index < len - K 的非骨架消息。
 * 水合：降级区是前缀 [0, X)（X = 首个非骨架 index）；anchorIdx < X + D2 时给游标。
 * anchorMid 为 null / 不在数组中 → 空计划（调用方无可锚行时不动作）。
 */
export function planPrune(
  messages: ChannelMessage[],
  anchorMid: string | null,
  opts: PruneOptions = DEFAULT_OPTS,
): PrunePlan {
  const anchorIdx = anchorMid == null ? -1 : messages.findIndex(m => m.id === anchorMid);
  if (anchorIdx < 0) return { degradeIds: [] };

  const degradeBoundary = Math.min(anchorIdx - opts.degradeDistance, messages.length - opts.keepRecent);
  const degradeIds: string[] = [];
  for (let i = 0; i < degradeBoundary; i++) {
    if (!messages[i].degraded) degradeIds.push(messages[i].id);
  }

  const firstFullIdx = messages.findIndex(m => !m.degraded);
  const plan: PrunePlan = { degradeIds };
  if (firstFullIdx > 0 && anchorIdx < firstFullIdx + opts.hydrateDistance) {
    plan.hydrateBefore = messages[firstFullIdx].id;
  }
  return plan;
}
