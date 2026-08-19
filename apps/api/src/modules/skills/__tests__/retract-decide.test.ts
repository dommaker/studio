// #278（决策 #250 D2）：POST /api/v1/skills/:id/retract/decide 路由测试
// confirm → deprecated、reject → 恢复 published；messageId 提供时同步回写卡片 meta.status。
// 风格对齐 evolution.routes.test.ts：真 express app + 真 FileStore 系单例（隔离数据根）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { mockUpdateMessageMeta } = vi.hoisted(() => ({
  mockUpdateMessageMeta: vi.fn(),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { updateMessageMeta: mockUpdateMessageMeta },
  ChannelMessageService: vi.fn(),
}));

import skillsRouter from '../routes.js';
import { skillStore } from '../skill-store.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/skills', skillsRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function decide(id: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/v1/skills/${id}/retract/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** 建一个唯一名 skill 并推到指定状态 */
function makeSkill(name: string, status: string): string {
  const skill = skillStore.create({ companyId: 'comp-test', name, source: 'manual' });
  skillStore.update(skill.id, { status });
  return skill.id;
}

describe('POST /api/v1/skills/:id/retract/decide (#278)', () => {
  it('confirm → deprecated，messageId 提供时回写卡片 meta.status', async () => {
    const id = makeSkill(`retract-confirm-${Date.now()}`, 'under_review');
    mockUpdateMessageMeta.mockClear();

    const { status, body } = await decide(id, { decision: 'confirm', messageId: 'msg-rc-1' });

    expect(status).toBe(200);
    expect((body.data as { status: string }).status).toBe('deprecated');
    expect(skillStore.get(id)!.status).toBe('deprecated');
    expect(mockUpdateMessageMeta).toHaveBeenCalledWith('msg-rc-1', { status: 'deprecated' });
  });

  it('reject → 恢复 published，卡片同步回写 published', async () => {
    const id = makeSkill(`retract-reject-${Date.now()}`, 'under_review');
    mockUpdateMessageMeta.mockClear();

    const { status, body } = await decide(id, { decision: 'reject', messageId: 'msg-rc-2' });

    expect(status).toBe(200);
    expect((body.data as { status: string }).status).toBe('published');
    expect(skillStore.get(id)!.status).toBe('published');
    expect(mockUpdateMessageMeta).toHaveBeenCalledWith('msg-rc-2', { status: 'published' });
  });

  it('无 messageId → 状态迁移照常，不做卡片回写', async () => {
    const id = makeSkill(`retract-nomsg-${Date.now()}`, 'under_review');
    mockUpdateMessageMeta.mockClear();

    const { status } = await decide(id, { decision: 'confirm' });

    expect(status).toBe(200);
    expect(skillStore.get(id)!.status).toBe('deprecated');
    expect(mockUpdateMessageMeta).not.toHaveBeenCalled();
  });

  it('decision 非法 → 400', async () => {
    const id = makeSkill(`retract-bad-${Date.now()}`, 'under_review');
    const { status } = await decide(id, { decision: 'maybe' });
    expect(status).toBe(400);
  });

  it('skill 不存在 → 404', async () => {
    const { status } = await decide('skill-missing', { decision: 'confirm' });
    expect(status).toBe(404);
  });

  it('非 under_review 状态 → 400（状态机守卫）', async () => {
    const id = makeSkill(`retract-guard-${Date.now()}`, 'published');
    const { status } = await decide(id, { decision: 'confirm' });
    expect(status).toBe(400);
    expect(skillStore.get(id)!.status).toBe('published');
  });
});
