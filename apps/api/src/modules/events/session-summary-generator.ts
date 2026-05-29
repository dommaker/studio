/**
 * B9-015: SessionSummaryGenerator — server-side session aggregation
 *
 * Called after batch ingest of agent events.
 * Aggregates same-session events → session:summary with filesChanged, toolsUsed, workflowType.
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

type WorkflowType =
  | 'ci_fix'
  | 'pr_review'
  | 'changelog'
  | 'doc_update'
  | 'release_prep'
  | 'debug_session'
  | 'test_triage'
  | 'refactor'
  | 'config_change'
  | 'skill_creation'
  | 'knowledge_curation'
  | 'architecture'
  | 'unknown';

interface SessionSummary {
  sessionId: string;
  agentId: string;
  filesChanged: string[];
  toolsUsed: string[];
  workflowType: WorkflowType;
  eventCount: number;
  durationMs?: number;
}

/**
 * Generate session:summary from all events of a given session.
 * Stores result as StudioEvent (type: 'session:summary').
 */
export async function generateSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  try {
    // Fetch all events for this session
    const events = await prisma.studioEvent.findMany({
      where: {
        payload: { contains: sessionId },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (events.length === 0) return null;

    // Extract session:start and session:end
    const startEvent = events.find((e) => e.type === 'session:start');
    const endEvent = events.find((e) => e.type === 'session:end');

    // Extract agentId from source field
    const agentId = events[0].source || 'unknown';

    // filesChanged: unique file paths from file:change events
    const filesChanged = [
      ...new Set(
        events
          .filter((e) => e.type === 'file:change')
          .map((e) => {
            try {
              const p = JSON.parse(e.payload);
              return p.path || p.file;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];

    // toolsUsed: unique tool names from tool:call events
    const toolsUsed = [
      ...new Set(
        events
          .filter((e) => e.type === 'tool:call')
          .map((e) => {
            try {
              const p = JSON.parse(e.payload);
              return p.tool;
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];

    // Duration from session:start/end timestamps
    let durationMs: number | undefined;
    if (startEvent && endEvent) {
      durationMs = endEvent.timestamp.getTime() - startEvent.timestamp.getTime();
    }

    // Classify workflowType
    const workflowType = classifyWorkflow(filesChanged, toolsUsed, agentId);

    const summary: SessionSummary = {
      sessionId,
      agentId,
      filesChanged,
      toolsUsed,
      workflowType,
      eventCount: events.length,
      durationMs,
    };

    // Store as StudioEvent
    await prisma.studioEvent.create({
      data: {
        type: 'session:summary',
        source: agentId,
        payload: JSON.stringify(summary),
      },
    });

    logger.info('[SessionSummary] Generated', {
      sessionId,
      workflowType,
      filesChanged: filesChanged.length,
      toolsUsed: toolsUsed.length,
    });

    // KE-001 Phase 5: suggest Skill for recurring workflows (fire-and-forget)
    suggestSkillForWorkflow(workflowType, toolsUsed).catch((err: unknown) => {
      logger.warn('[SessionSummary] Skill suggestion failed', { workflowType, error: String(err) });
    });

    return summary;
  } catch (e: unknown) {
    logger.warn('[SessionSummary] Generation failed', { sessionId, error: String(e) });
    return null;
  }
}

/**
 * D3: Workflow type classification — pure rules, no LLM.
 * File paths + tool sequences + agentId → WorkflowType.
 */
function classifyWorkflow(files: string[], tools: string[], _agentId: string): WorkflowType {
  const fileSet = new Set(files);
  const toolSet = new Set(tools);

  // CI fix: .github/* files + test tools
  if (files.some((f) => f.startsWith('.github/')) && (toolSet.has('Bash') || toolSet.has('shell'))) {
    return 'ci_fix';
  }

  // PR review
  if (toolSet.has('git diff') || toolSet.has('gh pr')) {
    return 'pr_review';
  }

  // Changelog
  if (fileSet.has('CHANGELOG.md') || files.some((f) => f.endsWith('CHANGELOG.md'))) {
    return 'changelog';
  }

  // Doc update
  if (files.some((f) => f.startsWith('docs/') && f.endsWith('.md'))) {
    return 'doc_update';
  }

  // Release prep: package.json + CHANGELOG + version files
  if (fileSet.has('package.json') && files.some((f) => f.includes('CHANGELOG'))) {
    return 'release_prep';
  }

  // Test triage: test files + error patterns
  if (files.some((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'))) {
    return 'test_triage';
  }

  // Config change
  if (files.some((f) => f === '.env' || f.includes('docker-compose') || f.includes('systemd'))) {
    return 'config_change';
  }

  // Skill creation
  if (files.some((f) => f.includes('skill') || f.includes('Skill'))) {
    return 'skill_creation';
  }

  // Knowledge curation
  if (files.some((f) => f.includes('memory/') || f.includes('docs/'))) {
    return 'knowledge_curation';
  }

  // Architecture: spec/design docs
  if (files.some((f) => f.includes('spec') || f.includes('DESIGN') || f.includes('ARCHITECTURE'))) {
    return 'architecture';
  }

  // Refactor: multi-file edit without new features (heuristic: many files, no test files)
  if (files.length >= 3 && !files.some((f) => f.endsWith('.test.ts'))) {
    return 'refactor';
  }

  return 'unknown';
}

/**
 * KE-001 Phase 5: Suggest Skill for recurring workflows.
 * If a workflowType appears 3+ times and has no matching Skill, create a proposal.
 */
async function suggestSkillForWorkflow(workflowType: WorkflowType, toolsUsed: string[]): Promise<void> {
  if (workflowType === 'unknown') return;

  // Count recent sessions of this workflow type
  const recentSummaries = await prisma.studioEvent.count({
    where: {
      type: 'session:summary',
      payload: { contains: `"workflowType":"${workflowType}"` },
      timestamp: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    },
  });

  if (recentSummaries < 3) return; // Not recurring enough

  // Check if a Skill already exists for this workflow
  const existing = await prisma.skill.findFirst({
    where: {
      companyId: 'system',
      OR: [
        { category: workflowType },
        { name: { contains: workflowType } },
      ],
      source: { in: ['proposal', 'extraction', 'builtin'] },
    },
  });

  if (existing) return; // Already has a Skill

  // Create proposal
  await prisma.skill.create({
    data: {
      companyId: 'system',
      name: `Workflow: ${workflowType}`.slice(0, 100),
      source: 'proposal',
      status: 'draft',
      category: workflowType,
      description: `Recurring workflow "${workflowType}" detected (${recentSummaries} sessions in 30d). Tools: ${toolsUsed.join(', ')}`,
      tools: JSON.stringify(toolsUsed),
      metadata: JSON.stringify({
        autoGenerated: true,
        workflowType,
        sessionCount: recentSummaries,
        trigger: 'session-summary',
      }),
    },
  });

  logger.info('[SessionSummary] Skill proposal for recurring workflow', { workflowType, sessionCount: recentSummaries });
}
