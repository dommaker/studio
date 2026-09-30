/**
 * bootstrap/services 测试（P2-a）：核心服务启动顺序与原 index.ts 一致——
 * monitor → auditor → RequirementRollup → PmoProgressRollup → OpsService → EvolutionScheduler；
 * 单项失败不阻断后续。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('../../modules/agents/monitor/monitor.service.js', () => ({
  monitorService: { start: () => calls.push('monitor'), stop: vi.fn() },
}));
vi.mock('../../modules/agents/auditor/auditor.service.js', () => ({
  auditorService: { start: () => calls.push('auditor'), stop: vi.fn() },
}));
vi.mock('../../modules/requirements/rollup.js', () => ({
  initRequirementRollup: () => calls.push('requirement-rollup'),
}));
vi.mock('../../modules/pmo/progress-rollup.js', () => ({
  initPmoProgressRollup: () => calls.push('pmo-rollup'),
}));
vi.mock('../../modules/agents/ops/ops.service.js', () => ({
  createOpsService: () => ({ start: () => calls.push('ops') }),
}));
vi.mock('../../modules/knowledge/evolution-scheduler.js', () => ({
  startEvolutionScheduler: () => calls.push('evolution-scheduler'),
  stopEvolutionScheduler: vi.fn(),
}));

import { startCoreServices } from '../services.js';

beforeEach(() => {
  calls.length = 0;
});

describe('startCoreServices', () => {
  it('按原 index.ts 顺序启动全部核心服务', async () => {
    await startCoreServices();
    expect(calls).toEqual([
      'monitor', 'auditor', 'requirement-rollup', 'pmo-rollup', 'ops', 'evolution-scheduler',
    ]);
  });
});
