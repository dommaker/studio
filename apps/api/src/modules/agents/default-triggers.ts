// Default Triggers — 7 system triggers for Agent Network
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import type { TriggerConfig } from '../triggers/trigger.types.js';

/** Register the 7 default system triggers */
export function registerDefaultTriggers(registry: TriggerScheduler): void {
  // 1. workunit-timeout: SCHEDULE every 5 min → UPDATE workunit (timeout release)
  registry.registerTrigger({
    id: 'workunit-timeout',
    name: 'Release timed-out WorkUnits',
    condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
    action: {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { status: 'active', timeoutAt: { lt: new Date().toISOString() } },
        update: { status: 'unassigned', assigneeId: null },
      },
    },
    enabled: true,
    scope: 'system',
  });

  // 2. agent-timeout: SCHEDULE every 2min → EXECUTE agent-timeout-scan
  registry.registerTrigger({
    id: 'agent-timeout',
    name: 'Release timed-out Agent instances',
    condition: { type: 'SCHEDULE', cron: '*/2 * * * *' },
    action: { type: 'EXECUTE', target: 'agent-timeout-scan' },
    enabled: true,
    scope: 'system',
  });

  // 3. knowledge-quality-audit: SCHEDULE daily 3:17 → CREATE WorkUnit for semantic audit
  registry.registerTrigger({
    id: 'knowledge-quality-audit',
    name: 'Daily knowledge quality semantic audit',
    condition: { type: 'SCHEDULE', cron: '17 3 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Run knowledge-quality-skill: audit semantic quality of ~/.studio/knowledge/. Check D1-D6 dimensions. Archive low_quality noise entries. Merge fragment clusters. Rebuild _index.md after convergence.',
      },
    },
    enabled: true,
    scope: 'system',
  });

  // 4. okr-metric-sync: SCHEDULE daily 3:47 → EXECUTE okr-metric-sync
  registry.registerTrigger({
    id: 'okr-metric-sync',
    name: 'OKR Metric Sync',
    condition: { type: 'SCHEDULE', cron: '47 3 * * *' },
    action: { type: 'EXECUTE', target: 'okr-metric-sync' },
    scope: 'system',
    enabled: true,
  });

  // 5. session-knowledge-extraction: SCHEDULE daily 4:17 → CREATE WorkUnit for session extraction
  registry.registerTrigger({
    id: 'session-knowledge-extraction',
    name: 'Daily session knowledge extraction',
    condition: { type: 'SCHEDULE', cron: '17 4 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Scan ~/.studio/data/sessions/ for unprocessed JSONL files. Extract knowledge using knowledge-extraction skill. Mark processed files with .done suffix.',
      },
    },
    enabled: true,
    scope: 'system',
  });

  // 6. zero-consumption-audit: SCHEDULE daily 5:17 → CREATE WorkUnit for zero-consumption review
  registry.registerTrigger({
    id: 'zero-consumption-audit',
    name: 'Daily zero-consumption knowledge audit',
    condition: { type: 'SCHEDULE', cron: '17 5 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Scan ~/.studio/knowledge/ for entries with empty referencedBy. Output audit report to ~/.studio/data/knowledge-consumption-audit.md with entry list, creation dates, and recommendations (keep/archive).',
      },
    },
    enabled: true,
    scope: 'system',
  });

  // 7. knowledge-synthesis: SCHEDULE weekly Monday 10:23 → CREATE WorkUnit for Skill proposal
  registry.registerTrigger({
    id: 'knowledge-synthesis',
    name: 'Weekly knowledge synthesis and Skill proposal',
    condition: { type: 'SCHEDULE', cron: '23 10 * * 1' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Execute knowledge-synthesis-skill: scan recent knowledge entries for semantic patterns. If 3+ entries share an underlying pattern, propose a new Skill via skill-creator.',
      },
    },
    enabled: true,
    scope: 'system',
  });

}

/** Get default trigger configs (for testing) */
export function getDefaultTriggerConfigs(): TriggerConfig[] {
  return [
    {
      id: 'workunit-timeout',
      name: 'Release timed-out WorkUnits',
      condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
      action: {
        type: 'UPDATE',
        target: 'workunit',
        config: {
          query: { status: 'active' },
          update: { status: 'unassigned', assigneeId: null },
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'agent-timeout',
      name: 'Release timed-out Agent instances',
      condition: { type: 'SCHEDULE', cron: '*/2 * * * *' },
      action: { type: 'EXECUTE', target: 'agent-timeout-scan' },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'knowledge-quality-audit',
      name: 'Daily knowledge quality semantic audit',
      condition: { type: 'SCHEDULE', cron: '17 3 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Run knowledge-quality-skill: audit semantic quality of ~/.studio/knowledge/. Check D1-D6 dimensions. Archive low_quality noise entries. Merge fragment clusters. Rebuild _index.md after convergence.',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'okr-metric-sync',
      name: 'OKR Metric Sync',
      condition: { type: 'SCHEDULE', cron: '47 3 * * *' },
      action: { type: 'EXECUTE', target: 'okr-metric-sync' },
      scope: 'system',
      enabled: true,
    },
    {
      id: 'session-knowledge-extraction',
      name: 'Daily session knowledge extraction',
      condition: { type: 'SCHEDULE', cron: '17 4 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Scan ~/.studio/data/sessions/ for unprocessed JSONL files. Extract knowledge using knowledge-extraction skill. Mark processed files with .done suffix.',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'zero-consumption-audit',
      name: 'Daily zero-consumption knowledge audit',
      condition: { type: 'SCHEDULE', cron: '17 5 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Scan ~/.studio/knowledge/ for entries with empty referencedBy. Output audit report to ~/.studio/data/knowledge-consumption-audit.md with entry list, creation dates, and recommendations (keep/archive).',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'knowledge-synthesis',
      name: 'Weekly knowledge synthesis and Skill proposal',
      condition: { type: 'SCHEDULE', cron: '23 10 * * 1' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Execute knowledge-synthesis-skill: scan recent knowledge entries for semantic patterns. If 3+ entries share an underlying pattern, propose a new Skill via skill-creator.',
        },
      },
      enabled: true,
      scope: 'system',
    },
  ];
}
