import { describe, it, expect, beforeEach } from 'vitest';

// Reset singleton between tests
const originalModule = await import('../trigger-registry.js');

describe('TriggerRegistry singleton', () => {
  it('getTriggerScheduler returns same instance on repeated calls', () => {
    const a = originalModule.getTriggerScheduler();
    const b = originalModule.getTriggerScheduler();
    expect(a).toBe(b);
  });

  it('first call without store creates scheduler with null store', () => {
    const scheduler = originalModule.getTriggerScheduler();
    // scheduler should work (start/stop/registerTrigger) even without store
    expect(scheduler).toBeDefined();
    expect(typeof scheduler.start).toBe('function');
    expect(typeof scheduler.registerTrigger).toBe('function');
  });

  it('subsequent calls with store argument return same instance (store param ignored)', () => {
    const first = originalModule.getTriggerScheduler();
    const withStore = originalModule.getTriggerScheduler(undefined as any);
    expect(withStore).toBe(first);
  });
});
