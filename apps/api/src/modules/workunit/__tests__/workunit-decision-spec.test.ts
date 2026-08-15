// #108（T2，#106 子票）：decision/spec 裁剪状态机单测
// 裁剪机：unassigned → active ⇄ blocked（waitingForInput 挂起）→ in_review → done
// 无 closed（决策单可能等关键人多天，不进死信/超时关闭路径）；其余 type 仍走全局表
// 约定与 workunit-timeout.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workunit-decision-spec-test-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.each(['decision', 'spec'])('#108: %s 单裁剪状态机', (type) => {
  async function createWu() {
    // #126：spec 未显式 status 默认落 pending（待确认门）；本组用例测裁剪状态机主链，显式置 unassigned
    return wuService.create({ scope: `${type} 单`, type, status: 'unassigned' });
  }

  it('合法主链：unassigned → active → in_review → done', async () => {
    const wu = await createWu();
    expect(wu.status).toBe('unassigned');
    await wuService.transitionStatus(wu.id, 'active');
    await wuService.transitionStatus(wu.id, 'in_review');
    const done = await wuService.transitionStatus(wu.id, 'done');
    expect(done.status).toBe('done');
  });

  it('合法挂起往返：active ⇄ blocked（waitingForInput 挂起 = blocked + metadata.waitingForInput）', async () => {
    const wu = await createWu();
    await wuService.transitionStatus(wu.id, 'active');
    const blocked = await wuService.transitionStatus(wu.id, 'blocked');
    expect(blocked.status).toBe('blocked');
    const resumed = await wuService.transitionStatus(wu.id, 'active');
    expect(resumed.status).toBe('active');
    // 挂起恢复后仍可走完收口
    await wuService.transitionStatus(wu.id, 'in_review');
    await wuService.transitionStatus(wu.id, 'done');
  });

  it('合法打回：in_review → active（人工不通过返工，reviewRejected 同路径）', async () => {
    const wu = await createWu();
    await wuService.transitionStatus(wu.id, 'active');
    await wuService.transitionStatus(wu.id, 'in_review');
    const back = await wuService.transitionStatus(wu.id, 'active');
    expect(back.status).toBe('active');
  });

  it.each([
    ['unassigned', 'in_review'],
    ['unassigned', 'closed'],
    ['unassigned', 'done'],
    ['active', 'closed'],
    ['active', 'unassigned'],
    ['blocked', 'in_review'],
    ['blocked', 'closed'],
    ['in_review', 'blocked'],
    ['in_review', 'closed'],
    ['done', 'closed'],
    ['done', 'active'],
  ])('非法迁移：%s → %s 抛错', async (from, to) => {
    const wu = await createWu();
    // 把 WU 推到 from 状态（全部走合法路径）
    if (from !== 'unassigned') await wuService.transitionStatus(wu.id, 'active');
    if (from === 'blocked') await wuService.transitionStatus(wu.id, 'blocked');
    if (from === 'in_review' || from === 'done') await wuService.transitionStatus(wu.id, 'in_review');
    if (from === 'done') await wuService.transitionStatus(wu.id, 'done');

    await expect(wuService.transitionStatus(wu.id, to)).rejects.toThrow(
      `Invalid status transition: ${from} → ${to}`
    );
  });
});

describe('#108: 全局状态机回归（非 decision/spec 不受影响）', () => {
  it('task 仍允许 unassigned → closed 与 done → closed', async () => {
    // #126：task 未显式 status 默认落 pending；本用例测全局状态机的 unassigned/done → closed，显式置 unassigned
    const wu = await wuService.create({ scope: 'task 单', type: 'task', status: 'unassigned' });
    const closed = await wuService.transitionStatus(wu.id, 'closed');
    expect(closed.status).toBe('closed');

    const wu2 = await wuService.create({ scope: 'task 单 2', type: 'task', status: 'unassigned' });
    await wuService.transitionStatus(wu2.id, 'active');
    await wuService.transitionStatus(wu2.id, 'in_review');
    await wuService.transitionStatus(wu2.id, 'done');
    const closed2 = await wuService.transitionStatus(wu2.id, 'closed');
    expect(closed2.status).toBe('closed');
  });
});
