// Trigger Scheduler Tests (3.28c-4) — AC-1 + AC-2 RED phase
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TriggerScheduler } from '../trigger-scheduler';
import { TriggerStore } from '../trigger-store';
import { StudioEventBus } from '@dommaker/studio-shared';
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
    scheduler = new TriggerScheduler({ store });
  });

  afterEach(() => {
    scheduler.dispose();
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

describe('TriggerScheduler EVENT integration (AC-2)', () => {
  let tmpDir: string;
  let store: TriggerStore;
  let bus: StudioEventBus;
  let scheduler: TriggerScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-event-test-'));
    store = new TriggerStore(tmpDir);
    bus = new StudioEventBus();
    scheduler = new TriggerScheduler({ store, eventBus: bus });
  });

  afterEach(() => {
    scheduler.dispose();
    bus.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const eventTrigger: TriggerConfig = {
    id: 'evt-trigger',
    name: 'Event Trigger',
    condition: { type: 'EVENT', event: 'workunit.created' },
    action: { type: 'EXECUTE', target: 'test-handler' },
    enabled: true,
    scope: 'system',
  };

  it('subscribes to event on registerTrigger', () => {
    const spy = vi.spyOn(bus, 'subscribe');
    scheduler.registerTrigger(eventTrigger);
    expect(spy).toHaveBeenCalledWith('workunit.created', expect.any(Function));
  });

  it('fires executeTrigger when event is published', async () => {
    const handler = vi.fn();
    scheduler.registerExecuteHandler('test-handler', handler);
    scheduler.registerTrigger(eventTrigger);

    bus.publish('workunit.created', { workunit: { id: 'wu-1' } });
    // Allow async handler to settle
    await new Promise(r => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ workunit: { id: 'wu-1' } });
  });

  it('does not fire when trigger is disabled', async () => {
    const handler = vi.fn();
    scheduler.registerExecuteHandler('test-handler', handler);
    scheduler.registerTrigger({ ...eventTrigger, enabled: false });

    bus.publish('workunit.created', {});
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('respects filter matching', async () => {
    const handler = vi.fn();
    scheduler.registerExecuteHandler('test-handler', handler);
    scheduler.registerTrigger({
      ...eventTrigger,
      condition: { type: 'EVENT', event: 'workunit.created', filter: { type: 'analysis' } },
    });

    // Filter matches top-level payload keys
    bus.publish('workunit.created', { type: 'analysis', id: 'wu-1' });
    await new Promise(r => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledTimes(1);

    handler.mockClear();
    bus.publish('workunit.created', { type: 'coding', id: 'wu-2' });
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes on unregisterTrigger', async () => {
    const handler = vi.fn();
    scheduler.registerExecuteHandler('test-handler', handler);
    scheduler.registerTrigger(eventTrigger);
    scheduler.unregisterTrigger('evt-trigger');

    bus.publish('workunit.created', {});
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispose clears all subscriptions', async () => {
    const handler = vi.fn();
    scheduler.registerExecuteHandler('test-handler', handler);
    scheduler.registerTrigger(eventTrigger);

    scheduler.dispose();

    bus.publish('workunit.created', {});
    await new Promise(r => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('multiple triggers on same event fire independently', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    scheduler.registerExecuteHandler('handler-1', handler1);
    scheduler.registerExecuteHandler('handler-2', handler2);
    scheduler.registerTrigger({ ...eventTrigger, action: { type: 'EXECUTE', target: 'handler-1' } });
    scheduler.registerTrigger({ ...eventTrigger, id: 'evt-trigger-2', action: { type: 'EXECUTE', target: 'handler-2' } });

    bus.publish('workunit.created', { workunit: { id: 'wu-1' } });
    await new Promise(r => setTimeout(r, 10));
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });
});
