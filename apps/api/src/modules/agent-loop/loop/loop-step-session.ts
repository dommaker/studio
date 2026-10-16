import { randomUUID } from 'crypto';
import type { AgentTask } from '@dommaker/studio-agent';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { shouldResumeSession } from '../session-resume.js';
import { MAX_SESSIONS_PER_WU } from '../step-retry-policy.js';
import type { StepResult } from '../agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';
import { logger } from '@dommaker/studio-shared/node';

export interface StepSessionInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  workspaceRoot: string | null;
  traceId?: string;
}

export interface StepSessionDecision {
  taskProvider: AgentTask['provider'];
  resumeSessionId: string | null;
}

/** #94/#637/#639：按档案中的 CLI 真实会话号判定本步续用形态。 */
export function resolveStepSession(input: StepSessionInput, host: AgentLoopHost): StepSessionDecision {
  const { wu, metadata, workspaceRoot, traceId } = input;
  // AgentTask with new interface: provider, sessionId, maxTurns, knowledgeContext
  // F4: profile provider (registry id) → AgentTask. Cast via AgentTask['provider'] because
  // apps/api tsc resolves studio-agent types from its (possibly stale) dist/index.d.ts.
  // （取值前移：续用判定需要 provider）
  const taskProvider = (host.role.provider || 'claude') as AgentTask['provider'];
  // 续用判定（#94 per-WU 化 + #639 按 CLI 真实会话号点名续用）：只信档案，不读 instance 槽位。
  // 候选号选取：claude = metadata.sessionId（档案 UUID 即 claude CLI 真实会话号，会话按
  // (HOME, cwd) 存储，2.1.80 实测异 cwd --resume 报 "No conversation found with session ID"
  // ——cwd 取本步最终 workspaceRoot，会话文件不在 → 直接走新建）；kimi/codex/opencode =
  // metadata.cliSessionId（CLI 真实会话号，无 id 文件可查 → 只判有无，编号失效由 CLI
  // 报错 + #94 降级链兜底）。无 CLI 会话号 = 新建——cwd 维度「接最新」已撤除（#637：
  // 非代码 WU 共享 cwd，交错执行静默接错别家会话）。
  const resumeCandidateId = taskProvider === 'claude' ? metadata.sessionId : metadata.cliSessionId;
  const resumeSessionId = shouldResumeSession(taskProvider, resumeCandidateId, workspaceRoot)
    ? resumeCandidateId!
    : null;
  // #639：续用决策日志（可 grep：provider / 是否续用 / cwd / CLI 真实会话号）
  logger.info('[AgentLoop] session resume decision', {
    workUnitId: wu.id,
    provider: taskProvider,
    resumed: resumeSessionId !== null,
    cwd: workspaceRoot ?? null,
    cliSessionId: metadata.cliSessionId ?? null,
    traceId,
  });
  return { taskProvider, resumeSessionId };
}

export interface StepSessionIssueInput {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  resumeSessionId: string | null;
  metadataUpdates: Partial<WorkUnitMetadata>;
}

export interface StepSessionIssue {
  newSessionId: string | null;
  sessionsUsed: number;
  failure?: StepResult;
}

/** B5：必要时签发新会话，并执行每 WU 会话数上限。 */
export function issueStepSession(input: StepSessionIssueInput): StepSessionIssue {
  const { wu, metadata, resumeSessionId, metadataUpdates } = input;
  let newSessionId: string | null = null;
  // B5（2026-08-03 token-burn issue P1-1，决策记录 #3）：每 WU 会话数上限。
  // 新建会话 = 从零重读 SKILL.md/探索文件 + 后续 step 全文重放，是最大的 token 放大器；
  // 超限转 need_input 等人工评估，替代静默重开。旧数据无 sessionCount 字段：已有 sessionId 的按已用 1 个计。
  const sessionsUsed = metadata.sessionCount ?? (metadata.sessionId ? 1 : 0);
  if (!resumeSessionId) {
    if (sessionsUsed >= MAX_SESSIONS_PER_WU) {
      logger.warn('[AgentLoop] Session limit reached — need human evaluation', {
        workUnitId: wu.id, sessionsUsed, max: MAX_SESSIONS_PER_WU,
      });
      return {
        newSessionId,
        sessionsUsed,
        failure: {
          action: 'need_input' as const,
          summary: `会话重建已达上限（${sessionsUsed}/${MAX_SESSIONS_PER_WU}）：反复从零重开会话会全文重放烧钱，已暂停自动执行。请人工评估后回复任意内容继续，或直接关闭任务`,
          metadataUpdates,
        },
      };
    }
    newSessionId = randomUUID();
    metadataUpdates.sessionId = newSessionId;
    metadataUpdates.sessionCount = sessionsUsed + 1;
    metadataUpdates.startedAt = new Date().toISOString();
    metadataUpdates.lastSessionResumed = false;
  } else {
    // sessionResumes 不在此预增——#94 起只计实际续用成功的步（见成功路径统一落账）
    metadataUpdates.lastSessionResumed = true;
  }
  return { newSessionId, sessionsUsed };
}
