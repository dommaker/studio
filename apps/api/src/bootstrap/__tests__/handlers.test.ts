/**
 * bootstrap/handlers 测试（P2-a）：6 个 EXECUTE handler 按原 index.ts 顺序注册；
 * handler 本体接线正确（以 agent-timeout-scan 为例）；evolution adapter 单例构造即注册。
 * 2026-10-03（C 批）：注册过程 throw 只 warn 不外抛——listen 前移后本步 throw 会经
 * bootstrap catch 落到 exit(1)，发生在端口可服务之后（deploy 判绿后进程死、回滚不触发）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registry = vi.hoisted(() => new Map<string, () => Promise<void>>());
const spies = vi.hoisted(() => ({
  scanStaleAgentInstances: vi.fn(async () => ({ terminated: 2 })),
  runScan: vi.fn(async () => ({ created: [] })),
  getEvolutionService: vi.fn(() => ({ runScan: spies.runScan })),
  loadPmoBoundRepoPaths: vi.fn(async () => ['/repo-a', '/repo-b']),
  recoverWorktreeMerges: vi.fn(async () => ({ attempted: 0, failed: 0 })),
  recoverExternalReplies: vi.fn(async () => ({ attempted: 0, failed: 0 })),
  failOnRegister: { value: false },
}));

vi.mock('../../modules/triggers/trigger-action.js', () => ({
  registerExecuteHandler: (name: string, fn: () => Promise<void>) => {
    if (spies.failOnRegister.value) throw new Error('duplicate handler');
    registry.set(name, fn);
  },
}));
vi.mock('../../modules/ops/index.js', () => ({
  scanStaleAgentInstances: spies.scanStaleAgentInstances,
}));
vi.mock('../../modules/evolution/evolution.service.js', () => ({
  getEvolutionService: spies.getEvolutionService,
}));
vi.mock('../../modules/projects/index.js', () => ({
  loadPmoBoundRepoPaths: spies.loadPmoBoundRepoPaths,
}));
vi.mock('../../modules/workunit/index.js', () => ({
  WorkUnitService: class {},
  recoverWorktreeMerges: spies.recoverWorktreeMerges,
}));
vi.mock('../../modules/channels/index.js', () => ({
  recoverExternalReplies: spies.recoverExternalReplies,
}));
vi.mock('../../modules/agent-loop/index.js', () => ({
  reconcileDispatchBreaks: vi.fn(),
}));

import { registerScanHandlers } from '../handlers.js';

beforeEach(() => {
  registry.clear();
  spies.scanStaleAgentInstances.mockClear();
  spies.getEvolutionService.mockClear();
  spies.recoverWorktreeMerges.mockClear();
  spies.recoverExternalReplies.mockClear();
  spies.failOnRegister.value = false;
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

  it('dispatch-reconciliation-scan 同时恢复持久 merge 与外部回复 intent', async () => {
    await registerScanHandlers();
    await registry.get('dispatch-reconciliation-scan')!();
    expect(spies.recoverWorktreeMerges).toHaveBeenCalledOnce();
    expect(spies.recoverExternalReplies).toHaveBeenCalledOnce();
  });

  it('evolution review-proposal adapter 随注册构造单例', async () => {
    await registerScanHandlers();
    expect(spies.getEvolutionService).toHaveBeenCalled();
  });

  it('evolution scan 逐个扫描 PMO 显式绑定的仓库', async () => {
    await registerScanHandlers();
    await registry.get('evolution-scan')!();
    expect(spies.loadPmoBoundRepoPaths).toHaveBeenCalledOnce();
    expect(spies.runScan.mock.calls).toEqual([['/repo-a'], ['/repo-b']]);
  });

  it('注册失败只 warn 不外抛（listen 后步骤失败不拒启，C 批）', async () => {
    spies.failOnRegister.value = true;
    await expect(registerScanHandlers()).resolves.toBeUndefined();
  });
});
