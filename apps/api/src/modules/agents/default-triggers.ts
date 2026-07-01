// Default Triggers — 9 system triggers for Agent Network
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import type { TriggerConfig } from '../triggers/trigger.types.js';

/** Register the 9 default system triggers */
export function registerDefaultTriggers(registry: TriggerScheduler): void {
  // 1. agent-discover: EVENT workunit.created → EXECUTE agent-loop
  registry.registerTrigger({
    id: 'agent-discover',
    name: 'Auto-discover new WorkUnits',
    condition: { type: 'EVENT', event: 'workunit.created' },
    action: { type: 'EXECUTE', target: 'agent-loop' },
    enabled: true,
    scope: 'system',
  });

  // 2. workunit-timeout: SCHEDULE every 5 min → UPDATE workunit (timeout release)
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

  // 3. dependency-unlock: EVENT workunit.done → UPDATE workunit (unlock dependents)
  registry.registerTrigger({
    id: 'dependency-unlock',
    name: 'Unlock dependent WorkUnits',
    condition: { type: 'EVENT', event: 'workunit.done' },
    action: {
      type: 'UPDATE',
      target: 'workunit',
      config: {
        query: { status: 'blocked', dependsOn: { contains: '$event.id' } },
        update: { status: 'unassigned' },
      },
    },
    enabled: true,
    scope: 'system',
  });

  // 4. poll-fallback: SCHEDULE every 30s → EXECUTE agent-scan-workunits
  registry.registerTrigger({
    id: 'poll-fallback',
    name: 'Fallback poll for unassigned WorkUnits',
    condition: { type: 'SCHEDULE', cron: '*/30 * * * *' },
    action: { type: 'EXECUTE', target: 'agent-scan-workunits' },
    enabled: true,
    scope: 'system',
  });

  // 5. agent-timeout: SCHEDULE every 2min → EXECUTE agent-timeout-scan
  registry.registerTrigger({
    id: 'agent-timeout',
    name: 'Release timed-out Agent instances',
    condition: { type: 'SCHEDULE', cron: '*/2 * * * *' },
    action: { type: 'EXECUTE', target: 'agent-timeout-scan' },
    enabled: true,
    scope: 'system',
  });

  // 6. knowledge-quality-audit: SCHEDULE daily 3:17 → CREATE WorkUnit for semantic audit
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

  // 7. session-knowledge-extraction: SCHEDULE daily 4:17 → CREATE WorkUnit for session extraction
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

  // 8. zero-consumption-audit: SCHEDULE daily 5:17 → CREATE WorkUnit for zero-consumption review
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

  // 9. knowledge-synthesis: SCHEDULE weekly Monday 10:23 → CREATE WorkUnit for Skill proposal
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
      id: 'agent-discover',
      name: 'Auto-discover new WorkUnits',
      condition: { type: 'EVENT', event: 'workunit.created' },
      action: { type: 'EXECUTE', target: 'agent-loop' },
      enabled: true,
      scope: 'system',
    },
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
      id: 'dependency-unlock',
      name: 'Unlock dependent WorkUnits',
      condition: { type: 'EVENT', event: 'workunit.done' },
      action: {
        type: 'UPDATE',
        target: 'workunit',
        config: {
          query: { status: 'blocked', dependsOn: { contains: '$event.id' } },
          update: { status: 'unassigned' },
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'poll-fallback',
      name: 'Fallback poll for unassigned WorkUnits',
      condition: { type: 'SCHEDULE', cron: '*/30 * * * *' },
      action: { type: 'EXECUTE', target: 'agent-scan-workunits' },
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
