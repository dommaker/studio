// 2026-07 PMO-flow UX（设计文档 §6-1）：GET /monitoring/agents 聚合扩展
// 覆盖：currentWorkUnit / pmo / channelId 三字段、PMO 归属三链（①ownershipProjectId
// ②reqId→Requirement.projectId（legacy 与 REQ 别名两种）③metadata.pmoProjectId）、
// 归属不到/悬空 WU → null、向后兼容（既有字段不动）。
// 模式同 monitoring.service.test.ts：真实 FileStore（tmpdir）；projects 走 deps.listProjects stub
// （避免碰真实 ~/.studio/projects）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type RuntimeStateData, type WorkUnitSnapshot, type RequirementData } from '@dommaker/studio-shared';
import type { ProjectData } from '../../pmo/project.service.js';
import { MonitoringService } from '../monitoring.service.js';

function project(overrides: Partial<ProjectData>): ProjectData {
  return {
    id: 'proj-x', pmoNumber: 'PMO-0000', title: '占位项目', description: null, requirement: null,
    companyId: null, okrId: null, status: 'active', priority: 'normal', progress: 0,
    gitBranch: null, gitRepo: null, specFilePath: null, requirementsDocId: null,
    startedAt: null, completedAt: null, createdAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z',
    ...overrides,
  };
}

const PROJECTS: ProjectData[] = [
  project({ id: 'proj-1', pmoNumber: 'PMO-0001', title: '项目一' }),
  project({ id: 'proj-2', pmoNumber: 'PMO-0002', title: '项目二' }),
  project({ id: 'proj-3', pmoNumber: 'PMO-0003', title: '项目三' }),
  project({ id: 'proj-alias', pmoNumber: 'PMO-0077', title: '别名项目', reqAlias: 'REQ-0077' }),
];

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

function state(overrides: Partial<RuntimeStateData>): RuntimeStateData {
  return {
    id: 'inst-x', roleId: 'prof-1', sessionId: null, status: 'active',
    currentWorkUnitId: null, startedAt: '2026-07-31T02:00:00Z',
    terminatedAt: null, lastHeartbeat: null, metadata: null,
    ...overrides,
  };
}

describe('MonitoringService.getAgentSummary — 2026-07 聚合扩展', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: MonitoringService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-agents-'));
    fileStore = new FileStore(tmpDir);
    service = new MonitoringService(fileStore, undefined, { listProjects: async () => PROJECTS });
    await fileStore.createProfile({
      id: 'prof-1', name: 'dev-agent', description: null, channels: '[]',
      status: 'active', provider: null,
      createdAt: '2026-07-31T00:00:00Z', updatedAt: '2026-07-31T00:00:00Z',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function addInstance(id: string, wuId: string | null): Promise<void> {
    await fileStore.createState(id, state({
      id,
      status: wuId ? 'active' : 'idle',
      currentWorkUnitId: wuId,
    }));
  }

  it('无 currentWorkUnitId → 三字段全 null，既有字段保持（向后兼容）', async () => {
    await addInstance('inst-idle', null);

    const result = await service.getAgentSummary();
    const agent = result.agents.find(a => a.id === 'inst-idle')!;

    expect(agent.currentWorkUnit).toBeNull();
    expect(agent.pmo).toBeNull();
    expect(agent.channelId).toBeNull();
    // 既有字段原样
    expect(agent.roleId).toBe('prof-1');
    expect(agent.name).toBe('dev-agent');
    expect(agent.status).toBe('idle');
    expect(agent.currentWorkUnitId).toBeNull();
    expect(agent.startedAt).toBe('2026-07-31T02:00:00Z');
    expect(agent.lastError).toBeNull();
    expect(agent.lastErrorAt).toBeNull();
    expect(result.summary.total).toBe(1);
    expect(result.summary.idle).toBe(1);
  });

  it('① metadata.ownershipProjectId 链 → currentWorkUnit + pmo + channelId', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({
      id: 'wu-1',
      metadata: JSON.stringify({ title: '实现登录页', ownershipProjectId: 'proj-1' }),
    }));
    await addInstance('inst-1', 'wu-1');

    const agent = (await service.getAgentSummary()).agents.find(a => a.id === 'inst-1')!;

    expect(agent.currentWorkUnit).toEqual({
      id: 'wu-1',
      title: '实现登录页',
      type: 'task',
      status: 'active',
      claimedAt: '2026-07-31T01:00:00Z',
    });
    expect(agent.pmo).toEqual({ id: 'proj-1', pmoNumber: 'PMO-0001', title: '项目一' });
    expect(agent.channelId).toBe('ch-1');
  });

  it('② reqId → legacy Requirement.projectId 链（fileStore requirements 记录）', async () => {
    await fileStore.createRequirement({
      id: 'REQ-0042', seq: 42, title: '需求四十二', status: 'open',
      createdAt: '2026-07-31T00:00:00Z', createdBy: 'test', projectId: 'proj-2',
    } as RequirementData);
    await fileStore.upsertSnapshot(wuSnapshot({ id: 'wu-2', reqId: 'REQ-0042' }));
    await addInstance('inst-2', 'wu-2');

    const agent = (await service.getAgentSummary()).agents.find(a => a.id === 'inst-2')!;

    expect(agent.pmo).toEqual({ id: 'proj-2', pmoNumber: 'PMO-0002', title: '项目二' });
  });

  it('② reqId → REQ 别名链（统一编号 PMO，别名视图 projectId = PMO 自身 id）', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({ id: 'wu-alias', reqId: 'REQ-0077' }));
    await addInstance('inst-alias', 'wu-alias');

    const agent = (await service.getAgentSummary()).agents.find(a => a.id === 'inst-alias')!;

    expect(agent.pmo).toEqual({ id: 'proj-alias', pmoNumber: 'PMO-0077', title: '别名项目' });
  });

  it('③ metadata.pmoProjectId 链（①② 均缺失时回落）', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({
      id: 'wu-3',
      metadata: JSON.stringify({ title: '修复样式', pmoProjectId: 'proj-3' }),
    }));
    await addInstance('inst-3', 'wu-3');

    const agent = (await service.getAgentSummary()).agents.find(a => a.id === 'inst-3')!;

    expect(agent.pmo).toEqual({ id: 'proj-3', pmoNumber: 'PMO-0003', title: '项目三' });
  });

  it('metadata.title 缺失/损坏 → title 回落 scope', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({ id: 'wu-5', scope: '原始 scope 文本', metadata: '{}' }));
    await fileStore.upsertSnapshot(wuSnapshot({ id: 'wu-6', scope: '损坏 metadata', metadata: '{broken' }));
    await addInstance('inst-5', 'wu-5');
    await addInstance('inst-6', 'wu-6');

    const agents = (await service.getAgentSummary()).agents;

    expect(agents.find(a => a.id === 'inst-5')!.currentWorkUnit?.title).toBe('原始 scope 文本');
    expect(agents.find(a => a.id === 'inst-6')!.currentWorkUnit?.title).toBe('损坏 metadata');
  });

  it('归属链全落空 / 项目不存在 → pmo 为 null；WU 悬空 → currentWorkUnit 为 null', async () => {
    // ownershipProjectId 指向不存在的项目，reqId 无记录，pmoProjectId 不存在 → null
    await fileStore.upsertSnapshot(wuSnapshot({
      id: 'wu-4',
      reqId: 'REQ-9999',
      metadata: JSON.stringify({ ownershipProjectId: 'ghost', pmoProjectId: 'ghost-2' }),
    }));
    await addInstance('inst-4', 'wu-4');
    // currentWorkUnitId 悬空（index 中无此 WU）
    await addInstance('inst-ghost', 'wu-ghost');

    const agents = (await service.getAgentSummary()).agents;
    const unowned = agents.find(a => a.id === 'inst-4')!;
    const dangling = agents.find(a => a.id === 'inst-ghost')!;

    expect(unowned.pmo).toBeNull();
    expect(unowned.currentWorkUnit).not.toBeNull(); // WU 存在，仅归属不到
    expect(unowned.channelId).toBe('ch-1');

    expect(dangling.currentWorkUnit).toBeNull();
    expect(dangling.pmo).toBeNull();
    expect(dangling.channelId).toBeNull();
    expect(dangling.currentWorkUnitId).toBe('wu-ghost'); // 裸 id 字段保持原样
  });

  it('多 agent 共享数据源：WU/requirement/project 各读一次后内存匹配', async () => {
    await fileStore.upsertSnapshot(wuSnapshot({
      id: 'wu-shared',
      metadata: JSON.stringify({ title: '共享任务', ownershipProjectId: 'proj-1' }),
    }));
    await addInstance('inst-a', 'wu-shared');
    await addInstance('inst-b', 'wu-shared');

    let listProjectsCalls = 0;
    const counting = new MonitoringService(fileStore, undefined, {
      listProjects: async () => {
        listProjectsCalls++;
        return PROJECTS;
      },
    });

    const result = await counting.getAgentSummary();

    expect(result.agents).toHaveLength(2);
    for (const agent of result.agents) {
      expect(agent.currentWorkUnit?.id).toBe('wu-shared');
      expect(agent.pmo?.id).toBe('proj-1');
    }
    expect(listProjectsCalls).toBe(1);
  });
});
