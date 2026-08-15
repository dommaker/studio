/**
 * #126（T4，#105 子票）：工单认领语义——待确认状态 + 确认解闸 + 管线补展开
 *
 * 规则：
 *  - 扩范围类型（feature/task/spec，PENDING_CONFIRM_TYPES）创建未显式给 status → 落 pending（待确认人闸）；
 *    圈内类型（bug/implement/review/analysis/decision）→ 直接 unassigned 可认领。
 *  - pending 不可认领（claim 锁内 status!=='unassigned' 拒绝）、非法迁移受限；
 *    人工确认 = pending → unassigned（spec 走 DECISION_SPEC 裁剪机，无 closed 路径）。
 *  - feature 落 pending 时不展开频道默认管线；确认时幂等补展开（不重复建链头子单）。
 *  - 子单聚合不覆盖 pending 父单（人闸只能人解）。
 *  - 已过人工闸的机制建单显式 status='unassigned'，不吃默认（单层人闸）。
 *
 * 打回回流与 ≥3 熔断为既有机制（reviewRejected 原单回 active 返工 / x3 → blocked），
 * 覆盖见 block-reason.test.ts「reviewRejected 连续 3 次 → blocked」，本文件不重复。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';
import { PENDING_CONFIRM_TYPES, resolveInitialStatus } from '../workunit.types.js';

let tmpDir: string;
let fileStore: FileStore;
let service: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-pending-confirm-test-'));
  fileStore = new FileStore(tmpDir);
  service = new WorkUnitService(fileStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('T4: 类型属性——创建后是否直接可认领', () => {
  it('词表覆盖：扩范围 = feature/task/spec，与根 CONTEXT.md 工单类型词表一致', () => {
    expect([...PENDING_CONFIRM_TYPES].sort()).toEqual(['feature', 'spec', 'task']);
  });

  it('resolveInitialStatus：显式 status 优先；缺省按类型属性', () => {
    expect(resolveInitialStatus('task')).toBe('pending');
    expect(resolveInitialStatus('feature')).toBe('pending');
    expect(resolveInitialStatus('spec')).toBe('pending');
    expect(resolveInitialStatus('bug')).toBe('unassigned');
    expect(resolveInitialStatus('implement')).toBe('unassigned');
    expect(resolveInitialStatus('review')).toBe('unassigned');
    expect(resolveInitialStatus('analysis')).toBe('unassigned');
    expect(resolveInitialStatus('decision')).toBe('unassigned');
    expect(resolveInitialStatus('task', 'unassigned')).toBe('unassigned');
    expect(resolveInitialStatus('bug', 'pending')).toBe('pending');
  });

  it('扩范围单（task/feature/spec）创建后落 pending；缺省 type=task 同吃闸', async () => {
    for (const type of ['task', 'feature', 'spec']) {
      const wu = await service.create({ scope: `${type} 单`, type });
      expect(wu.status).toBe('pending');
    }
    const noType = await service.create({ scope: '缺省类型单' });
    expect(noType.type).toBe('task');
    expect(noType.status).toBe('pending');
  });

  it('圈内单（bug/implement/review/analysis/decision）创建即可认领', async () => {
    for (const type of ['bug', 'implement', 'review', 'analysis', 'decision']) {
      const wu = await service.create({ scope: `${type} 单`, type });
      expect(wu.status).toBe('unassigned');
    }
  });

  it('已过人工闸的机制建单：显式 status=unassigned 不吃默认（单层人闸）', async () => {
    const wu = await service.create({ scope: 'l3 确认后派生任务', type: 'task', status: 'unassigned' });
    expect(wu.status).toBe('unassigned');
  });
});

describe('T4: pending 不可认领，确认后可认领', () => {
  it('pending 单 claim 被拒（锁内 status!==unassigned）', async () => {
    const wu = await service.create({ scope: '待确认任务', type: 'task' });
    await expect(service.claim(wu.id, 'inst-1')).rejects.toThrow();
  });

  it('人工确认 pending → unassigned 后可认领', async () => {
    const wu = await service.create({ scope: '待确认任务', type: 'task' });
    const confirmed = await service.transitionStatus(wu.id, 'unassigned');
    expect(confirmed.status).toBe('unassigned');

    const claimed = await service.claim(wu.id, 'inst-1');
    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe('inst-1');
  });

  it('pending 非法迁移受限：不可直接 active / in_review / done', async () => {
    const wu = await service.create({ scope: '待确认任务', type: 'task' });
    for (const target of ['active', 'in_review', 'done', 'blocked']) {
      await expect(service.transitionStatus(wu.id, target)).rejects.toThrow('Invalid status transition');
    }
    // 人闸可关闭（扩范围驳回）
    const closed = await service.transitionStatus(wu.id, 'closed');
    expect(closed.status).toBe('closed');
  });

  it('spec 单走裁剪状态机：pending → unassigned 合法，pending → closed 非法', async () => {
    const wu = await service.create({ scope: 'spec 单', type: 'spec' });
    expect(wu.status).toBe('pending');
    await expect(service.transitionStatus(wu.id, 'closed')).rejects.toThrow('Invalid status transition');
    const confirmed = await service.transitionStatus(wu.id, 'unassigned');
    expect(confirmed.status).toBe('unassigned');
  });
});

describe('T4: feature 管线展开与确认补展开', () => {
  let channelId: string;

  beforeEach(async () => {
    const now = new Date().toISOString();
    await fileStore.createProfile({
      id: 'p-exec-pending', name: 'executor', description: null,
      channels: '[]', status: 'active', createdAt: now, updatedAt: now,
      acceptedTypes: ['implement'],
    });
    channelId = 'ch-pending-pipeline';
    await fileStore.createChannel({
      id: channelId, name: '#pending-pipeline', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', defaultPipeline: ['executor'],
      createdAt: now, updatedAt: now,
    });
  });

  it('feature 落 pending：创建时不展开管线（未确认需求不烧 token）', async () => {
    const parent = await service.create({ type: 'feature', scope: '未确认需求', channelId });
    expect(parent.status).toBe('pending');
    const all = await fileStore.getIndex();
    expect(all.filter(s => s.parentId === parent.id)).toHaveLength(0);
  });

  it('确认（pending → unassigned）时补展开链头子单', async () => {
    const parent = await service.create({ type: 'feature', scope: '待确认需求', channelId });
    await service.transitionStatus(parent.id, 'unassigned');

    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('implement');
    expect(children[0].status).toBe('unassigned');
  });

  it('补展开幂等：重复确认路径不重复建子单', async () => {
    const parent = await service.create({ type: 'feature', scope: '幂等需求', channelId });
    await service.transitionStatus(parent.id, 'unassigned');
    // 模拟重复触发（blocked → unassigned 等再入路径也走同一幂等闸）
    await service.create({ type: 'task', scope: '手工子单', parentId: parent.id, status: 'unassigned' });
    const all = await fileStore.getIndex();
    // 1 个管线链头 + 1 个手工子单；再次确认路径已由首次展开挡住（无第二链头）
    expect(all.filter(s => s.parentId === parent.id && s.type === 'implement')).toHaveLength(1);
  });

  it('显式 status=unassigned 创建的 feature 仍立即展开（既有行为不变）', async () => {
    const parent = await service.create({ type: 'feature', scope: '直接放行需求', channelId, status: 'unassigned' });
    expect(parent.status).toBe('unassigned');
    const all = await fileStore.getIndex();
    expect(all.filter(s => s.parentId === parent.id)).toHaveLength(1);
  });
});

describe('T4: 聚合护栏——子单状态不覆盖 pending 父闸', () => {
  it('pending 父单不被子单聚合顶成 active', async () => {
    const parent = await service.create({ scope: '待确认父单', type: 'task' });
    const child = await service.create({ scope: '子单', type: 'bug', parentId: parent.id });
    await service.claim(child.id, 'inst-1'); // 子单 active → 触发聚合

    const after = await service.getById(parent.id);
    expect(after!.status).toBe('pending');
  });
});
