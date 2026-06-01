/**
 * Knowledge Promoter — 知识引用记录 + 完成后知识提取
 *
 * 从 agent-event-listener.ts 提取。
 */
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { knowledgeAgent } from '../agents/knowledge-agent.service.js';
import { sharedLifecycle } from '../knowledge/knowledge-bus.service.js';
import { afterAgentComplete } from '@dommaker/studio-shared/harness/hooks';

/**
 * P2.5: Parse agent output for knowledge references [REF:xxx]
 * and record them via KnowledgeLifecycle.recordReference().
 * Drives the maturity ladder: draft → verified → proven.
 *
 * Scans:
 * - worktree .progress.json notes field
 * - worktree .review-report.json (if exists)
 * - Structured completionOutput for any [REF:xxx] in siblingAdvice etc.
 */
export function recordKnowledgeRefs(completionOutput: Record<string, any>, worktree?: string): void {
  try {
    const refPattern = /\[REF:([^\]]+)\]/g;
    const refs = new Set<string>();

    // Collect all text sources
    const textSources: string[] = [];

    // 1. Structured completionOutput
    textSources.push(JSON.stringify(completionOutput));

    // 2. Worktree .progress.json notes (where agent writes free-form output)
    if (worktree) {
      try {
        const progressPath = path.join(worktree, '.progress.json');
        if (fs.existsSync(progressPath)) {
          textSources.push(fs.readFileSync(progressPath, 'utf-8'));
        }
      } catch { /* non-blocking */ }

      // 3. Worktree .review-report.json
      try {
        const reviewPath = path.join(worktree, '.review-report.json');
        if (fs.existsSync(reviewPath)) {
          textSources.push(fs.readFileSync(reviewPath, 'utf-8'));
        }
      } catch { /* non-blocking */ }

      // 4. Any output files listed in agent.completed event
      try {
        const outputDir = path.join(worktree, 'output');
        if (fs.existsSync(outputDir)) {
          for (const f of fs.readdirSync(outputDir).slice(0, 20)) {
            try {
              textSources.push(fs.readFileSync(path.join(outputDir, f), 'utf-8'));
            } catch { /* skip unreadable */ }
          }
        }
      } catch { /* non-blocking */ }
    }

    // Scan all sources
    for (const text of textSources) {
      let match: RegExpExecArray | null;
      while ((match = refPattern.exec(text)) !== null) {
        refs.add(match[1].trim());
      }
    }

    if (refs.size === 0) return;

    for (const entryId of refs) {
      try {
        const updated = sharedLifecycle.recordReference(entryId, 'executor');
        if (updated) {
          logger.info('[AgentEventListener] Knowledge reference recorded', { entryId, title: updated.title });
        }
      } catch { /* entry may not exist yet */ }
    }

    logger.info('[AgentEventListener] Knowledge references parsed', { refCount: refs.size, refs: [...refs].slice(0, 10) });
  } catch (err) {
    // Non-blocking — reference recording must not affect execution flow
  }
}

/**
 * 知识提取 + Skill 提取 + afterAgentComplete hook
 * 任务成功完成后的异步知识操作
 */
export function triggerPostCompletionKnowledge(
  taskId: string,
  task: { projectId: string; description: string | null; name: string },
  worktree: string,
  completionOutput: Record<string, any> | undefined,
  goalExecutionId: string,
  goalId: string | undefined,
  data: Record<string, unknown>,
): void {
  // Knowledge Agent（异步，不阻塞）
  knowledgeAgent.extract({
    taskId,
    projectId: task.projectId,
    worktree,
    taskDescription: task.description || task.name,
    result: 'success',
  }).catch(e => {
    logger.error('[AgentEventListener] Knowledge agent failed (non-blocking)', { error: String(e) });
  });

  // P0a: Extract from completion output (fire-and-forget)
  if (completionOutput) {
    knowledgeAgent.extractFromCompletion(completionOutput, taskId, task.projectId).catch(e => {
      logger.warn('[AgentEventListener] extractFromCompletion failed', { error: String(e) });
    });
  }

  // P2.5: Parse Agent output for knowledge references [REF:xxx]
  if (completionOutput) {
    recordKnowledgeRefs(completionOutput, worktree);
  }

  // Phase 3: Skill 提取（面向 GoalExecution，自动检测可复用模式）
  if (goalExecutionId) {
    import('../tools-std/skill-extraction.service.js').then(({ skillExtractionService }) => {
      skillExtractionService.extractFromGoalExecution(goalExecutionId).then(skill => {
        if (skill) logger.info('[AgentEventListener] New skill pattern extracted', { name: skill.name, confidence: skill.confidence });
      }).catch(e => logger.warn('[AgentEventListener] Skill extraction failed', { error: String(e) }));
    }).catch((e) => {
      logger.error('[AgentEventListener] Failed to import skill-extraction service', { error: String(e) });
    });
  }

  // Phase 3: agent 完成 hook（TraceCollector, etc.）
  afterAgentComplete({
    executionId: goalExecutionId,
    success: true,
    sessionCount: (data.sessionCount as number),
  }).catch(e => {
    logger.error('[AgentEventListener] afterAgentComplete hook failed', { error: String(e) });
  });
}

/**
 * 任务失败后的知识提取
 */
export function triggerFailureKnowledge(
  taskId: string,
  task: { projectId: string; description: string | null; name: string },
  worktree: string,
  data: Record<string, unknown>,
  eventType: string,
  executionId: string | undefined,
): void {
  knowledgeAgent.extract({
    taskId,
    projectId: task.projectId,
    worktree,
    taskDescription: task.description || task.name,
    result: 'failure',
    error: (data.error as string) || 'Unknown error',
  }).catch(e => {
    logger.error('[AgentEventListener] Knowledge agent failed (non-blocking)', { error: String(e) });
  });

  // P0a: Extract from error chain (fire-and-forget)
  knowledgeAgent.extractFromError(
    (data.error as string) || 'Unknown error',
    JSON.stringify({ taskDescription: task.description || task.name, eventType, executionId }),
    task.description || task.name,
    taskId,
    task.projectId,
  ).catch(e => {
    logger.warn('[AgentEventListener] extractFromError failed', { error: String(e) });
  });
}
