/**
 * AC: ac-trigger-cleanup
 *
 * Source-code verification:
 * - 3 triggers removed from default-triggers.ts (9→7)
 *   - okr-metric-sync was added back later (7 total)
 *   - workunit-input-reminder added by F5 双向沟通 (8 total)
 *   - evolution-daily-scan added by E1 约束进化 (9 total)
 *   - doc-semantic-review added by 2026-07 文档治理闭环 P1 (10 total)
 * - EVENT condition type re-added by PMO-Channel-Agent-Flow SDD AC-1
 * - subscribeEvent/unsubscribeEvent removed from trigger-scheduler.ts (replaced by registerTrigger EVENT handling)
 * - resolveTemplate/getNestedValue removed from trigger-action.ts
 * - retained triggers intact
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const AGENTS_DIR = path.resolve(__dirname, '../../agents');
const TRIGGERS_DIR = path.resolve(__dirname, '..');

describe('Trigger cleanup verification', () => {
  it('default triggers count is 10 (8 retained + E1 evolution-daily-scan + doc-semantic-review)', async () => {
    const mod = await import('../../agents/default-triggers.js');
    const configs = mod.getDefaultTriggerConfigs();
    expect(configs).toHaveLength(10);
  });

  it('okr-metric-sync trigger is present', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'default-triggers.ts'), 'utf-8');
    expect(content).toMatch(/okr-metric-sync/);
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

  it('EVENT condition type is present in TriggerCondition (re-added by PMO-SDD AC-1)', () => {
    const content = fs.readFileSync(path.join(TRIGGERS_DIR, 'trigger.types.ts'), 'utf-8');
    // AC-1 of PMO-Channel-Agent-Flow SDD re-introduced EVENT type
    expect(content).toMatch(/type:\s*'EVENT'/);
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
    expect(ids).toContain('okr-metric-sync');
    expect(ids).toContain('session-knowledge-extraction');
    expect(ids).toContain('zero-consumption-audit');
    expect(ids).toContain('knowledge-synthesis');
  });
});
