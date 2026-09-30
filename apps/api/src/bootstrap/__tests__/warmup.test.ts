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

vi.mock('../../modules/knowledge/knowledge-singletons.js', () => ({
  verifyConsumptionChain: spies.verifyConsumptionChain,
}));
vi.mock('../../modules/knowledge/resolution.service.js', () => ({
  resolutionService: { ensureSeedResolutions: spies.ensureSeedResolutions },
}));
vi.mock('../../modules/agents/session-summary.service.js', () => ({
  sessionSummaryService: { summarize: spies.summarize },
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
vi.mock('../../modules/knowledge/rule-scanner.js', () => ({
  ruleScanner: { fullScan: spies.fullScan },
}));
vi.mock('../../modules/knowledge/env-snapper.js', () => ({
  envSnapper: { startPeriodicSnapshots: spies.startPeriodicSnapshots },
}));
vi.mock('../../modules/agents/knowledge/knowledge-curator.service.js', () => ({
  knowledgeCurator: { coldStartAll: spies.coldStartAll },
}));
vi.mock('../../modules/channels/migrate-members.js', () => ({
  migrateProfileChannelsToMembers: spies.migrateProfileChannelsToMembers,
}));
vi.mock('../../modules/workspaces/local-workspace.js', () => ({
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
