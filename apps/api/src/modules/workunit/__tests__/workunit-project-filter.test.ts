// #456：WU 列表 projectId 服务端过滤（ProjectDetailPage next-action 候选消
// 「拉全系统 unassigned 池再客户端过滤」）。归属口径与 PMO 台账唯一同源
// （pmo/evidence-summary.selectProjectSnapshots：reqId 绑定优先 → pmoId 归因戳兜底）。
// 计数能力复用分页响应 total（#428 先例），不单开 count 端点。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';
import { RequirementService } from '../../requirements/requirement.service.js';
import { projectService, type ProjectData } from '../../pmo/project.service.js';

describe('WorkUnitService.list projectId 过滤（#456）', () => {
  let tmpDir: string;
  let service: WorkUnitService;
  let projectA: ProjectData;
  let projectB: ProjectData;

  let wuReqAId: string;        // reqId 绑定 → A
  let wuStampAId: string;      // pmoId 戳 → A
  let wuReqBStampAId: string;  // reqId 绑 B 但戳是 A → reqId 优先归 B
  let wuStampBId: string;      // pmoId 戳 → B
  let wuOrphanId: string;      // 无归属

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-project-filter-test-'));
    const fileStore = new FileStore(tmpDir);
    service = new WorkUnitService(fileStore);
    const reqService = new RequirementService(fileStore);

    projectA = await projectService.create({ title: `p456-a-${Date.now()}` });
    projectB = await projectService.create({ title: `p456-b-${Date.now()}` });
    const reqA = await reqService.create({ title: 'req-a', projectId: projectA.id });
    const reqB = await reqService.create({ title: 'req-b', projectId: projectB.id });

    wuReqAId = (await service.create({ scope: 'req bound A', reqId: reqA.id })).id;
    wuStampAId = (await service.create({ scope: 'stamp A', metadata: { pmoId: projectA.id } })).id;
    wuReqBStampAId = (await service.create({ scope: 'req B stamp A', reqId: reqB.id, metadata: { pmoId: projectA.id } })).id;
    wuStampBId = (await service.create({ scope: 'stamp B done', status: 'done', metadata: { pmoId: projectB.id } })).id;
    wuOrphanId = (await service.create({ scope: 'orphan' })).id;
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const p of [projectA, projectB]) {
      await projectService.update(p.id, { status: 'pending' }).catch(() => {});
      await projectService.delete(p.id).catch(() => { /* 忽略 */ });
    }
  });

  it('projectId 过滤：reqId 绑定与 pmoId 戳归属都命中', async () => {
    const result = await service.list({ projectId: projectA.id });
    const ids = result.data.map(w => w.id);

    expect(ids).toContain(wuReqAId);
    expect(ids).toContain(wuStampAId);
    expect(ids).not.toContain(wuStampBId);
    expect(ids).not.toContain(wuOrphanId);
    expect(result.total).toBe(2);
  });

  it('reqId 绑定优先于 pmoId 戳（口径同 PMO 台账，不双计）', async () => {
    const inA = (await service.list({ projectId: projectA.id })).data.map(w => w.id);
    const inB = (await service.list({ projectId: projectB.id })).data.map(w => w.id);

    expect(inA).not.toContain(wuReqBStampAId);
    expect(inB).toContain(wuReqBStampAId);
  });

  it('与 status 过滤组合（交集语义）；total 为过滤后计数', async () => {
    const result = await service.list({ projectId: projectB.id, status: 'done' });
    const ids = result.data.map(w => w.id);

    expect(ids).toEqual([wuStampBId]);
    expect(result.total).toBe(1);
  });

  it('不传 projectId 时行为不变（全量，不过滤）', async () => {
    const result = await service.list({});
    const ids = result.data.map(w => w.id);

    for (const id of [wuReqAId, wuStampAId, wuReqBStampAId, wuStampBId, wuOrphanId]) {
      expect(ids).toContain(id);
    }
  });
});
