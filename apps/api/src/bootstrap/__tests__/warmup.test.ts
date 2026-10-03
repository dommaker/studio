/**
 * bootstrap/warmup 测试（P2-a）：冷启动异步任务全部 fire-and-forget 挂载，
 * startWarmupTasks / startPostRoutesWarmup 同步返回不抛错，各任务模块被触达。
 */
import { describe, it, expect, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  verifyConsumptionChain: vi.fn(async () => {}),
  ensureSeedResolutions: vi.fn(async () => {}),
  summarize: vi.fn(),
  rotateStudioEvents: vi.fn(async () => {}),
  rotateStudioLogFiles: vi.fn(async () => {}),
  archiveLegacyStudioLogs: vi.fn(async () => {}),
  archiveChannelMessages: vi.fn(async () => ({ archivedMessages: 0 })),
  fullScan: vi.fn(async () => {}),
  startPeriodicSnapshots: vi.fn(),
  coldStartAll: vi.fn(async () => {}),
  migrateProfileChannelsToMembers: vi.fn(async () => {}),
  ensureLocalWorkspace: vi.fn(async () => {}),
}));

// P2-c：warmup.ts 全部走模块根 barrel 动态 import——mock 目标同步改到 barrel
// （深路径 mock 挡不住 barrel 拉起的兄弟文件炸链，mock 边界模块才能阻断整条真 chain）
vi.mock('../../modules/knowledge/index.js', () => ({
  verifyConsumptionChain: spies.verifyConsumptionChain,
  resolutionService: { ensureSeedResolutions: spies.ensureSeedResolutions },
  ruleScanner: { fullScan: spies.fullScan },
  envSnapper: { startPeriodicSnapshots: spies.startPeriodicSnapshots },
}));
vi.mock('../../modules/agents/index.js', () => ({
  sessionSummaryService: { summarize: spies.summarize },
}));
vi.mock('../../modules/agent-knowledge/index.js', () => ({
  knowledgeCurator: { coldStartAll: spies.coldStartAll },
}));
vi.mock('../../utils/studio-events-rotation.js', () => ({
  rotateStudioEvents: spies.rotateStudioEvents,
}));
vi.mock('../../utils/studio-log-rotation.js', () => ({
  rotateStudioLogFiles: spies.rotateStudioLogFiles,
  archiveLegacyStudioLogs: spies.archiveLegacyStudioLogs,
}));
vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  FileStore: class { archiveChannelMessages = spies.archiveChannelMessages; },
}));
vi.mock('../../modules/channels/index.js', () => ({
  migrateProfileChannelsToMembers: spies.migrateProfileChannelsToMembers,
}));
vi.mock('../../modules/workspaces/index.js', () => ({
  ensureLocalWorkspace: spies.ensureLocalWorkspace,
}));

import { startWarmupTasks, startPostRoutesWarmup } from '../warmup.js';

describe('warmup 冷启动任务挂载', () => {
  it('startWarmupTasks：同步返回，各异步任务被触达（fire-and-forget）', async () => {
    expect(() => startWarmupTasks()).not.toThrow();
    await vi.waitFor(() => expect(spies.verifyConsumptionChain).toHaveBeenCalled());
    await vi.waitFor(() => expect(spies.ensureSeedResolutions).toHaveBeenCalled());
    await vi.waitFor(() => expect(spies.fullScan).toHaveBeenCalled());
    await vi.waitFor(() => expect(spies.startPeriodicSnapshots).toHaveBeenCalled());
    await vi.waitFor(() => expect(spies.coldStartAll).toHaveBeenCalled());
  });

  it('startPostRoutesWarmup：members 迁移 + 本地 workspace 注册被触达', async () => {
    expect(() => startPostRoutesWarmup()).not.toThrow();
    await vi.waitFor(() => expect(spies.migrateProfileChannelsToMembers).toHaveBeenCalled());
    await vi.waitFor(() => expect(spies.ensureLocalWorkspace).toHaveBeenCalled());
  });
});
