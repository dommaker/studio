/**
 * handoff/用途段（#671 自 prompt-composer.ts 拆出）：#713 四用途正文与恢复/旧进展共用 token 预算。
 */

import { estimateTokens } from '@dommaker/harness';
import type { RecoveryPacket, WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { sliceToTokenBudget, type BuiltSection } from '../prompt-quota.js';

/** #95：waitingQuestion 仅新会话回放的截断字符上限 */
export const WAITING_QUESTION_REPLAY_MAX_CHARS = 300;

export type PromptPurpose = 'implementation' | 'review' | 'recovery' | 'delegation';

export interface PurposeContext {
  purpose: PromptPurpose;
  wu: WorkUnitData;
  /** #713：评审时从真实 worktree 读取的 base/head diff；读取失败保持 null。 */
  diff?: string | null;
}

function renderMandateLines(mandate: NonNullable<WorkUnitData['mandate']>): string[] {
  return [
    `- revision: ${mandate.revision}; policy: ${mandate.policyVersion}; revoked: ${mandate.revokedAt ?? 'no'}`,
    `- repositories: ${mandate.repositories.map(item => `${item.repo}${item.leg ? ` (${item.leg})` : ''}`).join(', ') || 'none'}`,
    `- delivery: ${mandate.deliveryActions.join(', ') || 'none'}; token budget: ${mandate.budget.tokens ?? 'unlimited'}`,
  ];
}

function renderPurposeContext(context: PurposeContext, metadata: WorkUnitMetadata): string {
  const acceptanceCriteria = Array.isArray(metadata.ac) ? metadata.ac : [];
  if (context.purpose === 'review') {
    const lines = ['## 评审上下文', '', '### 需求与评审范围', context.wu.scope];
    if (acceptanceCriteria.length > 0) {
      lines.push('', '### 验收标准', ...acceptanceCriteria.map(ac => `- ${ac}`));
    }
    const base = metadata.worktreeBaseBranch ?? 'unknown';
    const head = metadata.worktreeBranch ?? 'HEAD';
    lines.push('', '### base/head diff', `- base: ${base}; head: ${head}`);
    const l1 = metadata.attestations?.l1;
    lines.push('', '### 验证证据');
    if (l1) {
      lines.push(`- ${l1.verdict === 'approved' ? 'passed' : 'failed'} at ${l1.at}`);
      if (l1.summary) lines.push(`- ${l1.summary}`);
      lines.push(...(metadata.verifyReport?.commands ?? []).map(command => `  - ${command}`));
    } else {
      lines.push('- 无已记录验证。');
    }
    // 原始 diff 放最后：统一前缀截断时优先保留需求、AC 与验证证据。
    if (context.diff) lines.push('', '```diff', context.diff.trimEnd(), '```');
    return lines.join('\n');
  }
  if (context.purpose === 'delegation') {
    return [
      '## 委派上下文',
      '',
      '### 子范围',
      context.wu.scope,
      '',
      '### 期望产出',
      '只完成上述子范围；按本单产出契约返回可核验结果。必要引用见文件段，父任务其他内容不在本单授权内。',
    ].join('\n');
  }
  if (context.purpose !== 'implementation' && context.purpose !== 'recovery') return '';
  const { mandate } = context.wu;
  if (!mandate && acceptanceCriteria.length === 0) return '';
  const title = context.purpose === 'recovery' ? '## 恢复上下文' : '## 实现上下文';
  const lines = [title];
  if (mandate) {
    lines.push('', '### Mandate');
    lines.push(...renderMandateLines(mandate));
  }
  if (acceptanceCriteria.length > 0) {
    lines.push('', '### 验收标准');
    lines.push(...acceptanceCriteria.map(ac => `- ${ac}`));
  }
  return lines.join('\n');
}

/**
 * 新会话优先注入 #711 结构化恢复包；无 StepRecord 的旧单回退 #95 前序进展。
 * 两种形态都受 handoff 段 estimateTokens 预算约束，完整 transcript 只保留引用。
 */
export function buildHandoffSection(
  metadata: WorkUnitMetadata,
  isNewSession: boolean,
  tokenBudget: number,
  recovery?: RecoveryPacket | null,
  purposeContext?: PurposeContext,
): BuiltSection {
  const purpose = purposeContext ? renderPurposeContext(purposeContext, metadata) : '';
  let handoff = '';
  if (isNewSession && recovery) {
    // StepRecord 自身就是恢复依据，不再依赖旧 metadata.stepCount 门控。
    handoff = renderRecoveryPacket(recovery);
  } else if (isNewSession && (!purposeContext || purposeContext.purpose === 'implementation' || purposeContext.purpose === 'recovery')) {
    const stepCount = typeof metadata.stepCount === 'number' ? metadata.stepCount : 0;
    const log = Array.isArray(metadata.progressLog) ? metadata.progressLog : [];
    if (stepCount > 0 && (log.length > 0 || metadata.errorType)) {
      const lines = ['## 前序进展'];
      if (log.length > 0) {
        lines.push('以下是你在此任务中已完成的步骤（旧→新）：');
        for (const entry of log) {
          const step = typeof entry?.step === 'number' ? entry.step : '';
          const action = typeof entry?.action === 'string' ? entry.action : '';
          const summary = typeof entry?.summary === 'string' ? entry.summary : '';
          lines.push(`- 第 ${step} 步 [${action}]：${summary}`);
        }
      }
      if (metadata.errorType) {
        lines.push(`上一步执行失败（${metadata.errorType}），请结合上文进展处理失败后再继续。`);
      }
      handoff = lines.join('\n');
    }
  }
  const full = [purpose, handoff].filter(section => section.length > 0).join('\n\n');
  return full ? boundedSection(full, tokenBudget) : { section: '', tokens: 0, originalTokens: 0 };
}

function boundedSection(full: string, tokenBudget: number): BuiltSection {
  const originalTokens = estimateTokens(full);
  if (originalTokens > tokenBudget) {
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: estimateTokens(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}

function renderRecoveryPacket(packet: RecoveryPacket): string {
  const lines = [
    '## 恢复包',
    '以下事实来自结构化 StepRecord、当前 WU 快照和本次 Git 读取；不要把旧摘要当作仓库现状。',
    '',
    '### Mandate',
  ];
  if (packet.mandate) {
    const mandate = packet.mandate;
    lines.push(...renderMandateLines(mandate));
  } else {
    lines.push('- 无可用 Mandate；继续执行前必须重新完成授权检查。');
  }

  lines.push('', '### AC 完成状态');
  lines.push(...(packet.acceptanceCriteria.length > 0
    ? packet.acceptanceCriteria.map(item => `- [${item.status}] ${item.ac}${item.note ? ` — ${item.note}` : ''}`)
    : ['- 未记录 AC']));
  lines.push('', '### 已确认决策');
  lines.push(...(packet.confirmedDecisions.length > 0 ? packet.confirmedDecisions.map(item => `- ${item}`) : ['- 无']));

  lines.push('', '### 当前仓库（恢复时实时读取）');
  if (packet.repository) {
    lines.push(`- root: ${packet.repository.root}`);
    lines.push(`- branch: ${packet.repository.branch ?? 'unknown'}; commit: ${packet.repository.commit ?? 'unknown'}`);
    lines.push(`- dirty: ${packet.repository.dirty === null ? 'unknown' : packet.repository.dirty}; readAt: ${packet.repository.readAt}`);
  } else {
    lines.push('- 无可读取的仓库根。');
  }

  lines.push('', '### 未完成事项');
  lines.push(...(packet.unfinishedItems.length > 0 ? packet.unfinishedItems.map(item => `- ${item}`) : ['- 无']));
  lines.push('', '### 最近验证');
  if (packet.recentVerification) {
    lines.push(`- ${packet.recentVerification.status} at ${packet.recentVerification.at}`);
    lines.push(...packet.recentVerification.commands.map(command => `  - ${command}`));
  } else {
    lines.push('- 无已记录验证。');
  }
  lines.push('', '### 待回答问题');
  lines.push(...(packet.openQuestions.length > 0 ? packet.openQuestions.map(item => `- ${item}`) : ['- 无']));

  if (packet.steps.length > 0) {
    lines.push('', '### 最近执行步');
    for (const step of packet.steps.slice(-5)) {
      lines.push(`- 第 ${step.step} 步 [${step.action}] ${step.result}${step.nextStep ? `；下一步：${step.nextStep}` : ''}`);
      if (step.modifiedFiles.length > 0) lines.push(`  修改文件：${step.modifiedFiles.join(', ')}`);
      if (step.commands.length > 0) lines.push(`  命令：${step.commands.map(command => `${command.command} (${command.status})`).join('；')}`);
      if (step.artifacts.length > 0) lines.push(`  产物：${step.artifacts.join(', ')}`);
    }
  }
  if (packet.transcriptRefs.length > 0) {
    lines.push('', '### Transcript 引用（按需读取，勿整份注入）');
    lines.push(...packet.transcriptRefs.slice(-10).map(ref => `- ${ref}`));
  }
  return lines.join('\n');
}
