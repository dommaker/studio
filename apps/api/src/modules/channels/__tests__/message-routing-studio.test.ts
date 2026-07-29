/**
 * F5（2026-07-28 分析文档决策 6）: @studio 特殊路由测试
 *
 * - @studio 不建指向 studio 的 WU；转派目标 = 频道 defaultProfileId 入口角色
 *   （assigneeId=入口角色 id，metadata.reroutedFrom='studio'），频道发 Studio 系统消息
 * - 未配置 defaultProfileId / 角色 inactive / 不在频道成员内 → 未指派（assigneeId=null），
 *   走 claim 涌现，无系统消息
 * - @普通角色 直达，不受 @studio 特殊路由影响
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

describe('F5: @studio 路由 → 频道入口角色 / 未指派', () => {
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

  it('@studio + 频道配了 defaultProfileId → WU 派给入口角色，带 reroutedFrom，频道收到系统消息', async () => {
    await fileStore.createProfile(profile('studio-1', 'studio', 'active', STUDIO_ROLE_DESCRIPTION));
    await fileStore.createProfile(profile('entry-1', 'pm'));

    const result = await routeMessage(channelId, '@studio 帮我看下这个需求', undefined, fileStore);

    // defaultProfileId 未配置 → 未指派（先验证默认行为）
    let wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();

    // 配置入口角色后 → 转派
    await fileStore.updateChannel(channelId, { defaultProfileId: 'entry-1' });
    const result2 = await routeMessage(channelId, '@studio 帮我看下这个需求', undefined, fileStore);
    wu = await findWu(result2.workUnitId!);
    expect(wu).toBeTruthy();
    expect(wu!.assigneeId).toBe('entry-1');
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.mentionName).toBe('studio');
    expect(meta.reroutedFrom).toBe('studio');
    expect(meta.matched).toBe(true);
    expect(wu!.scope).toBe('帮我看下这个需求');

    const sysMsgs = await studioSystemMessages();
    expect(sysMsgs.some(c => c.includes('studio 是系统角色') && c.includes('@pm'))).toBe(true);
  });

  it('@studio 不会把 WU 派给 studio profile 本身', async () => {
    await fileStore.createProfile(profile('studio-1', 'studio'));
    await fileStore.createProfile(profile('entry-1', 'pm'));
    await fileStore.updateChannel(channelId, { defaultProfileId: 'entry-1' });

    const result = await routeMessage(channelId, '@studio 任务', undefined, fileStore);
    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).not.toBe('studio-1');
    expect(wu!.assigneeId).toBe('entry-1');
  });

  it('@studio + 未配置 defaultProfileId → 未指派（assigneeId=null，无系统消息）', async () => {
    await fileStore.createProfile(profile('studio-1', 'studio'));

    const result = await routeMessage(channelId, '@studio 帮我看下', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.matched).toBe(false);
    expect(meta.reroutedFrom).toBeUndefined();

    const sysMsgs = await studioSystemMessages();
    expect(sysMsgs.some(c => c.includes('系统角色'))).toBe(false);
  });

  it('@studio + 入口角色 inactive → 未指派', async () => {
    await fileStore.createProfile(profile('entry-1', 'pm', 'inactive'));
    await fileStore.updateChannel(channelId, { defaultProfileId: 'entry-1' });

    const result = await routeMessage(channelId, '@studio 帮我看下', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.matched).toBe(false);
    expect(meta.reroutedFrom).toBeUndefined();
  });

  it('@studio + 入口角色不在频道 members 内 → 未指派（§9.5 成员边界）', async () => {
    await fileStore.createProfile(profile('entry-1', 'pm'));
    await fileStore.updateChannel(channelId, {
      defaultProfileId: 'entry-1',
      members: JSON.stringify(['someone-else']), // 频道 members 非空但不含入口角色
    });

    const result = await routeMessage(channelId, '@studio 帮我看下', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.reroutedFrom).toBeUndefined();
  });

  it('@pm 正常直达（不受 studio 特殊路由影响）', async () => {
    await fileStore.createProfile(profile('pm-1', 'pm'));

    const result = await routeMessage(channelId, '@pm 拆解这个需求', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBe('pm-1');
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.reroutedFrom).toBeUndefined();
    const sysMsgs = await studioSystemMessages();
    expect(sysMsgs.some(c => c.includes('系统角色'))).toBe(false);
  });
});
