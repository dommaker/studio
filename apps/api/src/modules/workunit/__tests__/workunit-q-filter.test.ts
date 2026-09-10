// 批次 D-2 项4（docs/plans/2026-09-ui-interaction-polish.md）：GET /workunits?q=
// 标题（scope）大小写不敏感子串过滤。与既有过滤取交集；计数复用分页响应 total
// （过滤后计数，同 #428 attributed 口径），不单开 count 端点。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

describe('WorkUnitService.list q 过滤（批次 D-2 项4）', () => {
  let tmpDir: string;
  let service: WorkUnitService;

  // 夹具：登录/Login 两条（大小写混合）、登出（不含 needle）、同名不同状态一条
  let loginTaskId: string;
  let loginMixedCaseId: string;
  let logoutId: string;
  let loginDoneId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-q-test-'));
    service = new WorkUnitService(new FileStore(tmpDir));

    loginTaskId = (await service.create({ scope: '实现用户登录功能' })).id;
    loginMixedCaseId = (await service.create({ scope: 'Fix Login redirect' })).id;
    logoutId = (await service.create({ scope: '实现用户登出功能' })).id;
    loginDoneId = (await service.create({ scope: '登录页样式修复', status: 'done' })).id;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('q 子串匹配 scope（中文）', async () => {
    const result = await service.list({ q: '登录' });
    const ids = result.data.map(w => w.id);

    expect(ids).toContain(loginTaskId);
    expect(ids).toContain(loginDoneId);
    expect(ids).not.toContain(logoutId); // 「登出」不含「登录」
    expect(ids).not.toContain(loginMixedCaseId); // 英文标题不含中文 needle
  });

  it('q 大小写不敏感（login 命中 Login）', async () => {
    const result = await service.list({ q: 'login' });

    expect(result.data.map(w => w.id)).toEqual([loginMixedCaseId]);
  });

  it('total 是过滤后全量计数，非当前页数量', async () => {
    const result = await service.list({ q: '登录', page: 1, limit: 1 });

    expect(result.data.length).toBe(1);
    expect(result.total).toBe(2);
  });

  it('与既有 status 过滤可组合（交集语义）', async () => {
    const result = await service.list({ q: '登录', status: 'done' });

    expect(result.data.map(w => w.id)).toEqual([loginDoneId]);
    expect(result.total).toBe(1);
  });

  it('不传 q 时行为不变（全量，不过滤）', async () => {
    const result = await service.list({});

    expect(result.total).toBe(4);
  });
});
