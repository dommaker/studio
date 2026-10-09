/**
 * bootstrap/services 测试（P2-a）：核心服务启动顺序与原 index.ts 一致——
 * monitor → auditor → RequirementRollup → PmoProgressRollup → OpsService → EvolutionScheduler；
 * 单项失败不阻断后续。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const flags = vi.hoisted(() => ({ failOnMonitor: false }));

// #683：monitorService 与 createOpsService 同归 ops barrel，合并为一个 mock
vi.mock('../../modules/ops/index.js', () => ({
  monitorService: {
    start: () => {
      if (flags.failOnMonitor) throw new Error('monitor boom');
      calls.push('monitor');
    },
    stop: vi.fn(),
  },
  createOpsService: () => ({ start: () => calls.push('ops') }),
}));
vi.mock('../../modules/agent-auditor/index.js', () => ({
  auditorService: { start: () => calls.push('auditor'), stop: vi.fn() },
}));
vi.mock('../../modules/requirements/rollup.js', () => ({
  initRequirementRollup: () => calls.push('requirement-rollup'),
}));
vi.mock('../../modules/pmo/progress-rollup.js', () => ({
  initPmoProgressRollup: () => calls.push('pmo-rollup'),
}));
vi.mock('../../modules/knowledge/evolution-scheduler.js', () => ({
  startEvolutionScheduler: () => calls.push('evolution-scheduler'),
  stopEvolutionScheduler: vi.fn(),
}));

import { startCoreServices } from '../services.js';

beforeEach(() => {
  calls.length = 0;
  flags.failOnMonitor = false;
});

describe('startCoreServices', () => {
  it('按原 index.ts 顺序启动全部核心服务', async () => {
    await startCoreServices();
    expect(calls).toEqual([
      'monitor', 'auditor', 'requirement-rollup', 'pmo-rollup', 'ops', 'evolution-scheduler',
    ]);
  });

  it('monitor 启动失败只 warn 不拒启，后续服务照常启动（#686 纪律固化）', async () => {
    flags.failOnMonitor = true;
    await expect(startCoreServices()).resolves.toBeUndefined();
    expect(calls).toEqual([
      'auditor', 'requirement-rollup', 'pmo-rollup', 'ops', 'evolution-scheduler',
    ]);
  });
});
