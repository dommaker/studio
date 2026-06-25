// Default Triggers — 4 system triggers for Agent Network (AS-026, AC-4)
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import type { TriggerConfig } from '../triggers/trigger.types.js';

/** Register the 4 default system triggers */
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
  ];
}
