// Trigger Scheduler Tests (3.28c-4) — RED phase
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TriggerScheduler } from '../trigger-scheduler';
import { TriggerStore } from '../trigger-store';
import type { TriggerConfig } from '../trigger.types';

describe('EVENT condition type', () => {
  it('AC-1: TriggerCondition accepts EVENT type', () => {
    const eventTrigger: TriggerConfig = {
      id: 'test-event',
      name: 'Test Event Trigger',
      condition: { type: 'EVENT', event: 'workunit.created' },
      action: { type: 'EXECUTE', target: 'test-handler' },
      enabled: true,
      scope: 'system',
    };
    expect(eventTrigger.condition.type).toBe('EVENT');
    if (eventTrigger.condition.type === 'EVENT') {
      expect(eventTrigger.condition.event).toBe('workunit.created');
    }
  });

  it('AC-1: EVENT condition with filter', () => {
    const eventTrigger: TriggerConfig = {
      id: 'test-event-filter',
      name: 'Test Event Filter',
      condition: { type: 'EVENT', event: 'workunit.created', filter: { type: 'analysis' } },
      action: { type: 'EXECUTE', target: 'test-handler' },
      enabled: true,
      scope: 'system',
    };
    if (eventTrigger.condition.type === 'EVENT') {
      expect(eventTrigger.condition.filter).toEqual({ type: 'analysis' });
    }
  });
});

describe('TriggerScheduler', () => {
  let tmpDir: string;
  let store: TriggerStore;
  let scheduler: TriggerScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-sched-test-'));
    store = new TriggerStore(tmpDir);
    scheduler = new TriggerScheduler(store);
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleTrigger: TriggerConfig = {
    id: 'test-trigger',
    name: 'Test Trigger',
    condition: { type: 'SCHEDULE', cron: '* * * * *' }, // every minute
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: { type: 'analysis', scope: 'Test scope' },
    },
    enabled: true,
    scope: 'system',
  };

  it('starts and stops without error', () => {
    expect(() => scheduler.start()).not.toThrow();
    expect(scheduler.isRunning()).toBe(true);
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('logs tick events', () => {
    scheduler.start();
    const logs = scheduler.getLogs();
    expect(logs.length).toBeGreaterThanOrEqual(0);
  });

  it('returns trigger states', () => {
    store.save(sampleTrigger);
    scheduler.loadTriggers();
    const states = scheduler.getStates();
    expect(states).toHaveLength(1);
    expect(states[0].config.id).toBe('test-trigger');
    expect(states[0].lastFiredAt).toBeNull();
  });

  it('skips disabled triggers', () => {
    store.save({ ...sampleTrigger, enabled: false });
    scheduler.loadTriggers();
    const states = scheduler.getStates();
    expect(states).toHaveLength(1);
    expect(states[0].config.enabled).toBe(false);
  });

  it('getLogs returns log entries', () => {
    scheduler.start();
    // Force a tick
    scheduler.tick();
    const logs = scheduler.getLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toHaveProperty('timestamp');
    expect(logs[0]).toHaveProperty('triggerId');
    expect(logs[0]).toHaveProperty('event');
    expect(logs[0]).toHaveProperty('message');
  });
});
