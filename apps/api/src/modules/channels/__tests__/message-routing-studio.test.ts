/**
 * #632: @studio 路由退役转派后的行为测试
 *
 * 前身 = F5（2026-07-28 决策 6）@studio 转派测试：转派目标 = 频道 defaultProfileId
 * 入口角色。defaultProfileId 随 #632 退役后，@studio 按未匹配 mention 处理：
 * - @studio 永不派给 studio 系统角色本身（isSystemRole 排除精确匹配）
 * - → 未指派（assigneeId=null）走 claim 涌现 + 频道系统说明（#464 未匹配不静默）
 * - @普通角色 直达，不受影响
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { STUDIO_ROLE_DESCRIPTION } from '../../agents/agent-profile.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;

function profile(id: string, name: string, status = 'active', description: string | null = null): AgentProfileData {
  const now = new Date().toISOString();
  return { id, name, description, channels: '[]', provider: null, status, createdAt: now, updatedAt: now };
}

async function findWu(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

/** 频道内由 Studio 系统消息（authorType=agent, agentName=Studio）发出的内容 */
async function studioSystemMessages(): Promise<string[]> {
  const msgs = await fileStore.queryMessages(channelId);
  return msgs.filter(m => m.authorType === 'agent' && m.agentName === 'Studio').map(m => m.content);
}

describe('#632: @studio → 未匹配 mention（未指派 + 频道说明）', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-routing-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    channelId = `ch-studio-${Date.now()}`;
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: channelId, name: `#studio-routing`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: now, updatedAt: now,
    });
    channelMessageService.setFileStore(fileStore);
  });

  it('@studio → 未指派 + 频道说明（系统角色不执行任务，转自动认领）', async () => {
    await fileStore.createProfile(profile('studio-1', 'studio', 'active', STUDIO_ROLE_DESCRIPTION));

    const result = await routeMessage(channelId, '@studio 帮我看下', undefined, { fs: fileStore });

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.matched).toBe(false);
    expect(meta.reroutedFrom).toBeUndefined();

    const sysMsgs = await studioSystemMessages();
    expect(sysMsgs.some(c => c.includes('系统角色') && c.includes('自动认领'))).toBe(true);
  });

  it('@studio 不会把 WU 派给 studio profile 本身（即便它存在且 active）', async () => {
    await fileStore.createProfile(profile('studio-1', 'studio'));

    const result = await routeMessage(channelId, '@studio 任务', undefined, { fs: fileStore });

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
  });

  it('@pm 正常直达（不受 @studio 退役影响）', async () => {
    await fileStore.createProfile(profile('pm-1', 'pm'));

    const result = await routeMessage(channelId, '@pm 拆解这个需求', undefined, { fs: fileStore });

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBe('pm-1');
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.reroutedFrom).toBeUndefined();
    const sysMsgs = await studioSystemMessages();
    expect(sysMsgs.some(c => c.includes('系统角色'))).toBe(false);
  });
});
