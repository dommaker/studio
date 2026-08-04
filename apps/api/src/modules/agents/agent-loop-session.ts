// AgentLoop 会话簿记（per-WU 会话续用/重建上限/截断）—— 从 agent-loop.ts 原样抽出，行为不变。
import { logger, FileStore } from '@dommaker/studio-shared';
import { randomUUID } from 'crypto';
import type { WorkUnitMetadata } from '../workunit/workunit.service.js';
import type { StepResult } from './agent-output-parser.js';

/** Threshold for input_tokens before session truncation (100K) */
const SESSION_TOKEN_LIMIT = 100_000;

/** B5（2026-08-03 token-burn issue P1-1）：每 WU 独立会话数上限。
 *  会话反复重建（stuck 重开 / token 截断重开）意味着整段 transcript 全文重放重新烧一遍；
 *  超限说明自动执行已失控，转 need_input 等人工评估（人工回复经 resumeWaitingWorkUnit 重置预算）。 */
const MAX_SESSIONS_PER_WU = 2;

/** AgentLoop 运行时实例中会话簿记所需的最小形状（RuntimeInstanceRow 的结构子集） */
export interface AgentLoopInstanceLike {
  id: string;
  sessionId: string | null;
}

/**
 * 首 step（新建会话）执行失败时重置 sessionId：CLI 会话未必已建立（可能根本没 spawn 到），
 * 不重置则下一步按续用发 `--resume <从未建立的 id>`（claude 必报 "No conversation found"）。
 * 续用 step 失败不调用 —— 会话已存在，保留下一步继续 resume。
 */
export async function resetUnestablishedSession(instance: AgentLoopInstanceLike | null, fileStore: FileStore, metadataUpdates: Partial<WorkUnitMetadata>): Promise<void> {
  if (instance) {
    instance.sessionId = null;
    await fileStore.updateState(instance.id, { sessionId: null }).catch(() => {});
  }
  delete metadataUpdates.sessionId;
  // B5: 会话未建立不计入会话预算（失败重试由 consecutiveStuck>=3 → blocked 兜底）
  delete metadataUpdates.sessionCount;
}

/** Check execution output for input_tokens exceeding threshold, reset session if needed */
export function checkSessionTruncation(instance: AgentLoopInstanceLike | null, fileStore: FileStore, outputText: string | undefined, metadataUpdates: Partial<WorkUnitMetadata>): void {
  if (!outputText || !instance) return;
  try {
    // Parse stream JSON events for usage data
    const lines = outputText.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'usage' && typeof event.input_tokens === 'number') {
          const inputTokens = event.input_tokens as number;
          if (inputTokens > SESSION_TOKEN_LIMIT) {
            logger.info(`[AgentLoop] Session truncation: ${inputTokens} tokens exceeds limit ${SESSION_TOKEN_LIMIT}`);
            instance.sessionId = null;
            fileStore.updateState(instance.id, { sessionId: null }).catch(() => {});
            delete metadataUpdates.sessionId;
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  } catch {
    // Non-blocking
  }
}

export interface SessionResolution {
  resumeSessionId: string | null;
  newSessionId: string | null;
  /** 会话数超限时的提前返回结果（B5 守卫） */
  earlyResult?: StepResult;
}

/** agentStep 会话解析：续用判定 + B5 每 WU 会话数上限 + 新会话落盘（从 agentStep 原样抽出） */
export async function resolveSessionForStep(
  deps: { fileStore: FileStore; instance: AgentLoopInstanceLike | null },
  wuId: string,
  metadata: WorkUnitMetadata,
  metadataUpdates: Partial<WorkUnitMetadata>,
): Promise<SessionResolution> {
  // 续用判定（fix/guard-and-resume）：同一 WU 内才续用。claude 会话按 (HOME, cwd) 存储
  // （2.1.80 实测：异 cwd --resume 报 "No conversation found with session ID"）。
  // HOME 不再 per-agent 隔离（GAP-2 已移除），会话区分靠 cwd；token 由 process.env 透传。
  // B3b-i 每 WU 独立 worktree → 跨 WU 续用必失败；WU metadata.sessionId 由本 WU 首 step
  // 写入，与 instance.sessionId 相等才说明会话是在本 WU（同一 worktree/cwd）建立的。
  const resumeSessionId = deps.instance?.sessionId && metadata.sessionId === deps.instance.sessionId
    ? deps.instance.sessionId
    : null;
  let newSessionId: string | null = null;
  if (!resumeSessionId) {
    // B5（2026-08-03 token-burn issue P1-1，决策记录 #3）：每 WU 会话数上限。
    // 新建会话 = 从零重读 SKILL.md/探索文件 + 后续 step 全文重放，是最大的 token 放大器；
    // 超限转 need_input 等人工评估，替代静默重开。人工回复由 resumeWaitingWorkUnit 重置 sessionCount。
    // 旧数据无 sessionCount 字段：已有 sessionId 的按已用 1 个计。
    const sessionsUsed = metadata.sessionCount ?? (metadata.sessionId ? 1 : 0);
    if (sessionsUsed >= MAX_SESSIONS_PER_WU) {
      logger.warn('[AgentLoop] Session limit reached — need human evaluation', {
        workUnitId: wuId, sessionsUsed, max: MAX_SESSIONS_PER_WU,
      });
      return {
        resumeSessionId,
        newSessionId,
        earlyResult: {
          action: 'need_input' as const,
          summary: `会话重建已达上限（${sessionsUsed}/${MAX_SESSIONS_PER_WU}）：反复从零重开会话会全文重放烧钱，已暂停自动执行。请人工评估后回复任意内容继续（回复会重置会话预算），或直接关闭任务`,
          metadataUpdates,
        },
      };
    }
    newSessionId = randomUUID();
    metadataUpdates.sessionId = newSessionId;
    metadataUpdates.sessionCount = sessionsUsed + 1;
    metadataUpdates.startedAt = new Date().toISOString();
    // Persist sessionId to RuntimeInstance for cross-WorkUnit continuity
    if (deps.instance) {
      await deps.fileStore.updateState(deps.instance.id, { sessionId: newSessionId });
      deps.instance.sessionId = newSessionId;
    }
  } else {
    metadataUpdates.sessionResumes = (metadata.sessionResumes ?? 0) + 1;
  }
  return { resumeSessionId, newSessionId };
}
