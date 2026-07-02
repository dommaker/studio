// Trigger Scheduler — periodic cron checker (3.28c-4, AS-026 extended)
// SCHEDULE triggers: checked every 60s tick
import { logger } from '@dommaker/studio-shared';
import { CronMatcher } from './cron-matcher.js';
import { TriggerStore } from './trigger-store.js';
import { executeCreateAction, executeExecuteAction, executeUpdateAction } from './trigger-action.js';
import type { TriggerConfig, TriggerState, TriggerLogEntry } from './trigger.types.js';

const TICK_INTERVAL_MS = 60_000; // 1 minute

export class TriggerScheduler {
  private store: TriggerStore;
  private states: Map<string, TriggerState> = new Map();
  private logs: TriggerLogEntry[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(store: TriggerStore) {
    this.store = store;
  }

  /** Load triggers from YAML store and initialize states */
  loadTriggers(): void {
    const triggers = this.store.list();
    const newStates = new Map<string, TriggerState>();

    for (const config of triggers) {
      const existing = this.states.get(config.id);
      newStates.set(config.id, existing || {
        config,
        lastFiredAt: null,
        nextFireAt: null,
        errorCount: 0,
      });
      newStates.get(config.id)!.config = config;
    }

    this.states = newStates;
  }

  /**
   * Register a trigger programmatically.
   * If trigger already exists, updates config.
   */
  registerTrigger(trigger: TriggerConfig): void {
    const existing = this.states.get(trigger.id);
    this.states.set(trigger.id, existing || {
      config: trigger,
      lastFiredAt: null,
      nextFireAt: null,
      errorCount: 0,
    });
    this.states.get(trigger.id)!.config = trigger;

    this.log(trigger.id, 'tick', `Trigger "${trigger.name}" registered (${trigger.condition.type})`);
  }

  /** Unregister a trigger */
  unregisterTrigger(id: string): void {
    this.states.delete(id);
    this.log(id, 'tick', `Trigger unregistered`);
  }

  /** Enable a trigger */
  enableTrigger(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.config = { ...state.config, enabled: true };
  }

  /** Disable a trigger */
  disableTrigger(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.config = { ...state.config, enabled: false };
  }

  /** Start the scheduler */
  start(): void {
    if (this.intervalId) return;

    if (this.store) {
      this.loadTriggers();
    }
    this.log('scheduler', 'tick', `Scheduler started with ${this.states.size} triggers`);

    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.log('scheduler', 'tick', 'Scheduler stopped');
  }

  /** Check if scheduler is running */
  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /** Manual tick — check SCHEDULE triggers against current time */
  tick(now: Date = new Date()): void {
    for (const [id, state] of this.states) {
      if (!state.config.enabled) continue;
      if (state.config.condition.type !== 'SCHEDULE') continue;

      try {
        const matcher = new CronMatcher(state.config.condition.cron);
        if (matcher.matches(now)) {
          this.log(id, 'fired', `Trigger "${state.config.name}" fired`);
          this.executeTrigger(state.config).catch(err => {
            state.errorCount++;
            this.log(id, 'error', `Trigger "${state.config.name}" failed: ${err.message}`);
          });
          state.lastFiredAt = now;
        }
      } catch (err) {
        state.errorCount++;
        this.log(id, 'error', `Cron parse error for "${id}": ${(err as Error).message}`);
      }
    }
  }

  /** Execute a trigger's action */
  private async executeTrigger(config: TriggerConfig, context?: unknown): Promise<void> {
    switch (config.action.type) {
      case 'CREATE':
        await executeCreateAction(config.action, config.id);
        break;
      case 'EXECUTE':
        await executeExecuteAction(config.action, context);
        break;
      case 'UPDATE':
        await executeUpdateAction(config.action, context);
        break;
    }
  }

  /** Get current trigger states */
  getStates(): TriggerState[] {
    return Array.from(this.states.values());
  }

  /** Get log entries */
  getLogs(): TriggerLogEntry[] {
    return [...this.logs];
  }

  /** Add a log entry */
  private log(triggerId: string, event: TriggerLogEntry['event'], message: string): void {
    this.logs.push({
      timestamp: new Date(),
      triggerId,
      event,
      message,
    });
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }
  }
}
