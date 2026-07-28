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
  service = new RequirementService(fileStore);
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
      svc = new RequirementService(fileStore, { projectExists: exists });
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
    it('returns requirement + workunit summaries (id/title/status/assignee)', async () => {
      const req = await service.create({ title: '链路需求' });
      const wu1 = await workUnitService.create({ scope: '任务一', reqId: req.id, metadata: { title: '实现登录' } });
      const wu2 = await workUnitService.create({ scope: '任务二', reqId: req.id, assigneeId: 'agent-1' });
      await workUnitService.create({ scope: '别的需求任务', reqId: null });

      const chain = await service.getChain(req.id);
      expect(chain).not.toBeNull();
      expect(chain!.requirement.id).toBe(req.id);
      expect(chain!.workunits.length).toBe(2);
      const byId = new Map(chain!.workunits.map(w => [w.id, w]));
      expect(byId.get(wu1.id)).toMatchObject({ title: '实现登录', status: 'unassigned', assigneeId: null });
      expect(byId.get(wu2.id)).toMatchObject({ title: '任务二', status: 'unassigned', assigneeId: 'agent-1' });
    });

    it('returns null for unknown id', async () => {
      expect(await service.getChain('REQ-9999')).toBeNull();
    });
  });

  describe('status roll-up (maybeRollUpToDone)', () => {
    it('marks requirement done when all workunits reach terminal states', async () => {
      const req = await service.create({ title: '汇总需求', status: 'in-progress' });
      const wu1 = await workUnitService.create({ scope: 't1', reqId: req.id });
      const wu2 = await workUnitService.create({ scope: 't2', reqId: req.id });

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
      const wu = await workUnitService.create({ scope: 't', reqId: req.id });

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
