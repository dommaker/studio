/**
 * Trigger Registry — singleton TriggerScheduler instance
 *
 * Single source of truth for all trigger consumers (routes, AgentLoop, default-triggers).
 * YAML store is optional — injected when user-defined trigger support is needed.
 */
import { TriggerScheduler } from './trigger-scheduler.js';

let _instance: TriggerScheduler | null = null;

/** Get or create the singleton TriggerScheduler instance */
export function getTriggerScheduler(store?: import('./trigger-store.js').TriggerStore): TriggerScheduler {
  if (!_instance) {
    _instance = new TriggerScheduler(store ?? null);
  }
  return _instance;
}
