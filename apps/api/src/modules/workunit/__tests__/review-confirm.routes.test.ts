// #463：review-passed 路由的结构化 confirm body——人点按钮，后端把表单数据序列化为
// l3.summary（存储格式不变）；analysis 的 tasks 经 options.analysisTasks 透传 service 覆写。
// WorkUnitService mock 掉（形态照 review-author-type.test.ts），只测路由层契约。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockReviewPassed } = vi.hoisted(() => ({
  mockReviewPassed: vi.fn(),
}));

vi.mock('../workunit.service.js', () => ({
  WorkUnitService: class {
    reviewPassed = mockReviewPassed;
  },
  ANALYSIS_TASKS_MAX: 8,
}));

import router from '../workunit.routes.js';

describe('#463 review-passed confirm body（结构化评审表单序列化）', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    mockReviewPassed.mockResolvedValue({ id: 'wu-1', status: 'done' });
    const app = express();
    app.use(express.json());
    app.use('/workunits', router);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/workunits`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  function post(body?: unknown) {
    return fetch(`${base}/wu-1/review-passed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('confirm decision → 结论原文作 summary 进 l3', async () => {
    mockReviewPassed.mockClear();
    const res = await post({ confirm: { kind: 'decision', conclusion: '选型用 SQLite' } });
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      kind: 'human-confirm', summary: '选型用 SQLite',
    }), undefined);
  });

  it('confirm spec → tasks 序列化为 TASK 物化行进 summary', async () => {
    mockReviewPassed.mockClear();
    const res = await post({
      confirm: { kind: 'spec', tasks: [{ title: '实现存储层', ac: ['单测覆盖'] }] },
    });
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      summary: 'TASK: 实现存储层 | AC: 单测覆盖',
    }), undefined);
  });

  it('confirm analysis → summary=目标/待决行 + options.analysisTasks 透传（含 defaultAssigneeId 并存）', async () => {
    mockReviewPassed.mockClear();
    const res = await post({
      confirm: { kind: 'analysis', destination: '上线', fog: ['选型？'], tasks: ['干活'] },
      defaultAssigneeId: 'profile-7',
    });
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      summary: '目标：上线\n待决：选型？',
    }), { defaultTaskAssigneeId: 'profile-7', analysisTasks: ['干活'] });
  });

  it('confirm 与裸 summary 并存 → confirm 优先（人永不接触魔法行，裸字段为兼容留路）', async () => {
    mockReviewPassed.mockClear();
    const res = await post({
      summary: '手写行',
      confirm: { kind: 'decision', conclusion: '表单结论' },
    });
    expect(res.status).toBe(200);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', expect.objectContaining({
      summary: '表单结论',
    }), undefined);
  });

  it('confirm 非法（kind 未知 / tasks 缺标题）→ 400，service 未被调用', async () => {
    mockReviewPassed.mockClear();
    const bad1 = await post({ confirm: { kind: 'task' } });
    expect(bad1.status).toBe(400);
    const bad2 = await post({ confirm: { kind: 'spec', tasks: [{ ac: ['缺标题'] }] } });
    expect(bad2.status).toBe(400);
    expect(mockReviewPassed).not.toHaveBeenCalled();
  });
});
