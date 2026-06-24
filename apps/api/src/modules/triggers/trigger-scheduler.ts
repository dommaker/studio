// Trigger Scheduler — periodic cron checker + event subscriber (3.28c-4, AS-026 extended)
// SCHEDULE triggers: checked every 60s tick
// EVENT triggers: subscribe to EventBus, fire on matching events
import { eventBus, logger } from '@dommaker/studio-shared';
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
  /** Track EventBus subscriptions for EVENT triggers (triggerId → unsubscribe fn) */
  private eventSubscriptions: Map<string, () => void> = new Map();

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
   * Register a trigger programmatically (used by AgentLoop for EVENT triggers).
   * If trigger has EVENT condition, subscribes to EventBus.
   * If trigger already exists, updates config and re-subscribes if needed.
   */
  registerTrigger(trigger: TriggerConfig): void {
    // Unsubscribe existing EVENT subscription if updating
    this.unsubscribeEvent(trigger.id);

    const existing = this.states.get(trigger.id);
    this.states.set(trigger.id, existing || {
      config: trigger,
      lastFiredAt: null,
      nextFireAt: null,
      errorCount: 0,
    });
    this.states.get(trigger.id)!.config = trigger;

    // Subscribe to EventBus for EVENT conditions
    if (trigger.condition.type === 'EVENT' && trigger.enabled) {
      this.subscribeEvent(trigger);
    }

    this.log(trigger.id, 'tick', `Trigger "${trigger.name}" registered (${trigger.condition.type})`);
  }

  /** Unregister a trigger and clean up subscriptions */
  unregisterTrigger(id: string): void {
    this.unsubscribeEvent(id);
    this.states.delete(id);
    this.log(id, 'tick', `Trigger unregistered`);
  }

  /** Enable a trigger */
  enableTrigger(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.config = { ...state.config, enabled: true };
    if (state.config.condition.type === 'EVENT') {
      this.subscribeEvent(state.config);
    }
  }

  /** Disable a trigger */
  disableTrigger(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.config = { ...state.config, enabled: false };
    this.unsubscribeEvent(id);
  }

  /** Start the scheduler */
  start(): void {
    if (this.intervalId) return;

    this.loadTriggers();
    this.log('scheduler', 'tick', `Scheduler started with ${this.states.size} triggers`);

    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the scheduler and clean up all subscriptions */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const [id] of this.eventSubscriptions) {
      this.unsubscribeEvent(id);
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

  /** Subscribe to EventBus for an EVENT trigger */
  private subscribeEvent(trigger: TriggerConfig): void {
    if (trigger.condition.type !== 'EVENT') return;

    const eventName = trigger.condition.event;
    const filter = trigger.condition.filter;
    const handler = (payload: unknown) => {
      const state = this.states.get(trigger.id);
      if (!state || !state.config.enabled) return;

      // Apply filter if configured
      if (filter) {
        const eventPayload = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
        for (const [key, expected] of Object.entries(filter)) {
          if (eventPayload[key] !== expected) return;
        }
      }

      this.log(trigger.id, 'fired', `EVENT trigger "${trigger.name}" fired on ${eventName}`);
      this.executeTrigger(trigger, payload).catch(err => {
        if (state) state.errorCount++;
        this.log(trigger.id, 'error', `EVENT trigger "${trigger.name}" failed: ${err.message}`);
      });
      if (state) state.lastFiredAt = new Date();
    };

    eventBus.subscribe(eventName, handler);
    this.eventSubscriptions.set(trigger.id, () => eventBus.unsubscribe(eventName, handler));
  }

  /** Unsubscribe from EventBus for a trigger */
  private unsubscribeEvent(triggerId: string): void {
    const unsub = this.eventSubscriptions.get(triggerId);
    if (unsub) {
      unsub();
      this.eventSubscriptions.delete(triggerId);
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
