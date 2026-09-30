/**
 * bootstrap/handlers 测试（P2-a）：6 个 EXECUTE handler 按原 index.ts 顺序注册；
 * handler 本体接线正确（以 agent-timeout-scan 为例）；evolution adapter 单例构造即注册。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registry = vi.hoisted(() => new Map<string, () => Promise<void>>());
const spies = vi.hoisted(() => ({
  scanStaleAgentInstances: vi.fn(async () => ({ terminated: 2 })),
  getEvolutionService: vi.fn(() => ({})),
}));

vi.mock('../../modules/triggers/trigger-action.js', () => ({
  registerExecuteHandler: (name: string, fn: () => Promise<void>) => registry.set(name, fn),
}));
vi.mock('../../modules/agents/instance-timeout-scan.js', () => ({
  scanStaleAgentInstances: spies.scanStaleAgentInstances,
}));
vi.mock('../../modules/evolution/evolution.service.js', () => ({
  getEvolutionService: spies.getEvolutionService,
}));

import { registerScanHandlers } from '../handlers.js';

beforeEach(() => {
  registry.clear();
  spies.scanStaleAgentInstances.mockClear();
  spies.getEvolutionService.mockClear();
});

describe('registerScanHandlers', () => {
  it('按原 index.ts 顺序注册 6 个 handler', async () => {
    await registerScanHandlers();
    expect([...registry.keys()]).toEqual([
      'agent-timeout-scan',
      'workunit-input-reminder-scan',
      'workunit-gate-escalation-scan',
      'workunit-timeout-scan',
      'dispatch-reconciliation-scan',
      'evolution-scan',
    ]);
  });

  it('agent-timeout-scan handler 接线到 scanStaleAgentInstances', async () => {
    await registerScanHandlers();
    await registry.get('agent-timeout-scan')!();
    expect(spies.scanStaleAgentInstances).toHaveBeenCalledOnce();
  });

  it('evolution review-proposal adapter 随注册构造单例', async () => {
    await registerScanHandlers();
    expect(spies.getEvolutionService).toHaveBeenCalled();
  });
});
