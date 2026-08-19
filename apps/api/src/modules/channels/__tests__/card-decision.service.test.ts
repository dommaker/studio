// #278（决策 #250 D2）：auditor_suggestion 卡 card-decision 服务级测试
// 采纳 = 本频道建 type:task 未指派工单（正文 = 建议详情 + 原卡链接）+ meta.status 回写 confirmed；
// 拒绝 = 仅回写 rejected（留痕）。回写经 updateMessageMeta → eventBus channel.message_updated。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eventBus, FileStore } from '@dommaker/studio-shared';
import { CardDecisionService } from '../card-decision.service.js';
import { ChannelMessageService } from '../channel-message.service.js';

const SUGGESTIONS = [
  { type: 'param_tuning', risk: 'low', agentType: 'developer', detail: '调低重试上限到 2' },
  { type: 'skill_status', risk: 'high', skillId: 'skill-9', skillName: 'legacy-x', detail: '下线 legacy-x 技能' },
];

describe('CardDecisionService (#278)', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let messageService: ChannelMessageService;
  let service: CardDecisionService;
  let channelId: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-decision-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    messageService = new ChannelMessageService(fileStore);
    service = new CardDecisionService(fileStore, messageService);
    channelId = `ch-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#test-card-decision', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  });

  async function createAuditorCard(): Promise<string> {
    const msg = await messageService.createCardMessage(
      channelId, 'Auditor', '审计建议 — 2 条',
      'auditor_suggestion',
      { suggestions: SUGGESTIONS },
    );
    return msg.id;
  }

  async function readMeta(messageId: string): Promise<Record<string, unknown>> {
    const found = await fileStore.getMessageById(messageId);
    const meta = found!.message.meta;
    return typeof meta === 'string' ? JSON.parse(meta) : meta as Record<string, unknown>;
  }

  it('confirm → 本频道建 type:task 未指派工单，正文含建议详情与原卡链接', async () => {
    const messageId = await createAuditorCard();
    const result = await service.decide(channelId, messageId, 'confirm');

    expect(result.status).toBe('confirmed');
    expect(result.workUnitId).toBeTruthy();

    const wu = (await fileStore.getIndex()).find(s => s.id === result.workUnitId);
    expect(wu).toBeTruthy();
    expect(wu!.channelId).toBe(channelId);
    expect(wu!.type).toBe('task');
    expect(wu!.status).toBe('unassigned');
    expect(wu!.assigneeId ?? null).toBeNull();
    const metadata = typeof wu!.metadata === 'string' ? JSON.parse(wu!.metadata) : wu!.metadata;
    expect(metadata.creationMode).toBe('card-decision');
    expect(metadata.originalMessageId).toBe(messageId);
    // 正文 = 建议详情 + 原卡链接
    expect(metadata.description).toContain('调低重试上限到 2');
    expect(metadata.description).toContain('下线 legacy-x 技能');
    expect(metadata.description).toContain(messageId);
    expect(metadata.description).toContain(channelId);
  });

  it('confirm → meta.status 回写 confirmed + workUnitId，并推 channel.message_updated', async () => {
    const events: Array<{ channelId: string; messageId: string; meta: Record<string, unknown> }> = [];
    const handler = (e: unknown) => events.push(e as never);
    eventBus.subscribe('channel.message_updated', handler);

    const messageId = await createAuditorCard();
    const result = await service.decide(channelId, messageId, 'confirm');
    eventBus.unsubscribe('channel.message_updated', handler);

    const meta = await readMeta(messageId);
    expect(meta.status).toBe('confirmed');
    expect(meta.workUnitId).toBe(result.workUnitId);
    // 原 cardData 不被回写冲掉
    expect((meta.cardData as { suggestions: unknown[] }).suggestions).toHaveLength(2);

    const evt = events.find(e => e.messageId === messageId);
    expect(evt).toBeTruthy();
    expect(evt!.channelId).toBe(channelId);
    expect(evt!.meta.status).toBe('confirmed');
  });

  it('reject → 仅回写 rejected，不建工单', async () => {
    const messageId = await createAuditorCard();
    const result = await service.decide(channelId, messageId, 'reject');

    expect(result.status).toBe('rejected');
    expect(result.workUnitId).toBeUndefined();

    const meta = await readMeta(messageId);
    expect(meta.status).toBe('rejected');
    expect((await fileStore.getIndex()).filter(s => s.channelId === channelId)).toHaveLength(0);
  });

  it('已决定的卡再决策 → 抛 already', async () => {
    const messageId = await createAuditorCard();
    await service.decide(channelId, messageId, 'reject');
    await expect(service.decide(channelId, messageId, 'confirm')).rejects.toThrow(/already/);
  });

  it('非 auditor_suggestion 卡 → 抛 not support', async () => {
    const msg = await messageService.createCardMessage(
      channelId, 'KK', '撤回确认', 'retract_confirm', { skillId: 's-1', skillName: 'x' },
    );
    await expect(service.decide(channelId, msg.id, 'confirm')).rejects.toThrow(/not support/i);
  });

  it('消息不存在 / 频道不匹配 → 抛 not found', async () => {
    await expect(service.decide(channelId, 'msg-missing', 'confirm')).rejects.toThrow(/not found/);
    const messageId = await createAuditorCard();
    await expect(service.decide('ch-other', messageId, 'confirm')).rejects.toThrow(/not found/);
  });
});
