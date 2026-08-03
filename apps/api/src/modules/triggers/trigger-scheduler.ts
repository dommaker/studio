// Trigger Scheduler — periodic cron checker + EVENT subscriber (3.28c-4, AS-026 extended)
// SCHEDULE triggers: checked every 60s tick
// EVENT triggers: subscribe to EventBus, fire on matching events
import { logger, type StudioEventBus } from '@dommaker/studio-shared';
import { CronMatcher } from './cron-matcher.js';
import { TriggerStore } from './trigger-store.js';
import {
  executeCreateAction,
  executeExecuteAction,
  executeUpdateAction,
  registerExecuteHandler as registerActionHandler,
} from './trigger-action.js';
import type { TriggerConfig, TriggerState, TriggerLogEntry } from './trigger.types.js';

const TICK_INTERVAL_MS = 60_000; // 1 minute

export interface TriggerSchedulerDeps {
  store: TriggerStore | null;
  eventBus?: StudioEventBus;
}

export class TriggerScheduler {
  private store: TriggerStore | null;
  private eventBus?: StudioEventBus;
  private states: Map<string, TriggerState> = new Map();
  private logs: TriggerLogEntry[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Map<string, () => void> = new Map(); // triggerId → unsubscribe

  constructor(deps: TriggerSchedulerDeps) {
    this.store = deps.store;
    this.eventBus = deps.eventBus;
  }

  /** Load triggers from YAML store and initialize states */
  loadTriggers(): void {
    if (!this.store) return;
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
   * EVENT triggers: subscribe to EventBus.
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

    // EVENT trigger: subscribe to eventBus
    if (trigger.condition.type === 'EVENT' && this.eventBus) {
      // Clean up old subscription if re-registering
      this.subscriptions.get(trigger.id)?.();

      const eventName = trigger.condition.event;
      const handler = (payload: unknown) => this.handleEvent(trigger, payload);
      this.eventBus.subscribe(eventName, handler);
      this.subscriptions.set(trigger.id, () => {
        this.eventBus!.unsubscribe(eventName, handler);
      });
    }

    this.log(trigger.id, 'tick', `Trigger "${trigger.name}" registered (${trigger.condition.type})`);
  }

  /** Register an EXECUTE action handler (delegates to trigger-action registry) */
  registerExecuteHandler(target: string, handler: (payload: unknown) => Promise<void>): void {
    registerActionHandler(target, handler);
  }

  /** Unregister a trigger and clean up event subscription */
  unregisterTrigger(id: string): void {
    this.subscriptions.get(id)?.();
    this.subscriptions.delete(id);
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

  /** Stop scheduler and clean up all event subscriptions */
  dispose(): void {
    this.stop();
    for (const unsub of this.subscriptions.values()) {
      unsub();
    }
    this.subscriptions.clear();
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
          // B3 触发器幂等（2026-08-03 token-burn issue）：cron 匹配是分钟粒度，
          // 同一分钟内不重复触发（事件循环 stall 两个 tick 落进同一分钟的兜底；
          // 跨进程/重启的重复触发由 executeCreateAction 的落盘去重兜底）。
          const minuteStart = new Date(now).setSeconds(0, 0);
          if (state.lastFiredAt && state.lastFiredAt.getTime() >= minuteStart) {
            this.log(id, 'tick', `Trigger "${state.config.name}" skipped: already fired this minute`);
            continue;
          }
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
        // B3 幂等：仅 SCHEDULE（cron）触发做同分钟落盘去重；EVENT 触发按事件语义不去重
        await executeCreateAction(
          config.action,
          config.id,
          config.condition.type === 'SCHEDULE' ? { dedupeWithinMinute: new Date() } : undefined,
        );
        break;
      case 'EXECUTE':
        await executeExecuteAction(config.action, context);
        break;
      case 'UPDATE':
        await executeUpdateAction(config.action, context);
        break;
    }
  }

  /** Handle an incoming event for an EVENT trigger */
  private handleEvent(trigger: TriggerConfig, payload: unknown): void {
    if (!trigger.enabled) return;

    // Filter matching
    if (trigger.condition.type === 'EVENT' && trigger.condition.filter) {
      if (!this.matchFilter(payload, trigger.condition.filter)) return;
    }

    this.log(trigger.id, 'fired', `EVENT trigger "${trigger.name}" fired`);
    this.executeTrigger(trigger, payload).catch(err => {
      const state = this.states.get(trigger.id);
      if (state) state.errorCount++;
      this.log(trigger.id, 'error', `EVENT trigger "${trigger.name}" failed: ${(err as Error).message}`);
    });
  }

  /** Check if event payload matches trigger filter (shallow key-value match) */
  private matchFilter(payload: unknown, filter: Record<string, unknown>): boolean {
    if (typeof payload !== 'object' || payload === null) return false;
    for (const [key, value] of Object.entries(filter)) {
      if ((payload as Record<string, unknown>)[key] !== value) return false;
    }
    return true;
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
