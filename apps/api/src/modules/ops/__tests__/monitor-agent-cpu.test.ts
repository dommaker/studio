/**
 * MonitorService — CPU load average monitoring
 *
 * AC: systemHealthCheck() detects CPU overload and returns anomaly.
 *   - load > cores×2 → warning
 *   - load > cores×4 → critical
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock os module (loadavg/cpus not configurable, must mock entire module)
const { mockLoadavg, mockCpus } = vi.hoisted(() => ({
  mockLoadavg: vi.fn<[number, number, number]>(() => [0, 0, 0]),
  mockCpus: vi.fn(() => Array(2).fill({ model: 'test' })),
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, loadavg: mockLoadavg, cpus: mockCpus };
});

// Mock all dependencies before importing MonitorService
vi.mock('@dommaker/harness', () => ({
  // harness 3.0.0：linter/scorer/tracker 面出清 → monitor 走 KnowledgeAudit；
  // validators 单例壳删除 → mock 形态改类（new 可构造）
  KnowledgeAudit: class { run() { return { issues: [], healthScore: { before: 100, after: 100 }, autoFixed: 0 }; } },
  CheckpointValidator: class { validate() { return Promise.resolve({ passed: true, results: [] }); } },
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

vi.mock('@dommaker/studio-shared', () => ({ stripTrailingSlashes: (s) => s, createSettledTracker: () => ({ track: () => {}, waitForSettled: async () => {} }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // wholesale mock 补出口：历史消费链（原 studio-notification 包单例）需要，#684 下沉后保留以防链上其余模块触碰
  getDefaultFileStore: () => ({}),
  FileStore: class {
    getIndex = vi.fn(() => Promise.resolve([]));
    upsertSnapshot = vi.fn(() => Promise.resolve());
    removeSnapshot = vi.fn(() => Promise.resolve());
  },
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stop: vi.fn(), execute: vi.fn() },
}));

vi.mock('../../knowledge/knowledge-singletons.js', () => ({
  sharedStore: { list: vi.fn(() => []), save: vi.fn(), update: vi.fn(), delete: vi.fn() },
  sharedLifecycle: { recordReference: vi.fn() },
  sharedIngest: { ingestEntry: vi.fn() },
  UNIFIED_KNOWLEDGE_DIR: '/tmp/test-knowledge',

}));

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: {},
}));

vi.mock('../../knowledge/scheduling/knowledge-sync.service.js', () => ({
  knowledgeSync: {},
}));

vi.mock('../../knowledge/producers/preference-observer.js', () => ({
  preferenceObserver: { record: vi.fn() },
}));

vi.mock('../../triage/index.js', () => ({
  getTriageService: () => ({ handleAlert: vi.fn() }),
}));

import { systemHealthCheck } from '../monitor-system-probes.js';

describe('MonitorService CPU load monitoring', () => {
  beforeEach(() => {
    mockLoadavg.mockReset();
    mockCpus.mockReset();
  });

  it('returns no CPU anomaly when load is normal (load < cores×2)', async () => {
    mockLoadavg.mockReturnValue([1.0, 0.8, 0.5]);
    mockCpus.mockReturnValue(Array(2).fill({ model: 'test' }));

    const anomalies = await systemHealthCheck();
    const cpuAnomalies = anomalies.filter((a: any) => a.message?.includes('CPU'));
    expect(cpuAnomalies).toHaveLength(0);
  });

  it('returns warning when load > cores×2', async () => {
    mockLoadavg.mockReturnValue([5.0, 3.0, 2.0]); // 2 cores, threshold=4
    mockCpus.mockReturnValue(Array(2).fill({ model: 'test' }));

    const anomalies = await systemHealthCheck();
    const cpuAnomalies = anomalies.filter((a: any) => a.message?.includes('CPU'));
    expect(cpuAnomalies).toHaveLength(1);
    expect(cpuAnomalies[0].severity).toBe('warning');
    expect(cpuAnomalies[0].message).toContain('5.0');
  });

  it('returns critical when load > cores×4', async () => {
    mockLoadavg.mockReturnValue([9.0, 5.0, 3.0]); // 2 cores, threshold=8
    mockCpus.mockReturnValue(Array(2).fill({ model: 'test' }));

    const anomalies = await systemHealthCheck();
    const cpuAnomalies = anomalies.filter((a: any) => a.message?.includes('CPU'));
    expect(cpuAnomalies).toHaveLength(1);
    expect(cpuAnomalies[0].severity).toBe('critical');
    expect(cpuAnomalies[0].message).toContain('9.0');
  });

  it('returns no CPU anomaly when load is below 4-core threshold', async () => {
    mockLoadavg.mockReturnValue([5.5, 3.3, 2.2]);
    mockCpus.mockReturnValue(Array(4).fill({ model: 'test' })); // 4 cores, threshold=8

    const anomalies = await systemHealthCheck();
    const cpuAnomalies = anomalies.filter((a: any) => a.message?.includes('CPU'));
    expect(cpuAnomalies).toHaveLength(0);
  });

  it('adapts threshold to core count (4 cores: warning >8, critical >16)', async () => {
    mockLoadavg.mockReturnValue([9.0, 5.0, 3.0]);
    mockCpus.mockReturnValue(Array(4).fill({ model: 'test' }));

    const anomalies = await systemHealthCheck();
    const cpuAnomalies = anomalies.filter((a: any) => a.message?.includes('CPU'));
    expect(cpuAnomalies).toHaveLength(1);
    expect(cpuAnomalies[0].severity).toBe('warning'); // 9 > 8 (4×2) but < 16 (4×4)
  });
});
