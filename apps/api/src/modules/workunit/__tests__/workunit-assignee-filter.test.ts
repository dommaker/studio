// ADR 2026-09-23-role-form-module 决策 7（#630）：GET /workunits?assigneeId= 过滤口径
// 扩为「assigneeId 或 assigneeRoleId 任一命中」。claim 会把 assigneeId 改写为实例 id
// （认领快照留在 assigneeRoleId），只认 assigneeId 恰好漏掉正在执行的那批——
// 角色删除确认框的在途清单依赖修正后的口径。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

describe('WorkUnitService.list assigneeId 过滤口径扩展（ADR 2026-09-23-role-form-module 决策 7）', () => {
  let tmpDir: string;
  let service: WorkUnitService;

  // 夹具：
  // - directHit：未认领指名，assigneeId = profile id（既有口径命中）
  // - claimedHit：已认领，assigneeId 被改写为实例 id，认领快照 assigneeRoleId = profile id
  // - otherRole：与查询角色无关
  let directHitId: string;
  let claimedHitId: string;
  let otherRoleId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-assignee-filter-test-'));
    const fileStore = new FileStore(tmpDir);
    service = new WorkUnitService(fileStore);

    directHitId = (await service.create({ scope: '指名未认领', assigneeId: 'role-coder' })).id;
    claimedHitId = (await service.create({ scope: '已被实例认领', status: 'active', assigneeId: 'inst-1' })).id;
    otherRoleId = (await service.create({ scope: '别人的任务', assigneeId: 'role-reviewer' })).id;

    // 模拟 claim 落认领快照：assigneeId=实例 id，assigneeRoleId=认领方 profile id
    const snap = (await fileStore.getIndex()).find((s) => s.id === claimedHitId)!;
    await fileStore.upsertSnapshot({ ...snap, assigneeId: 'inst-1', assigneeRoleId: 'role-coder' });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('assigneeId 直接命中（未认领指名）仍被查得', async () => {
    const result = await service.list({ assigneeId: 'role-coder' });

    expect(result.data.map((w) => w.id)).toContain(directHitId);
  });

  it('assigneeRoleId 认领快照命中：已认领 WU（assigneeId=实例 id）按角色查得', async () => {
    const result = await service.list({ assigneeId: 'role-coder' });
    const ids = result.data.map((w) => w.id);

    expect(ids).toContain(claimedHitId);
    expect(ids).not.toContain(otherRoleId);
    expect(result.total).toBe(2);
  });

  it('按实例 id 查询仍命中（assigneeId 直比语义不变）', async () => {
    const result = await service.list({ assigneeId: 'inst-1' });

    expect(result.data.map((w) => w.id)).toEqual([claimedHitId]);
  });
});
