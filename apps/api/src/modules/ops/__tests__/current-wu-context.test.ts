// #318：current-wu-context（自 monitoring.service 提取的共享 helper）直测——
// getAgentSummary 与 agent.instance.status_changed 负载（agent-loop）共用同一 WU 聚合上下文出口，
// 防两处拷贝契约漂移（pmo 归属链：①metadata.pmoId ②reqId→Requirement.projectId‖REQ 别名）。
// 模式同 monitoring-agents-summary.test.ts：真实 FileStore（tmpdir）；projects 走注入 stub。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import type { ProjectData } from '../../pmo/project.service.js';
import { loadCurrentWuContexts } from '../current-wu-context.js';

function project(overrides: Partial<ProjectData>): ProjectData {
  return {
    id: 'proj-x', pmoNumber: 'PMO-0000', title: '占位项目', description: null, requirement: null,
    companyId: null, okrId: null, status: 'active', priority: 'normal', progress: 0,
    gitBranch: null, gitRepo: null, specFilePath: null, requirementsDocId: null,
    startedAt: null, completedAt: null, createdAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z',
    ...overrides,
  };
}

const PROJECTS: ProjectData[] = [project({ id: 'proj-1', pmoNumber: 'PMO-0001', title: '项目一' })];

function wuSnapshot(overrides: Partial<WorkUnitSnapshot>): WorkUnitSnapshot {
  return {
    id: 'wu-x', parentId: null, type: 'task', scope: '默认 scope',
    assigneeId: 'inst-x', status: 'active', failureType: null, retryCount: 0,
    timeoutAt: null, channelId: 'ch-1', projectPath: null, metadata: null,
    createdAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z',
    claimedAt: '2026-07-31T01:00:00Z', completedAt: null,
    ...overrides,
  };
}

describe('loadCurrentWuContexts — 共享 WU 聚合上下文（#318 提取）', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-ctx-'));
    fileStore = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('metadata.pmoId 链 → currentWorkUnit + pmo + channelId 全量', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({
      id: 'wu-1', metadata: JSON.stringify({ title: '实现登录页', pmoId: 'proj-1' }),
    }));

    const ctxs = await loadCurrentWuContexts(fileStore, ['wu-1'], async () => PROJECTS);

    const ctx = ctxs.get('wu-1')!;
    expect(ctx.currentWorkUnit).toEqual({
      id: 'wu-1', title: '实现登录页', type: 'task', status: 'active', claimedAt: '2026-07-31T01:00:00Z',
    });
    expect(ctx.pmo).toEqual({ id: 'proj-1', pmoNumber: 'PMO-0001', title: '项目一' });
    expect(ctx.channelId).toBe('ch-1');
  });

  it('无归属（无 pmoId/reqId）→ pmo null，currentWorkUnit 仍在', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({ id: 'wu-2' }));

    const ctxs = await loadCurrentWuContexts(fileStore, ['wu-2'], async () => PROJECTS);

    expect(ctxs.get('wu-2')!.pmo).toBeNull();
    expect(ctxs.get('wu-2')!.currentWorkUnit.id).toBe('wu-2');
  });

  it('悬空 wuId（index 不存在）→ 无 map 项', async () => {
    const ctxs = await loadCurrentWuContexts(fileStore, ['wu-ghost'], async () => PROJECTS);
    expect(ctxs.size).toBe(0);
  });
});
