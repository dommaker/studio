/**
 * handoff 段（#671 自 prompt-composer.ts 拆出）：`## 前序进展` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';
import type { WorkUnitMetadata } from '../workunit/index.js';
import { sliceToTokenBudget, type BuiltSection } from './prompt-quota.js';

/** #95：waitingQuestion 仅新会话回放的截断字符上限 */
export const WAITING_QUESTION_REPLAY_MAX_CHARS = 300;

/**
 * #95: 组装 `## 前序进展` 段 —— 断链新会话（续用不命中）时给 agent 的前序上下文。
 * 注入条件：isNewSession && stepCount>0（含复活丢会话）。内容 = metadata.progressLog
 * （成功步，旧→新）+ errorType 存在时附「上一步失败」行（失败步不落 log，注入时补）。
 * progressLog 空且无 errorType → 空段。超预算按 estimateTokens 口径截（与其他段同口径），
 * originalTokens > tokens 由 runSection 落 prompt:section_trimmed 埋点。
 */
export function buildHandoffSection(metadata: WorkUnitMetadata, isNewSession: boolean, tokenBudget: number): BuiltSection {
  if (!isNewSession) return { section: '', tokens: 0, originalTokens: 0 };
  const stepCount = typeof metadata.stepCount === 'number' ? metadata.stepCount : 0;
  if (stepCount <= 0) return { section: '', tokens: 0, originalTokens: 0 };
  const log = Array.isArray(metadata.progressLog) ? metadata.progressLog : [];
  if (log.length === 0 && !metadata.errorType) return { section: '', tokens: 0, originalTokens: 0 };

  const lines = ['## 前序进展'];
  if (log.length > 0) {
    lines.push('以下是你在此任务中已完成的步骤（旧→新）：');
    for (const entry of log) {
      // metadata 是 `[key: string]: unknown` 反序列化的 JSON，旧版本/手改可能残留畸形条目（null/标量）——逐字段窄断言防渲染脏数据
      const step = typeof entry?.step === 'number' ? entry.step : '';
      const action = typeof entry?.action === 'string' ? entry.action : '';
      const summary = typeof entry?.summary === 'string' ? entry.summary : '';
      lines.push(`- 第 ${step} 步 [${action}]：${summary}`);
    }
  }
  if (metadata.errorType) {
    lines.push(`上一步执行失败（${metadata.errorType}），请结合上文进展处理失败后再继续。`);
  }

  const full = lines.join('\n');
  const originalTokens = estimateTokens(full);
  if (originalTokens > tokenBudget) {
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: estimateTokens(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}
