/**
 * monitor-system-probes — 系统/知识级探测与自修复
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const {
  tmpWorktrees, tmpRepo, mockLoadavg, mockCpus, mockExecSync,
  mockLogger, mockHandleAlert, mockEmitEvent, mockHealthScore,
  mockRunDecayCycle, mockStoreList, mockRunSyncCycle, mockRunDailyMaintenance,
} = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpWorktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-sysprobes-wt-'));
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-sysprobes-repo-'));
  // WORKTREES_DIR 在模块加载期读取，必须在 import 被测模块前注入
  process.env.WORKTREES_DIR = tmpWorktrees;
  process.env.REPO_DIR = tmpRepo; // 无 .git → 跳过 git worktree prune
  return {
    tmpWorktrees, tmpRepo,
    mockLoadavg: vi.fn<[number, number, number]>(() => [0, 0, 0]),
    mockCpus: vi.fn(() => Array(2).fill({ model: 'test' })),
    mockExecSync: vi.fn(() => ''),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockHandleAlert: vi.fn(() => Promise.resolve()),
    mockEmitEvent: vi.fn(),
    mockHealthScore: vi.fn(() => ({ score: 100, details: [] as any[] })),
    mockRunDecayCycle: vi.fn(() => [] as any[]),
    mockStoreList: vi.fn(() => [] as any[]),
    mockRunSyncCycle: vi.fn(async () => ({ stale: [] as any[], unmonitored: [] as any[], healed: 0 })),
    mockRunDailyMaintenance: vi.fn(async () => ({})),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, loadavg: mockLoadavg, cpus: mockCpus };
});

vi.mock('child_process', () => ({ execSync: mockExecSync }));

vi.mock('@dommaker/studio-shared', () => ({ logger: mockLogger }));

vi.mock('@dommaker/harness', () => ({
  KnowledgeLinter: class { run() { return { fixed: 0 }; } validateEntry() { return []; } },
  KnowledgeHealthScorer: class { healthScore() { return mockHealthScore(); } },
  ReferenceTracker: class {},
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { list: mockStoreList },
  sharedLifecycle: { tryPromote: vi.fn(() => null), runDecayCycle: mockRunDecayCycle },
}));

vi.mock('../../knowledge/knowledge-sync.service.js', () => ({
  knowledgeSync: { runSyncCycle: mockRunSyncCycle },
}));

vi.mock('../triage/triage.service.js', () => ({
  triageService: { handleAlert: mockHandleAlert },
}));

vi.mock('../monitor/monitor-alerts.js', () => ({
  emitMonitorEvent: mockEmitEvent,
}));

vi.mock('../knowledge/knowledge-curator.service.js', () => ({
  knowledgeCurator: { runDailyMaintenance: mockRunDailyMaintenance },
}));

import {
  systemHealthCheck,
  systemTriageCheck,
  checkKnowledgeHealth,
  runCircuitCheckAndRepair,
  gcStaleWorktrees,
  knowledgeMaintenanceEnabled,
} from '../monitor/monitor-system-probes.js';

const DF_OK = '/dev/sda1 100G 50G 50G 50% /';
const DF_FULL = '/dev/sda1 100G 95G 5G 95% /';

function stubExecSync(dfOutput: string) {
  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd.includes('df -h')) return dfOutput;
    if (cmd.includes('free -m')) return 'Mem: 16000 8000 8000';
    if (cmd.includes('ps aux')) return '0';
    if (cmd.includes('npx harness')) return '{}';
    return '';
  });
}

beforeAll(() => {
  // systemHealthCheck 存储探测会真实写 ~/.studio/data/_monitor_probe
  fs.mkdirSync(path.join(require('os').homedir(), '.studio', 'data'), { recursive: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadavg.mockReturnValue([0, 0, 0]);
  mockCpus.mockReturnValue(Array(2).fill({ model: 'test' }));
  stubExecSync(DF_OK);
});

describe('systemHealthCheck', () => {
  it('returns no CPU anomaly when load is normal', async () => {
    mockLoadavg.mockReturnValue([1.0, 0.8, 0.5]);
    const anomalies = await systemHealthCheck();
    expect(anomalies.filter(a => a.message?.includes('CPU'))).toHaveLength(0);
  });

  it('returns warning when load > cores×2 and critical when > cores×4', async () => {
    mockLoadavg.mockReturnValue([5.0, 3.0, 2.0]); // 2 cores → warn threshold 4
    let anomalies = await systemHealthCheck();
    let cpu = anomalies.filter(a => a.message?.includes('CPU'));
    expect(cpu).toHaveLength(1);
    expect(cpu[0]).toMatchObject({ type: 'resource_critical', severity: 'warning' });

    mockLoadavg.mockReturnValue([9.0, 5.0, 3.0]); // 2 cores → crit threshold 8
    anomalies = await systemHealthCheck();
    cpu = anomalies.filter(a => a.message?.includes('CPU'));
    expect(cpu).toHaveLength(1);
    expect(cpu[0].severity).toBe('critical');
  });

  it('flags disk usage > 90% as resource_critical warning', async () => {
    stubExecSync(DF_FULL);
    const anomalies = await systemHealthCheck();
    const disk = anomalies.filter(a => a.message?.includes('Disk usage'));
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({ type: 'resource_critical', severity: 'warning' });
    expect(disk[0].message).toContain('95%');
  });
});

describe('systemTriageCheck confirm window', () => {
  it('escalates to Triage only after 3 consecutive confirmations', async () => {
    stubExecSync(DF_FULL); // persistent resource_critical (disk) anomaly
    mockLoadavg.mockReturnValue([0, 0, 0]); // avoid CPU contributing resource_critical

    await systemTriageCheck(); // count 1
    await systemTriageCheck(); // count 2
    expect(mockHandleAlert.mock.calls.filter(c => c[0]?.type === 'resource_critical')).toHaveLength(0);

    await systemTriageCheck(); // count 3 → escalate（确认后计数器即删除）
    expect(mockHandleAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_critical',
      severity: 'warning',
      message: expect.stringContaining('Disk usage'),
    }));
  });

  it('logs "resolved" and does not escalate when anomaly disappears before 3 confirmations', async () => {
    mockLoadavg.mockReturnValue([0, 0, 0]);
    stubExecSync(DF_FULL);
    await systemTriageCheck(); // count 1（未达确认阈值）

    stubExecSync(DF_OK); // anomaly resolved
    await systemTriageCheck();

    expect(mockLogger.info).toHaveBeenCalledWith(
      '[MonitorService] System anomaly resolved',
      expect.objectContaining({ type: 'resource_critical', wasSeen: 1 }),
    );
    expect(mockHandleAlert.mock.calls.filter(c => c[0]?.type === 'resource_critical')).toHaveLength(0);
  });
});

describe('checkKnowledgeHealth', () => {
  it('score < 60 escalates to Triage + emits monitor:alert, and runs daily decay cycle', async () => {
    mockHealthScore.mockReturnValue({ score: 50, details: ['d1'] });
    const state = { lastDecayRun: 0, lastUserModelRun: 0 };

    await checkKnowledgeHealth(state);

    expect(mockHandleAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'knowledge_health_degraded',
      severity: 'warning',
      message: '知识库健康评分: 50/100',
    }));
    expect(mockEmitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'monitor:alert',
      source: 'knowledge_health',
      level: 'warning',
    }));
    // state.lastDecayRun = 0 → 触发 24h 衰减循环 + 用户模型更新
    expect(mockRunDecayCycle).toHaveBeenCalledTimes(1);
    expect(state.lastDecayRun).toBeGreaterThan(0);
    expect(state.lastUserModelRun).toBeGreaterThan(0);
  });

  it('B7: LLM daily maintenance is OFF by default (token burn guard)', async () => {
    delete process.env.STUDIO_KNOWLEDGE_MAINTENANCE;
    const state = { lastDecayRun: 0, lastUserModelRun: 0 };

    await checkKnowledgeHealth(state);

    expect(mockRunDecayCycle).toHaveBeenCalledTimes(1); // 本地衰减照常
    expect(mockRunDailyMaintenance).not.toHaveBeenCalled(); // LLM 维护默认停用
  });

  it('B7: STUDIO_KNOWLEDGE_MAINTENANCE=on re-enables LLM daily maintenance', async () => {
    vi.stubEnv('STUDIO_KNOWLEDGE_MAINTENANCE', 'on');
    const state = { lastDecayRun: 0, lastUserModelRun: 0 };

    await checkKnowledgeHealth(state);

    expect(mockRunDailyMaintenance).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('score ≥ 60 does not escalate; decay cycle skipped when ran < 24h ago', async () => {
    mockHealthScore.mockReturnValue({ score: 90, details: [] });
    const state = { lastDecayRun: Date.now(), lastUserModelRun: Date.now() };

    await checkKnowledgeHealth(state);

    expect(mockHandleAlert).not.toHaveBeenCalled();
    expect(mockEmitEvent).not.toHaveBeenCalled();
    expect(mockRunDecayCycle).not.toHaveBeenCalled();
  });
});

describe('knowledgeMaintenanceEnabled (B7 开关)', () => {
  it('默认关闭；=on 开启；其他值关闭', () => {
    expect(knowledgeMaintenanceEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(knowledgeMaintenanceEnabled({ STUDIO_KNOWLEDGE_MAINTENANCE: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    expect(knowledgeMaintenanceEnabled({ STUDIO_KNOWLEDGE_MAINTENANCE: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(knowledgeMaintenanceEnabled({ STUDIO_KNOWLEDGE_MAINTENANCE: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('runCircuitCheckAndRepair', () => {
  it('warns when KnowledgeSync detects stale/unmonitored scopes', async () => {
    mockRunSyncCycle.mockResolvedValueOnce({
      stale: [{ scope: 'apps/api', changedFiles: 3, stalenessHours: 5 }],
      unmonitored: [{ scope: 'packages/x', reason: 'no watcher' }],
      healed: 1,
    });

    await runCircuitCheckAndRepair();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[MonitorService] KnowledgeSync detected issues',
      expect.objectContaining({ healed: 1 }),
    );
  });

  it('is silent on a clean cycle and tolerates sync failure', async () => {
    await runCircuitCheckAndRepair();
    expect(mockLogger.warn).not.toHaveBeenCalled();

    mockRunSyncCycle.mockRejectedValueOnce(new Error('boom'));
    await expect(runCircuitCheckAndRepair()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith('[MonitorService] KnowledgeSync check failed', expect.anything());
  });
});

describe('gcStaleWorktrees', () => {
  it('removes worktree dirs older than 24h and keeps fresh ones', async () => {
    const oldDir = path.join(tmpWorktrees, 'old-wt');
    const freshDir = path.join(tmpWorktrees, 'fresh-wt');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    const oldSec = (Date.now() - 48 * 3600_000) / 1000;
    fs.utimesSync(oldDir, oldSec, oldSec);

    await gcStaleWorktrees();

    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
    // REPO_DIR 无 .git → 不执行 git worktree prune
    expect(mockExecSync.mock.calls.filter(c => String(c[0]).includes('worktree prune'))).toHaveLength(0);
  });
});
