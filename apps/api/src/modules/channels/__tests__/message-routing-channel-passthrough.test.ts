// #525 P2-2（决策 #517 项 3）：路由层读到的 channel 传参进 routeMessage，
// 消灭 mention/默认角色路径的重复 getChannel 读。
// 传入 options.channel 时 routeMessage 全程零次 fileStore.getChannel；
// 未传入时保持现状读（既有直调 routeMessage 的调用方不受影响）。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type AgentProfileData, type ChannelData } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';

/** 计数包装：统计 routeMessage 链路对 getChannel 的读取次数 */
class CountingFileStore extends FileStore {
  getChannelCalls = 0;
  override async getChannel(id: string): Promise<ChannelData | null> {
    this.getChannelCalls += 1;
    return super.getChannel(id);
  }
}

let tmpDir: string;
let fileStore: CountingFileStore;

function makeChannel(id: string, overrides?: Partial<ChannelData>): ChannelData {
  const now = new Date().toISOString();
  return {
    id, name: `#${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]',
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeProfile(id: string, name: string): AgentProfileData {
  const now = new Date().toISOString();
  return { id, name, description: `test agent ${name}`, channels: '[]', status: 'active', createdAt: now, updatedAt: now };
}

describe('routeMessage options.channel 传参（#525 P2-2）', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-routing-channel-pass-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new CountingFileStore(tmpDir);
    channelMessageService.setFileStore(fileStore);
  });

  it('@mention 路径：传入 channel 时全程零次 getChannel', async () => {
    const channelId = 'ch-mention-pass';
    const channel = makeChannel(channelId);
    await fileStore.createChannel(channel);
    await fileStore.createProfile(makeProfile('agent-mention-1', 'MentionAgent'));

    const result = await routeMessage(channelId, '@MentionAgent do this', undefined, { fs: fileStore, channel });

    expect(result.workUnitId).toBeTruthy();
    expect(fileStore.getChannelCalls).toBe(0);
  });

  it('默认角色路径：传入 channel 时全程零次 getChannel', async () => {
    const channelId = 'ch-default-pass';
    const channel = makeChannel(channelId, { defaultProfileId: 'agent-default-1' });
    await fileStore.createChannel(channel);
    await fileStore.createProfile(makeProfile('agent-default-1', 'DefaultAgent'));

    const result = await routeMessage(channelId, 'plain message no mention', undefined, { fs: fileStore, channel });

    expect(result.workUnitId).toBeTruthy();
    expect(fileStore.getChannelCalls).toBe(0);
  });

  it('@mention 路径：未传 channel 时保持现状读（行为不变）', async () => {
    const channelId = 'ch-mention-nopass';
    await fileStore.createChannel(makeChannel(channelId));
    await fileStore.createProfile(makeProfile('agent-mention-2', 'MentionAgent2'));

    const result = await routeMessage(channelId, '@MentionAgent2 do this', undefined, { fs: fileStore });

    expect(result.workUnitId).toBeTruthy();
    // 现状：routeMessage 自身读（成员界定）+ 归属解析读（频道 defaultPath）
    expect(fileStore.getChannelCalls).toBeGreaterThan(0);
  });

  it('默认角色路径：未传 channel 时保持现状读（行为不变）', async () => {
    const channelId = 'ch-default-nopass';
    await fileStore.createChannel(makeChannel(channelId, { defaultProfileId: 'agent-default-2' }));
    await fileStore.createProfile(makeProfile('agent-default-2', 'DefaultAgent2'));

    const result = await routeMessage(channelId, 'plain message no mention', undefined, { fs: fileStore });

    expect(result.workUnitId).toBeTruthy();
    expect(fileStore.getChannelCalls).toBe(1);
  });
});
