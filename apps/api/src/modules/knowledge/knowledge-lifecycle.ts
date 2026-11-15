/**
 * knowledge-lifecycle — Lifecycle 能力实现（promote / demote / decay / merge / graduate）
 *
 * 自 knowledge-service.ts 整块抽出（#669 刀2，纯代码移动不改行为）：
 * KnowledgeService.promote / demote / decay / merge / graduateConstraint 的实现体。
 * 模块级函数（不占 KnowledgeService prototype 方法数，knowledge-service.test.ts 锁定 33），
 * 门面方法为薄封装。
 */

import type { MaturityLevel } from '@dommaker/harness';
import { publishKnowledgeEntryChanged } from './knowledge-singletons.js';
import type { KnowledgeServiceDeps } from './knowledge-types.js';
import { isProvenEligible } from './learning-metadata.js';

export async function promoteImpl(deps: KnowledgeServiceDeps, entryId: string): Promise<void> {
  const entry = deps.store.get(entryId);
  if (!entry) return;
  const next: Record<string, MaturityLevel> = { draft: 'verified', verified: 'proven' };
  const target = next[entry.maturity];
  // #715：draft 可先经人审成为 verified；proven 必须另有成功验证与交付结果。
  if (target === 'proven' && !isProvenEligible(entry)) return;
  if (target) {
    deps.store.update(entryId, { maturity: target });
    publishKnowledgeEntryChanged('promoted', { entryId, entryType: entry.type, title: entry.title });
  }
}

/**
 * 审核闭环 reject 语义：draft → archived（保留追溯，decay/lint 不再管它，永不注入）。
 * 与 promote 对称；仅 draft 可 demote（verified/proven 的降级走 decay）。
 */
export async function demoteImpl(deps: KnowledgeServiceDeps, entryId: string): Promise<void> {
  const entry = deps.store.get(entryId);
  if (!entry) return;
  const prev: Record<string, MaturityLevel> = { draft: 'archived' };
  const target = prev[entry.maturity];
  if (target) {
    deps.store.update(entryId, { maturity: target });
    publishKnowledgeEntryChanged('demoted', { entryId, entryType: entry.type, title: entry.title });
  }
}

export async function decayImpl(deps: KnowledgeServiceDeps, entryId: string): Promise<void> {
  const entry = deps.store.get(entryId);
  if (!entry) return;
  const prev: Record<string, MaturityLevel> = { proven: 'verified', verified: 'draft' };
  const target = prev[entry.maturity];
  if (!target) return;
  // Only decay if stale (unreferenced for threshold)
  const daysSinceRef = entry.lastReferenced
    ? (Date.now() - new Date(entry.lastReferenced).getTime()) / 86400000
    : 999;
  const threshold: Record<string, number> = { proven: 365, verified: 180, draft: 90 };
  if (daysSinceRef >= (threshold[entry.maturity] || 90)) {
    deps.store.update(entryId, { maturity: target });
  }
}

export async function mergeImpl(deps: KnowledgeServiceDeps, sourceId: string, targetId: string): Promise<void> {
  const source = deps.store.get(sourceId);
  const target = deps.store.get(targetId);
  if (!source || !target) return;
  deps.store.save({
    ...target,
    content: `${target.content}\n\n---\nMerged from ${sourceId}: ${source.content}`,
    contributors: [...(target.contributors || []), ...(source.contributors || [])],
  });
  deps.store.delete(sourceId);
}

export async function graduateConstraintImpl(_deps: KnowledgeServiceDeps, _id: string): Promise<void> {
  // Phase 7: constraint → knowledge
}
