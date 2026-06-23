// Trigger Store Tests (3.28c-4) — RED phase
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TriggerStore } from '../trigger-store';
import type { TriggerConfig } from '../trigger.types';

describe('TriggerStore', () => {
  let tmpDir: string;
  let store: TriggerStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-test-'));
    store = new TriggerStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleTrigger: TriggerConfig = {
    id: 'daily-health-check',
    name: '系统健康巡检',
    condition: { type: 'SCHEDULE', cron: '17 9 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: { type: 'analysis', scope: '系统健康巡检', channelId: 'ops' },
    },
    enabled: true,
    scope: 'system',
  };

  it('returns empty array when no triggers exist', () => {
    const triggers = store.list();
    expect(triggers).toEqual([]);
  });

  it('saves and loads a trigger from YAML', () => {
    store.save(sampleTrigger);
    const triggers = store.list();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].id).toBe('daily-health-check');
    expect(triggers[0].name).toBe('系统健康巡检');
    expect(triggers[0].condition.cron).toBe('17 9 * * *');
    expect(triggers[0].action.payload.scope).toBe('系统健康巡检');
  });

  it('loads multiple triggers', () => {
    store.save(sampleTrigger);
    store.save({ ...sampleTrigger, id: 'second-trigger', name: 'Second' });
    const triggers = store.list();

    expect(triggers).toHaveLength(2);
    expect(triggers.map(t => t.id).sort()).toEqual(['daily-health-check', 'second-trigger']);
  });

  it('gets trigger by id', () => {
    store.save(sampleTrigger);
    const trigger = store.get('daily-health-check');

    expect(trigger).toBeDefined();
    expect(trigger?.name).toBe('系统健康巡检');
  });

  it('returns undefined for unknown id', () => {
    const trigger = store.get('nonexistent');
    expect(trigger).toBeUndefined();
  });

  it('overwrites trigger with same id', () => {
    store.save(sampleTrigger);
    store.save({ ...sampleTrigger, name: 'Updated Name' });
    const triggers = store.list();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].name).toBe('Updated Name');
  });

  it('deletes a trigger', () => {
    store.save(sampleTrigger);
    const deleted = store.delete('daily-health-check');
    expect(deleted).toBe(true);

    const triggers = store.list();
    expect(triggers).toHaveLength(0);
  });

  it('delete returns false for unknown id', () => {
    const deleted = store.delete('nonexistent');
    expect(deleted).toBe(false);
  });

  it('validates required fields', () => {
    const invalid = { id: 'x', name: 'y' } as TriggerConfig;
    expect(() => store.save(invalid)).toThrow();
  });

  it('validates cron expression format', () => {
    const invalid = {
      ...sampleTrigger,
      condition: { type: 'SCHEDULE', cron: 'invalid cron' },
    } as TriggerConfig;
    expect(() => store.save(invalid)).toThrow(/cron/);
  });
});
