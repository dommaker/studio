/**
 * RequirementService 单元测试（vision §5.3）
 *
 * 覆盖：create（seq/id 分配 + requirement.created 事件）、createFromDispatch
 * （标题截断/in-progress/channelId）、get/list/update/addDoc
 * （requirement.updated 事件）、getChain 形状、maybeRollUpToDone 汇总、
 * initRequirementRollup 事件订阅（workunit.status_changed → done）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import { RequirementService, deriveTitle, TERMINAL_WORKUNIT_STATUSES } from '../requirement.service.js';
import { initRequirementRollup } from '../rollup.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let service: RequirementService;
let workUnitService: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-service-test-'));
  fileStore = new FileStore(tmpDir);
  // 中性化 PMO 依赖（默认实现会读真实 ~/.studio/projects，并行测试下被 routes 测试的真实项目串扰）
  service = new RequirementService(fileStore, {
    getProjectByAlias: async () => null,
    findChoreProject: async () => null,
    listAliasProjects: async () => [],
    getProjectByPmoNumber: async () => null,
  });
  workUnitService = new WorkUnitService(fileStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 轮询直至条件满足（事件订阅是 fire-and-forget，需要给异步汇总留时间窗） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

describe('RequirementService (vision §5.3)', () => {
  describe('create', () => {
    it('assigns REQ-<seq> ids sequentially', async () => {
      const r1 = await service.create({ title: '第一个需求' });
      const r2 = await service.create({ title: '第二个需求' });

      expect(r1.id).toBe('REQ-0001');
      expect(r1.seq).toBe(1);
      expect(r1.status).toBe('open');
      expect(r1.createdBy).toBe('manual');
      expect(r2.id).toBe('REQ-0002');
    });

    it('allocates unique ids under concurrent creates', async () => {
      const reqs = await Promise.all(
        Array.from({ length: 8 }, (_, i) => service.create({ title: `需求 ${i}` })),
      );
      const ids = reqs.map(r => r.id);
      expect(new Set(ids).size).toBe(8);
      const seqs = reqs.map(r => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('publishes requirement.created', async () => {
      const events: Array<{ requirement: { id: string } }> = [];
      const handler = (p: { requirement: { id: string } }) => events.push(p);
      eventBus.subscribe('requirement.created', handler);
      try {
        const req = await service.create({ title: '事件需求' });
        expect(events.length).toBe(1);
        expect(events[0].requirement.id).toBe(req.id);
      } finally {
        eventBus.unsubscribe('requirement.created', handler);
      }
    });
  });

  describe('createFromDispatch', () => {
    it('derives title from first ~80 chars, status in-progress, channelId set', async () => {
      const longMessage = `@agent ${'实现用户登录功能，包含 OAuth 与密码两种方式。'.repeat(6)}`;
      const req = await service.createFromDispatch(longMessage, 'ch-1', 'mention');

      expect(req.status).toBe('in-progress');
      expect(req.channelId).toBe('ch-1');
      expect(req.createdBy).toBe('mention');
      expect(req.title.length).toBeLessThanOrEqual(80);
      expect(longMessage.replace(/\s+/g, ' ').trim().startsWith(req.title)).toBe(true);
    });

    it('deriveTitle collapses whitespace and trims', () => {
      expect(deriveTitle('  hello\n\nworld  ')).toBe('hello world');
      expect(deriveTitle('短消息')).toBe('短消息');
    });
  });

  describe('get / list / update / addDoc', () => {
    it('get returns null for unknown id', async () => {
      expect(await service.get('REQ-9999')).toBeNull();
    });

    it('lists with status/channelId filters', async () => {
      await service.create({ title: 'A', channelId: 'ch-1', status: 'in-progress' });
      await service.create({ title: 'B', channelId: 'ch-2' });

      expect((await service.list()).length).toBe(2);
      expect((await service.list({ status: 'in-progress' })).map(r => r.title)).toEqual(['A']);
      expect((await service.list({ channelId: 'ch-2' })).map(r => r.title)).toEqual(['B']);
    });

    it('updates status/title/docs and publishes requirement.updated', async () => {
      const req = await service.create({ title: '旧标题' });
      const events: Array<{ requirement: { id: string; status: string } }> = [];
      const handler = (p: { requirement: { id: string; status: string } }) => events.push(p);
      eventBus.subscribe('requirement.updated', handler);
      try {
        const updated = await service.update(req.id, { status: 'done', title: '新标题', docs: ['a.md'] });
        expect(updated.status).toBe('done');
        expect(updated.title).toBe('新标题');
        expect(updated.docs).toEqual(['a.md']);
        expect(events.length).toBe(1);
        expect(events[0].requirement.status).toBe('done');
      } finally {
        eventBus.unsubscribe('requirement.updated', handler);
      }
    });

    it('update throws for unknown id', async () => {
      await expect(service.update('REQ-9999', { status: 'done' })).rejects.toThrow('not found');
    });

    it('addDoc appends unique doc paths', async () => {
      const req = await service.create({ title: '文档需求' });
      await service.addDoc(req.id, 'docs/req.md');
      const after = await service.addDoc(req.id, 'docs/req.md');

      expect(after.docs).toEqual(['docs/req.md']);
      const again = await service.addDoc(req.id, 'docs/sdd.md');
      expect(again.docs).toEqual(['docs/req.md', 'docs/sdd.md']);
    });
  });

  describe('B3a: projectId 挂接（决策 D2）', () => {
    // projectExists stub：只认 'proj-ok'，不碰真实 ~/.studio/projects
    const exists = async (id: string) => id === 'proj-ok';
    let svc: RequirementService;

    beforeEach(() => {
      svc = new RequirementService(fileStore, {
        projectExists: exists,
        getProjectByAlias: async () => null,
        findChoreProject: async () => null,
        listAliasProjects: async () => [],
        getProjectByPmoNumber: async () => null,
      });
    });

    it('create 带 projectId → 落档；不带 → null', async () => {
      const linked = await svc.create({ title: '挂项目', projectId: 'proj-ok' });
      expect(linked.projectId).toBe('proj-ok');
      expect((await svc.get(linked.id))!.projectId).toBe('proj-ok');

      const plain = await svc.create({ title: '不挂项目' });
      expect(plain.projectId).toBeNull();
    });

    it('create 带不存在的 projectId → 抛错且不落档', async () => {
      await expect(svc.create({ title: '挂空项目', projectId: 'proj-gone' }))
        .rejects.toThrow('Project not found: proj-gone');
      expect((await svc.list()).length).toBe(0);
    });

    it('update 挂接 / 更换 / 清除（null）projectId', async () => {
      const req = await svc.create({ title: '需求' });

      const linked = await svc.update(req.id, { projectId: 'proj-ok' });
      expect(linked.projectId).toBe('proj-ok');

      const cleared = await svc.update(req.id, { projectId: null });
      expect(cleared.projectId).toBeNull();
      expect((await svc.get(req.id))!.projectId).toBeNull();
    });

    it('update 带不存在的 projectId → 抛错且原值不变', async () => {
      const req = await svc.create({ title: '需求', projectId: 'proj-ok' });

      await expect(svc.update(req.id, { projectId: 'proj-gone' }))
        .rejects.toThrow('Project not found: proj-gone');
      expect((await svc.get(req.id))!.projectId).toBe('proj-ok');
    });

    it('projectId 缺省校验走真实 projectService（默认 deps）', async () => {
      // 默认 projectExists 查真实 ~/.studio/projects —— 不存在的 id 一律抛错
      await expect(service.create({ title: '需求', projectId: 'proj-definitely-not-exists-b3a' }))
        .rejects.toThrow('Project not found');
    });
  });

  describe('getChain', () => {
    it('returns requirement + workunit summaries (id/title/status/assignee + type/时间戳)', async () => {
      const req = await service.create({ title: '链路需求' });
      const wu1 = await workUnitService.create({ scope: '任务一', reqId: req.id, status: 'unassigned', metadata: { title: '实现登录' } });
      const wu2 = await workUnitService.create({ scope: '任务二', reqId: req.id, status: 'unassigned', assigneeId: 'agent-1' });
      await workUnitService.create({ scope: '别的需求任务', reqId: null });
      // 认领 wu1 → claimedAt 落档（completedAt 仍为 null）
      await workUnitService.claim(wu1.id, 'inst-1');

      const chain = await service.getChain(req.id);
      expect(chain).not.toBeNull();
      expect(chain!.requirement.id).toBe(req.id);
      expect(chain!.workunits.length).toBe(2);
      const byId = new Map(chain!.workunits.map(w => [w.id, w]));
      expect(byId.get(wu1.id)).toMatchObject({ title: '实现登录', status: 'active', assigneeId: 'inst-1' });
      expect(byId.get(wu2.id)).toMatchObject({ title: '任务二', status: 'unassigned', assigneeId: 'agent-1' });
      // 2026-07-31 PMO-flow UX §10：chain 条目自带 type/createdAt/claimedAt/completedAt（前端免 N+1 补全）
      const c1 = byId.get(wu1.id)!;
      expect(c1.type).toBe('task');
      expect(Number.isNaN(Date.parse(c1.createdAt))).toBe(false);
      expect(c1.claimedAt).not.toBeNull();
      expect(c1.completedAt).toBeNull();
      const c2 = byId.get(wu2.id)!;
      expect(c2.type).toBe('task');
      expect(c2.claimedAt).toBeNull();
    });

    it('returns null for unknown id', async () => {
      expect(await service.getChain('REQ-9999')).toBeNull();
    });
  });

  describe('status roll-up (maybeRollUpToDone)', () => {
    it('marks requirement done when all workunits reach terminal states', async () => {
      const req = await service.create({ title: '汇总需求', status: 'in-progress' });
      const wu1 = await workUnitService.create({ scope: 't1', reqId: req.id, status: 'unassigned' });
      const wu2 = await workUnitService.create({ scope: 't2', reqId: req.id, status: 'unassigned' });

      // 未到终态 → 不汇总
      expect(await service.maybeRollUpToDone(req.id)).toBe(false);
      expect((await service.get(req.id))!.status).toBe('in-progress');

      // wu1: unassigned → active → in_review（in_review 视为终态）
      await workUnitService.transitionStatus(wu1.id, 'active');
      await workUnitService.transitionStatus(wu1.id, 'in_review');
      expect(await service.maybeRollUpToDone(req.id)).toBe(false);

      // wu2: unassigned → active → done（全部终态 → 汇总）
      await workUnitService.transitionStatus(wu2.id, 'active');
      await workUnitService.transitionStatus(wu2.id, 'in_review');
      await workUnitService.reviewPassed(wu2.id);

      expect(await service.maybeRollUpToDone(req.id)).toBe(true);
      expect((await service.get(req.id))!.status).toBe('done');

      // 幂等：再次调用返回 false
      expect(await service.maybeRollUpToDone(req.id)).toBe(false);
    });

    it('treats closed as terminal', async () => {
      const req = await service.create({ title: '关闭需求' });
      const wu = await workUnitService.create({ scope: 't', reqId: req.id });
      await workUnitService.transitionStatus(wu.id, 'closed');

      expect(await service.maybeRollUpToDone(req.id)).toBe(true);
      expect((await service.get(req.id))!.status).toBe('done');
    });

    it('does nothing with no workunits / archived requirement / unknown id', async () => {
      const empty = await service.create({ title: '空需求' });
      expect(await service.maybeRollUpToDone(empty.id)).toBe(false);

      const archived = await service.create({ title: '归档需求', status: 'archived' });
      const wu = await workUnitService.create({ scope: 't', reqId: archived.id });
      await workUnitService.transitionStatus(wu.id, 'closed');
      expect(await service.maybeRollUpToDone(archived.id)).toBe(false);
      expect((await service.get(archived.id))!.status).toBe('archived');

      expect(await service.maybeRollUpToDone('REQ-9999')).toBe(false);
    });

    it('terminal status set covers expected values', () => {
      expect(TERMINAL_WORKUNIT_STATUSES).toEqual(
        expect.arrayContaining(['in_review', 'done', 'completed', 'failed', 'closed']),
      );
    });
  });

  describe('initRequirementRollup (event subscription)', () => {
    it('rolls up to done on workunit.status_changed', async () => {
      const req = await service.create({ title: '事件汇总', status: 'in-progress' });
      const wu = await workUnitService.create({ scope: 't', reqId: req.id, status: 'unassigned' });

      const unsubscribe = initRequirementRollup(service);
      try {
        await workUnitService.transitionStatus(wu.id, 'active');
        // active 非终态 → 仍 in-progress
        expect((await service.get(req.id))!.status).toBe('in-progress');

        await workUnitService.transitionStatus(wu.id, 'closed');
        const rolledUp = await waitFor(async () => (await service.get(req.id))!.status === 'done');
        expect(rolledUp).toBe(true);
      } finally {
        unsubscribe();
      }
    });

    it('ignores workunits without reqId', async () => {
      const unsubscribe = initRequirementRollup(service);
      try {
        const wu = await workUnitService.create({ scope: 'no req' });
        await workUnitService.transitionStatus(wu.id, 'closed');
        // 无 reqId — 不崩溃、无汇总
        expect((await service.list()).length).toBe(0);
      } finally {
        unsubscribe();
      }
    });
  });
});

/**
 * PMO-a 别名层（2026-07-28 分析文档，决策 4/2）
 * get/list 别名感知、createFromDispatch 杂务归集、update/maybeRollUpToDone 别名只读。
 * 全部经 stub 依赖注入，不碰真实 ~/.studio/projects。
 */
describe('PMO-a：REQ → PMO 只读别名层（决策 4/2）', () => {
  const aliasProject = {
    id: 'proj_chore1',
    pmoNumber: 'PMO-11',
    title: '杂务 · #rnd',
    description: '频道杂务 PMO',
    requirement: null,
    companyId: null,
    okrId: null,
    status: 'active',
    priority: 'normal',
    progress: 0,
    gitBranch: 'PMO-11',
    gitRepo: '/repo/x',
    specFilePath: null,
    requirementsDocId: 'doc-1',
    startedAt: null,
    completedAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    reqAlias: 'REQ-0011',
    deliveryPolicy: 'branch-only' as const,
    isChore: true,
    channelId: 'ch-rnd',
  };

  function aliasService() {
    return new RequirementService(fileStore, {
      projectExists: async () => true,
      getProjectByAlias: async id => (id === 'REQ-0011' ? aliasProject : null),
      findChoreProject: async cid => (cid === 'ch-rnd' ? aliasProject : null),
      listAliasProjects: async () => [aliasProject],
    });
  }

  it('get：别名命中 → 投影为 REQ 视图（状态映射 + projectId=PMO id + docs 来自 requirementsDocId）', async () => {
    const svc = aliasService();
    const view = await svc.get('REQ-0011');
    expect(view).not.toBeNull();
    expect(view!.id).toBe('REQ-0011');
    expect(view!.seq).toBe(11);
    expect(view!.status).toBe('in-progress'); // active → in-progress
    expect(view!.projectId).toBe('proj_chore1');
    expect(view!.docs).toEqual(['doc-1']);
    expect(view!.createdBy).toBe('pmo-alias');
  });

  it('get：别名未命中 → 回落 legacy 记录', async () => {
    const svc = aliasService();
    const legacy = await svc.create({ title: '老需求' });
    expect((await svc.get(legacy.id))!.title).toBe('老需求');
  });

  it('list：legacy + 别名视图合并去重（别名优先）', async () => {
    const svc = aliasService();
    await svc.create({ title: '老需求' });
    const all = await svc.list();
    expect(all.map(r => r.id).sort()).toEqual(['REQ-0001', 'REQ-0011']);
    // channelId 过滤同样作用于别名视图
    const filtered = await svc.list({ channelId: 'ch-rnd' });
    expect(filtered.map(r => r.id)).toEqual(['REQ-0011']);
  });

  it('createFromDispatch：频道已登记杂务 PMO → 小活归集到杂务别名（不新建对象）', async () => {
    const svc = aliasService();
    const req = await svc.createFromDispatch('帮我改个错别字', 'ch-rnd', 'mention');
    expect(req.id).toBe('REQ-0011');
    // legacy 存储里没有新建
    expect((await svc.list()).filter(r => r.createdBy !== 'pmo-alias').length).toBe(0);
  });

  it('createFromDispatch：未登记杂务 PMO → legacy 自动新建', async () => {
    const svc = new RequirementService(fileStore, {
      findChoreProject: async () => null,
      getProjectByAlias: async () => null,
      listAliasProjects: async () => [],
    });
    const req = await svc.createFromDispatch('全新任务', 'ch-x', 'mention');
    expect(req.id).toMatch(/^REQ-\d{4}$/);
    expect(req.createdBy).toBe('mention');
  });

  it('update：别名视图只读 → 抛错；legacy 正常更新', async () => {
    const svc = aliasService();
    await expect(svc.update('REQ-0011', { title: '改名' })).rejects.toThrow('read-only PMO alias');
    const legacy = await svc.create({ title: '老需求' });
    await svc.update(legacy.id, { title: '改名成功' });
    expect((await svc.get(legacy.id))!.title).toBe('改名成功');
  });

  it('maybeRollUpToDone：别名视图跳过（PMO 状态由 progress-rollup 拥有）', async () => {
    const svc = aliasService();
    const wu = await workUnitService.create({ scope: '杂活', reqId: 'REQ-0011', status: 'unassigned' });
    await workUnitService.claim(wu.id, 'inst-1');
    await workUnitService.transitionStatus(wu.id, 'in_review');
    await workUnitService.transitionStatus(wu.id, 'done');
    expect(await svc.maybeRollUpToDone('REQ-0011')).toBe(false);
  });

  it('getChain：别名视图也可出链路（WU 挂别名 reqId）', async () => {
    const svc = aliasService();
    await workUnitService.create({ scope: '杂活一', reqId: 'REQ-0011' });
    const chain = await svc.getChain('REQ-0011');
    expect(chain).not.toBeNull();
    expect(chain!.requirement.id).toBe('REQ-0011');
    expect(chain!.workunits.length).toBe(1);
  });
});
