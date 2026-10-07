/**
 * knowledge-track — Track 能力实现（consumption + outcome tracking，反馈闭环）
 *
 * 自 knowledge-service.ts 整块抽出（#669 刀2，纯代码移动不改行为）：
 * KnowledgeService.recordConsumption / recordOutcome / recordSkillExecution 的实现体。
 * 模块级函数（不占 KnowledgeService prototype 方法数，knowledge-service.test.ts 锁定 33），
 * 门面方法为薄封装。
 */

import { resolveStudioEventsFile } from '../../utils/studio-events.js';
import { getStore } from '../../core/store.js';
import type { KnowledgeServiceDeps, ExecutionOutcome } from './knowledge-types.js';

export function recordConsumptionImpl(deps: KnowledgeServiceDeps, entryIds: string[], context: string): void {
  for (const id of entryIds) {
    try { deps.lifecycle.recordReference(id, context); } catch { /* non-blocking */ }
  }

  // O2-KR1: 发射 consumption 事件供 OKR metric 采集
  if (entryIds.length > 0) {
    getStore().appendJsonl(resolveStudioEventsFile(), {
      type: 'knowledge:consumption',
      source: context,
      payload: JSON.stringify({ entryIds, count: entryIds.length }),
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }
}

export async function recordOutcomeImpl(deps: KnowledgeServiceDeps, outcome: ExecutionOutcome): Promise<void> {
  // Close the feedback loop: record execution outcome as StudioEvent
  try {
    await getStore().appendJsonl(resolveStudioEventsFile(), {
      type: `knowledge:outcome:${outcome.success ? 'success' : 'failure'}`,
      source: outcome.agentType,
      payload: JSON.stringify({
        executionId: outcome.executionId,
        agentType: outcome.agentType,
        success: outcome.success,
        details: outcome.details?.slice(0, 500),
        consumedKnowledge: outcome.consumedKnowledge,
        mode: outcome.mode,
        errorType: outcome.errorType,
      }),
      createdAt: new Date().toISOString(),
    });
  } catch { /* non-blocking */ }

  // Update referencedBy for consumed knowledge entries
  for (const entryId of outcome.consumedKnowledge) {
    try {
      const entry = deps.store.get(entryId);
      if (entry) {
        entry.referencedBy = entry.referencedBy || [];
        if (!entry.referencedBy.includes(outcome.executionId)) {
          entry.referencedBy.push(outcome.executionId);
          deps.store.save(entry);
        }
      }
    } catch { /* non-blocking */ }
  }

  deps.eventEmitter.emit('knowledge', { type: 'recordOutcome', data: { executionId: outcome.executionId, success: outcome.success } });
}

/**
 * AC-8c: Record Skill execution outcome back to source KnowledgeEntry.
 * Finds the KnowledgeEntry that produced the Skill, records execution result.
 * If successRate drops below 50%, revokes skillCandidate tag.
 */
export async function recordSkillExecutionImpl(deps: KnowledgeServiceDeps, skillId: string, success: boolean, agentType: string): Promise<void> {
  try {
    // Find KnowledgeEntry by skillId
    const entries = deps.store.list({});
    const sourceEntry = entries.find(e => e.skillId === skillId);
    if (!sourceEntry) return;

    // Record reference with execution result
    deps.lifecycle.recordReference(sourceEntry.id, `skill:${agentType}`, success, 'auto');

    // Check if skillCandidate tag should be revoked
    if (deps.lifecycle.checkSkillCandidateRevocation) {
      deps.lifecycle.checkSkillCandidateRevocation(sourceEntry.id);
    }
  } catch { /* non-blocking */ }
}
