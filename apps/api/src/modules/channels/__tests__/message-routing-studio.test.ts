/**
 * B4a（决策 D7）: @studio 特殊路由测试
 *
 * - @studio 不建指向 studio 的 WU，改派给 pm（assigneeId=pm.id，
 *   metadata.reroutedFrom='studio'），并向频道发 Studio 系统消息
 * - pm 不存在/被禁用/不在频道成员内 → 按未命中处理（assigneeId=null）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { ensureBuiltinRoles } from '../../agents/builtin-roles.js';
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

describe('B4a: @studio 路由改派', () => {
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

  it('@studio + pm 存在 → WU 派给 pm，带 reroutedFrom，频道收到系统消息', async () => {
    await fileStore.createProfile(profile('studio-1', 'studio', 'active', STUDIO_ROLE_DESCRIPTION));
    const [pm] = (await ensureBuiltinRoles(fileStore)).filter(r => r.name === 'pm');

    const result = await routeMessage(channelId, '@studio 帮我看下这个需求', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu).toBeTruthy();
    expect(wu!.assigneeId).toBe(pm.id);
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
    const roles = await ensureBuiltinRoles(fileStore);
    const pm = roles.find(r => r.name === 'pm')!;

    const result = await routeMessage(channelId, '@studio 任务', undefined, fileStore);
    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).not.toBe('studio-1');
    expect(wu!.assigneeId).toBe(pm.id);
  });

  it('@studio + pm 不存在 → 按未命中处理（assigneeId=null，无系统消息）', async () => {
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

  it('@studio + pm 被禁用（inactive）→ 按未命中处理', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    const pm = roles.find(r => r.name === 'pm')!;
    await fileStore.updateProfile(pm.id, { status: 'inactive' });

    const result = await routeMessage(channelId, '@studio 帮我看下', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.matched).toBe(false);
    expect(meta.reroutedFrom).toBeUndefined();
  });

  it('@studio + pm 不在频道 members 内 → 按未命中处理（§9.5 成员边界）', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    // 频道 members 非空但不含 pm
    await fileStore.updateChannel(channelId, { members: JSON.stringify(['someone-else']) });

    const result = await routeMessage(channelId, '@studio 帮我看下', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBeNull();
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.reroutedFrom).toBeUndefined();
    expect(roles.find(r => r.name === 'pm')).toBeTruthy(); // pm 存在但越界
  });

  it('@pm 正常直达（不受 studio 特殊路由影响）', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    const pm = roles.find(r => r.name === 'pm')!;

    const result = await routeMessage(channelId, '@pm 拆解这个需求', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu!.assigneeId).toBe(pm.id);
    const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.reroutedFrom).toBeUndefined();
    const sysMsgs = await studioSystemMessages();
    expect(sysMsgs.some(c => c.includes('系统角色'))).toBe(false);
  });
});
