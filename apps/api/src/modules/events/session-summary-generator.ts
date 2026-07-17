/**
 * B9-015: SessionSummaryGenerator — server-side session aggregation
 *
 * Called after batch ingest of agent events.
 * Aggregates same-session events → session:summary with filesChanged, toolsUsed, patternType.
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import { skillStore } from '../skills/skill-store.js';

const STUDIO_EVENTS_JSONL = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
const fileStore = new FileStore();

type PatternType =
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
  patternType: PatternType;
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
    const allEvents = await fileStore.readJsonl<any>(STUDIO_EVENTS_JSONL);
    const events = allEvents
      .filter((e: any) => e.payload && typeof e.payload === 'string' && e.payload.includes(sessionId))
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

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
      durationMs = new Date(endEvent.createdAt).getTime() - new Date(startEvent.createdAt).getTime();
    }

    // Classify patternType
    const patternType = classifyPattern(filesChanged, toolsUsed, agentId);

    const summary: SessionSummary = {
      sessionId,
      agentId,
      filesChanged,
      toolsUsed,
      patternType,
      eventCount: events.length,
      durationMs,
    };

    // Store as StudioEvent
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'session:summary',
      source: agentId,
      payload: JSON.stringify(summary),
      createdAt: new Date().toISOString(),
    });

    logger.info('[SessionSummary] Generated', {
      sessionId,
      patternType,
      filesChanged: filesChanged.length,
      toolsUsed: toolsUsed.length,
    });

    // KE-001 Phase 5: suggest Skill for recurring patterns (fire-and-forget)
    suggestSkillForPattern(patternType, toolsUsed).catch((err: unknown) => {
      logger.warn('[SessionSummary] Skill suggestion failed', { patternType, error: String(err) });
    });

    return summary;
  } catch (e: unknown) {
    logger.warn('[SessionSummary] Generation failed', { sessionId, error: String(e) });
    return null;
  }
}

/**
 * D3: Pattern type classification — pure rules, no LLM.
 * File paths + tool sequences + agentId → PatternType.
 */
function classifyPattern(files: string[], tools: string[], _agentId: string): PatternType {
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
 * KE-001 Phase 5: Suggest Skill for recurring patterns.
 * If a patternType appears 3+ times and has no matching Skill, create a proposal.
 */
async function suggestSkillForPattern(patternType: PatternType, toolsUsed: string[]): Promise<void> {
  if (patternType === 'unknown') return;

  // Count recent sessions of this pattern type
  const allSummariesEvents = await fileStore.readJsonl<any>(STUDIO_EVENTS_JSONL);
  const recentSummaries = allSummariesEvents.filter((e: any) =>
    e.type === 'session:summary' &&
    typeof e.payload === 'string' && e.payload.includes(`"patternType":"${patternType}"`) &&
    new Date(e.createdAt).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000
  ).length;

  if (recentSummaries < 3) return; // Not recurring enough

  // Check if a Skill already exists for this pattern
  const byCategory = skillStore.findFirst({ companyId: 'system', category: patternType });
  const byName = skillStore.findFirst({ companyId: 'system', name: { contains: patternType } });
  const existingSource = (byCategory || byName);
  if (existingSource && ['proposal', 'extraction', 'builtin'].includes(existingSource.source)) return; // Already has a Skill

  // Create proposal
  skillStore.create({
    companyId: 'system',
    name: `Pattern: ${patternType}`.slice(0, 100),
    source: 'proposal',
    status: 'draft',
    category: patternType,
    description: `Recurring pattern "${patternType}" detected (${recentSummaries} sessions in 30d). Tools: ${toolsUsed.join(', ')}`,
    tools: JSON.stringify(toolsUsed),
    metadata: JSON.stringify({
      autoGenerated: true,
      patternType,
      sessionCount: recentSummaries,
      trigger: 'session-summary',
    }),
  });

  logger.info('[SessionSummary] Skill proposal for recurring pattern', { patternType, sessionCount: recentSummaries });
}
