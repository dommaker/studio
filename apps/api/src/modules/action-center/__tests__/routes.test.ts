// GET /api/v1/action-center（#468 统一行动中心）
// 覆盖三种 kind 派生口径：reply=blocked+waitingForInput（不再排除 decision/spec）、
// review=in_review 且闸门类（MANUAL_GATE_TYPES）、confirm=pending；
// notifications/unreadCount 来自 NotificationService 持久面。
// 环境：vitest 钉 STUDIO_AUTH=none → requireAuth 注入 user { id: 'local', role: 'Admin' }。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { WorkUnitService } from '../../workunit/workunit.service.js';
import { actionCenterRoutes } from '../routes.js';

let server: Server;
let base: string;

interface StateItem {
  kind: 'reply' | 'review' | 'confirm';
  wuId: string;
  scope: string;
  channelId: string | null;
  waitingQuestion?: string;
  since: string;
}

interface ActionCenterBody {
  stateItems: StateItem[];
  notifications: Array<{ id: string; type: string; read: boolean }>;
  unreadCount: number;
}

async function get(): Promise<{ status: number; body: ActionCenterBody }> {
  const res = await fetch(`${base}/`);
  return { status: res.status, body: (await res.json()) as ActionCenterBody };
}

beforeAll(async () => {
  const wuService = new WorkUnitService(new FileStore());

  // reply：blocked + waitingForInput（含闸门类 decision——设计稿明确不再排除）
  await wuService.create({
    type: 'task', scope: '实现登录', channelId: 'ch-1', status: 'blocked',
    metadata: { waitingForInput: true, waitingQuestion: '选哪个方案？', waitingSince: '2026-09-09T01:00:00.000Z', title: '登录功能' },
  });
  await wuService.create({
    type: 'decision', scope: '方案抉择', channelId: 'ch-1', status: 'blocked',
    metadata: { waitingForInput: true, waitingQuestion: 'A 还是 B？' },
  });
  // 排除项：blocked 但无 waitingForInput
  await wuService.create({ type: 'task', scope: '卡住的执行', status: 'blocked' });
  // review：in_review + 闸门类
  await wuService.create({ type: 'spec', scope: '规格评审', status: 'in_review' });
  // 排除项：in_review 非闸门类（自动评审链路）
  await wuService.create({ type: 'task', scope: '自动评审中', status: 'in_review' });
  // confirm：pending
  await wuService.create({ type: 'feature', scope: '待确认需求', status: 'pending' });
  // 排除项：done
  await wuService.create({ type: 'task', scope: '已完成', status: 'done' });

  // 持久面：本人一条未读 + 他人一条（不计入）
  const notifService = new NotificationService(new FileStore());
  await notifService.create({ userId: 'local', type: 'incident', title: 'T', content: 'severity: critical\nx' });
  await notifService.create({ userId: 'other-user', type: 'system', title: 'T', content: 'y' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/action-center', actionCenterRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/action-center`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('GET /api/v1/action-center（#468）', () => {
  it('返回 stateItems + notifications + unreadCount 三段结构', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(Array.isArray(body.stateItems)).toBe(true);
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(typeof body.unreadCount).toBe('number');
  });

  it('reply = blocked + waitingForInput，带 waitingQuestion/since，闸门类不再排除', async () => {
    const { body } = await get();
    const replies = body.stateItems.filter(i => i.kind === 'reply');
    expect(replies).toHaveLength(2);

    const task = replies.find(i => i.scope === '登录功能');
    expect(task).toBeDefined();
    expect(task!.waitingQuestion).toBe('选哪个方案？');
    expect(task!.since).toBe('2026-09-09T01:00:00.000Z');
    expect(task!.channelId).toBe('ch-1');
    expect(task!.wuId).toBeTruthy();

    expect(replies.some(i => i.scope === '方案抉择')).toBe(true); // decision 类不再排除
    expect(replies.some(i => i.scope === '卡住的执行')).toBe(false); // 无 waitingForInput
  });

  it('review = in_review 且闸门类（task 的 in_review 不收）', async () => {
    const { body } = await get();
    const reviews = body.stateItems.filter(i => i.kind === 'review');
    expect(reviews.map(i => i.scope)).toEqual(['规格评审']);
  });

  it('confirm = pending；终态不收', async () => {
    const { body } = await get();
    const confirms = body.stateItems.filter(i => i.kind === 'confirm');
    expect(confirms.map(i => i.scope)).toEqual(['待确认需求']);
    expect(body.stateItems.some(i => i.scope === '已完成')).toBe(false);
  });

  it('notifications 只含本人持久面，unreadCount 与之一致', async () => {
    const { body } = await get();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].type).toBe('incident');
    expect(body.unreadCount).toBe(1);
  });
});
