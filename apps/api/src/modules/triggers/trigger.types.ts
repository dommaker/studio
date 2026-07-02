// Trigger Registry Types (3.28c-4, AS-026 extended)
// Trigger = condition (when) + action (what)

/** Trigger condition — when to fire */
export type TriggerCondition = { type: 'SCHEDULE'; cron: string };

/** Trigger action — what to do when fired */
export type TriggerAction =
  | {
      type: 'CREATE';
      target: 'WorkUnit';
      payload: {
        type: string;   // WorkUnit type: task | analysis | monitor | discussion
        scope: string;  // WorkUnit scope
        channelId?: string;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      type: 'EXECUTE';
      target: string;   // handler name (e.g. 'agent-loop', 'agent-scan-workunits')
      config?: Record<string, unknown>;
    }
  | {
      type: 'UPDATE';
      target: string;   // entity type (e.g. 'workunit')
      config: {
        query: Record<string, unknown>;
        update: Record<string, unknown>;
      };
    };

/** Full trigger definition */
export interface TriggerConfig {
  id: string;
  name: string;
  condition: TriggerCondition;
  action: TriggerAction;
  enabled: boolean;
  scope: string; // system | user | project
}

/** Runtime state for a trigger */
export interface TriggerState {
  config: TriggerConfig;
  lastFiredAt: Date | null;
  nextFireAt: Date | null;
  errorCount: number;
}

/** Scheduler log entry */
export interface TriggerLogEntry {
  timestamp: Date;
  triggerId: string;
  event: 'tick' | 'fired' | 'error' | 'skipped';
  message: string;
}

/** Handler function type for EXECUTE actions */
export type TriggerExecuteHandler = (context: unknown) => Promise<void>;
