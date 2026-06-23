// Trigger Registry Types (3.28c-4)
// Trigger = condition (when) + action (what)

/** Trigger condition — when to fire */
export interface TriggerCondition {
  type: 'SCHEDULE';
  cron: string; // cron expression: "17 9 * * *"
}

/** Trigger action — what to do when fired */
export interface TriggerAction {
  type: 'CREATE';
  target: 'WorkUnit';
  payload: {
    type: string;   // WorkUnit type: task | analysis | monitor | discussion
    scope: string;  // WorkUnit scope
    channelId?: string;
    metadata?: Record<string, unknown>;
  };
}

/** Full trigger definition (matches YAML schema) */
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
