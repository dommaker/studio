/**
 * AC: ac-trigger-cleanup
 *
 * Source-code verification:
 * - #102 触发器五删：knowledge-quality-audit / session-knowledge-extraction /
 *   zero-consumption-audit / knowledge-synthesis 从代码注册块移除，daily-health-check
 *   数据区 yaml 移除（LLM 形态归确定性探针 monitor-system-probes）。保留 6 个：
 *   workunit-timeout / agent-timeout / okr-metric-sync / workunit-input-reminder /
 *   evolution-daily-scan / doc-semantic-review（enabled:false，恢复归 #103）。
 * - getDefaultTriggerConfigs() 删除 —— 配置真相源归注册块，测试从 TriggerScheduler 取数。
 * - 历史（9→7→10）：okr-metric-sync 加回、workunit-input-reminder（F5 双向沟通）、
 *   evolution-daily-scan（E1 约束进化）、doc-semantic-review（2026-07 文档治理闭环 P1）陆续加入。
 * - EVENT condition type re-added by PMO-Channel-Agent-Flow SDD AC-1
 * - subscribeEvent/unsubscribeEvent removed from trigger-scheduler.ts (replaced by registerTrigger EVENT handling)
 * - resolveTemplate/getNestedValue removed from trigger-action.ts
 * - retained triggers intact
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { registerDefaultTriggers } from '../../agents/default-triggers.js';
import { TriggerScheduler } from '../trigger-scheduler.js';

const AGENTS_DIR = path.resolve(__dirname, '../../agents');
const TRIGGERS_DIR = path.resolve(__dirname, '..');

function registeredIds(): string[] {
  const scheduler = new TriggerScheduler({ store: null });
  registerDefaultTriggers(scheduler);
  return scheduler.getStates().map(s => s.config.id);
}

describe('Trigger cleanup verification', () => {
  it('default triggers count is 6 (10 − 4 pruned by #102)', () => {
    expect(registeredIds()).toHaveLength(6);
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

  it('retained triggers are intact', () => {
    const ids = registeredIds();
    expect(ids).toContain('workunit-timeout');
    expect(ids).toContain('agent-timeout');
    expect(ids).toContain('okr-metric-sync');
    expect(ids).toContain('workunit-input-reminder');
    expect(ids).toContain('evolution-daily-scan');
    expect(ids).toContain('doc-semantic-review');
  });

  it('pruned triggers are gone (#102)', () => {
    const ids = registeredIds();
    expect(ids).not.toContain('knowledge-quality-audit');
    expect(ids).not.toContain('session-knowledge-extraction');
    expect(ids).not.toContain('zero-consumption-audit');
    expect(ids).not.toContain('knowledge-synthesis');
  });
});
