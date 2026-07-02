/**
 * AC: ac-trigger-cleanup
 *
 * Source-code verification:
 * - 3 triggers removed from default-triggers.ts (9→6)
 * - EVENT condition type removed from trigger.types.ts
 * - subscribeEvent/unsubscribeEvent removed from trigger-scheduler.ts
 * - resolveTemplate/getNestedValue removed from trigger-action.ts
 * - EVENT validation removed from trigger-store.ts
 * - 6 retained triggers intact
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const AGENTS_DIR = path.resolve(__dirname, '../../agents');
const TRIGGERS_DIR = path.resolve(__dirname, '..');

describe('Trigger cleanup verification', () => {
  it('default triggers count is 6 (not 9)', async () => {
    const mod = await import('../../agents/default-triggers.js');
    const configs = mod.getDefaultTriggerConfigs();
    expect(configs).toHaveLength(6);
  });

  it('agent-discover trigger is removed', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'default-triggers.ts'), 'utf-8');
    expect(content).not.toMatch(/agent-discover/);
  });

  it('dependency-unlock trigger is removed', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'default-triggers.ts'), 'utf-8');
    expect(content).not.toMatch(/dependency-unlock/);
  });

  it('poll-fallback trigger is removed', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'default-triggers.ts'), 'utf-8');
    expect(content).not.toMatch(/poll-fallback/);
  });

  it('EVENT condition type is removed from TriggerCondition', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger.types.ts'), 'utf-8');
    // Check that EVENT type variant is gone from TriggerCondition union
    expect(content).not.toMatch(/type:\s*'EVENT'/);
  });

  it('subscribeEvent method is removed from TriggerScheduler', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger-scheduler.ts'), 'utf-8');
    expect(content).not.toMatch(/subscribeEvent/);
  });

  it('unsubscribeEvent method is removed from TriggerScheduler', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger-scheduler.ts'), 'utf-8');
    expect(content).not.toMatch(/unsubscribeEvent/);
  });

  it('eventSubscriptions field is removed from TriggerScheduler', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger-scheduler.ts'), 'utf-8');
    expect(content).not.toMatch(/eventSubscriptions/);
  });

  it('resolveTemplate function is removed from trigger-action', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger-action.ts'), 'utf-8');
    expect(content).not.toMatch(/resolveTemplate/);
  });

  it('getNestedValue function is removed from trigger-action', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger-action.ts'), 'utf-8');
    expect(content).not.toMatch(/getNestedValue/);
  });

  it('EVENT validation is removed from trigger-store', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger-store.ts'), 'utf-8');
    expect(content).not.toMatch(/EVENT/);
  });

  it('retained triggers are intact', async () => {
    const mod = await import('../../agents/default-triggers.js');
    const configs = mod.getDefaultTriggerConfigs();
    const ids = configs.map((c: { id: string }) => c.id);
    expect(ids).toContain('workunit-timeout');
    expect(ids).toContain('agent-timeout');
    expect(ids).toContain('knowledge-quality-audit');
    expect(ids).toContain('session-knowledge-extraction');
    expect(ids).toContain('zero-consumption-audit');
    expect(ids).toContain('knowledge-synthesis');
  });
});
