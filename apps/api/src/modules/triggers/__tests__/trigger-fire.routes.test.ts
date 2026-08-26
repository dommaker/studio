/**
 * 手动触发端点测试（POST /:id/fire + GET /costs）
 *
 * 背景：「配不上自动化、但值得一个按钮」的任务降级为手动触发（docs/issues/2026-08-03-unattended-token-burn.md）。
 * 覆盖：
 *  - fire：已停用触发器仍可手动触发（wasDisabled=true）；CREATE 创建 WU 且不做同分钟去重；
 *    EXECUTE 调 handler；yaml store 缺失时回退 scheduler 内存 config；未知 id 404；不支持的动作类型 400
 *  - costs：workunit:tokens 按 triggerId 聚合（billed 优先、total 兜底）；
 *    system:tokens 按 source 统计 calls/tokens；days 窗口过滤
 *
 * 路由层契约测试，mock TriggerStore / TriggerScheduler / trigger-action（同 tree-tokens.routes.test.ts 模式）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mockStoreGet, mockGetStates, mockExecuteCreateAction, mockExecuteExecuteAction } = vi.hoisted(() => ({
  mockStoreGet: vi.fn(),
  mockGetStates: vi.fn(),
  mockExecuteCreateAction: vi.fn(),
  mockExecuteExecuteAction: vi.fn(),
}));

vi.mock('../trigger-store.js', () => ({
  TriggerStore: class {
    get = mockStoreGet;
    list = vi.fn(() => []);
    save = vi.fn();
    delete = vi.fn();
  },
}));

vi.mock('../trigger-registry.js', () => ({
  getTriggerScheduler: () => ({
    getStates: mockGetStates,
    getLogs: vi.fn(() => []),
    isRunning: vi.fn(() => true),
    loadTriggers: vi.fn(),
  }),
}));

vi.mock('../trigger-action.js', () => ({
  executeCreateAction: mockExecuteCreateAction,
  executeExecuteAction: mockExecuteExecuteAction,
}));

import { triggerRouter } from '../trigger.routes.js';

function makeConfig(id: string, actionType: 'CREATE' | 'EXECUTE' | 'UPDATE', enabled = true) {
  return {
    id,
    name: id,
    condition: { type: 'SCHEDULE', cron: '17 3 * * *' },
    action: actionType === 'CREATE'
      ? { type: 'CREATE', target: 'WorkUnit', payload: { type: 'analysis', scope: `${id} scope` } }
      : actionType === 'EXECUTE'
        ? { type: 'EXECUTE', target: 'some-handler' }
        : { type: 'UPDATE', target: 'workunit', config: { query: {}, update: {} } },
    enabled,
    scope: 'system',
  } as const;
}

describe('trigger manual fire + costs', () => {
  let server: Server;
  let base: string;
  let eventsFile: string;
  let eventsTmpDir: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/triggers', triggerRouter);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}/triggers`;

    // costs 端点走 STUDIO_EVENTS_JSONL 覆盖（与 agent-loop 同一测试隔离约定）
    eventsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-fire-test-'));
    eventsFile = path.join(eventsTmpDir, 'events.jsonl');
    process.env.STUDIO_EVENTS_JSONL = eventsFile;
  });

  afterAll(async () => {
    delete process.env.STUDIO_EVENTS_JSONL;
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(eventsTmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fire 已停用的 yaml 触发器：仍创建 WU，wasDisabled=true', async () => {
    mockStoreGet.mockReturnValue(makeConfig('disabled-yaml', 'CREATE', false));
    mockExecuteCreateAction.mockResolvedValue({ id: 'wu-1', scope: 'disabled-yaml scope', status: 'queued' });

    const res = await fetch(`${base}/disabled-yaml/fire`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fired).toBe(true);
    expect(body.wasDisabled).toBe(true);
    expect(body.workUnit.id).toBe('wu-1');
    // 手动触发不做同分钟去重：第三参不传
    expect(mockExecuteCreateAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'CREATE' }), 'disabled-yaml');
    expect(mockExecuteCreateAction.mock.calls[0]).toHaveLength(2);
  });

  it('fire 系统默认触发器（不在 store，回退 scheduler 内存 config）', async () => {
    mockStoreGet.mockReturnValue(undefined);
    mockGetStates.mockReturnValue([
      { config: makeConfig('knowledge-synthesis', 'CREATE', false), lastFiredAt: null, nextFireAt: null, errorCount: 0 },
    ]);
    mockExecuteCreateAction.mockResolvedValue({ id: 'wu-2', scope: 'synthesis', status: 'queued' });

    const res = await fetch(`${base}/knowledge-synthesis/fire`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fired).toBe(true);
    expect(body.wasDisabled).toBe(true);
    expect(body.workUnit.id).toBe('wu-2');
  });

  it('同分钟连续 fire 两次：两次都创建 WU（手动路径不去重）', async () => {
    mockStoreGet.mockReturnValue(makeConfig('twice', 'CREATE'));
    mockExecuteCreateAction
      .mockResolvedValueOnce({ id: 'wu-a', scope: 'twice', status: 'queued' })
      .mockResolvedValueOnce({ id: 'wu-b', scope: 'twice', status: 'queued' });

    const r1 = await fetch(`${base}/twice/fire`, { method: 'POST' });
    const r2 = await fetch(`${base}/twice/fire`, { method: 'POST' });
    expect((await r1.json()).workUnit.id).toBe('wu-a');
    expect((await r2.json()).workUnit.id).toBe('wu-b');
    expect(mockExecuteCreateAction).toHaveBeenCalledTimes(2);
  });

  it('fire EXECUTE 型触发器：调用 handler', async () => {
    mockStoreGet.mockReturnValue(makeConfig('exec-trigger', 'EXECUTE'));

    const res = await fetch(`${base}/exec-trigger/fire`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fired).toBe(true);
    expect(body.wasDisabled).toBe(false);
    expect(mockExecuteExecuteAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EXECUTE' }),
      expect.objectContaining({ manual: true }),
    );
  });

  it('fire 未知 id：404', async () => {
    mockStoreGet.mockReturnValue(undefined);
    mockGetStates.mockReturnValue([]);

    const res = await fetch(`${base}/nope/fire`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('fire UPDATE 型触发器：400', async () => {
    mockStoreGet.mockReturnValue(makeConfig('upd', 'UPDATE'));

    const res = await fetch(`${base}/upd/fire`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('#163（T8-E2/T9）：手动 fire inspection-scan 直调 executeCreateAction——不过冷却闸、不做同分钟去重', async () => {
    // 冷却闸只挂在 scheduler 的 EVENT/SCHEDULE 自动路径；手动 fire 是人点按钮的显式意图，
    // 路由层直调 executeCreateAction（本文件 mock 掉的就是它——若手动路径接入冷却闸，
    // 本用例的调用断言会随之断裂）。
    mockStoreGet.mockReturnValue(undefined);
    mockGetStates.mockReturnValue([
      { config: { ...makeConfig('inspection-scan', 'CREATE'), condition: { type: 'EVENT', event: 'workunit.status_changed' } }, lastFiredAt: null, nextFireAt: null, errorCount: 0 },
    ]);
    mockExecuteCreateAction.mockResolvedValue({ id: 'wu-insp', scope: '巡检', status: 'pending' });

    const res = await fetch(`${base}/inspection-scan/fire`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fired).toBe(true);
    // 建单落 pending（#162 人闸手动 fire 继承，由 executeCreateAction 统一落地）
    expect(body.workUnit.status).toBe('pending');
    expect(mockExecuteCreateAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'CREATE' }), 'inspection-scan');
    expect(mockExecuteCreateAction.mock.calls[0]).toHaveLength(2);
  });

  it('GET /costs：按 triggerId/source 聚合并按 days 窗口过滤', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 24 * 3600_000);
    const lines = [
      // billed 优先
      { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ triggerId: 'doc-semantic-review', billedTokens: 1000, totalTokens: 100 }), createdAt: now.toISOString() },
      // 旧事件无 billed → totalTokens 兜底
      { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ triggerId: 'doc-semantic-review', totalTokens: 50 }), createdAt: now.toISOString() },
      // 无 triggerId → 不计入
      { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ totalTokens: 999 }), createdAt: now.toISOString() },
      // system:tokens：usage 缺失 → calls 准确、tokens 为 0
      { type: 'system:tokens', source: 'knowledge-maintenance', payload: JSON.stringify({ inputTokens: null, outputTokens: null, durationMs: 1000 }), createdAt: now.toISOString() },
      { type: 'system:tokens', source: 'knowledge-maintenance', payload: JSON.stringify({ inputTokens: 10, outputTokens: 5, durationMs: 1000 }), createdAt: now.toISOString() },
      // 窗口外 → 过滤
      { type: 'workunit:tokens', source: 'agent-loop', payload: JSON.stringify({ triggerId: 'doc-semantic-review', billedTokens: 7777 }), createdAt: old.toISOString() },
    ];
    fs.writeFileSync(eventsFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const res = await fetch(`${base}/costs?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byTrigger['doc-semantic-review']).toBe(1050);
    expect(body.callsBySource['knowledge-maintenance']).toBe(2);
    expect(body.bySource['knowledge-maintenance']).toBe(15);
  });
});
