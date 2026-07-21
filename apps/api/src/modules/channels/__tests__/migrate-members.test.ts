// §9.5: profile.channels → channel.members 迁移测试
// 合并（union 去重）、幂等（重复执行不重复加）、profile.channels 过渡期保留不删。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, parseChannels, type AgentProfileData, type ChannelData } from '@dommaker/studio-shared';
import { migrateProfileChannelsToMembers } from '../migrate-members.js';

describe('§9.5: migrateProfileChannelsToMembers', () => {
  let testDir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-members-'));
    fileStore = new FileStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function createProfile(id: string, channels: string[]): Promise<void> {
    const now = new Date().toISOString();
    const data: AgentProfileData = {
      id, name: `agent-${id}`, description: null,
      channels: JSON.stringify(channels), status: 'active', provider: null,
      createdAt: now, updatedAt: now,
    };
    return fileStore.createProfile(data);
  }

  function createChannel(id: string, members: string[]): Promise<void> {
    const now = new Date().toISOString();
    const data: ChannelData = {
      id, name: `#${id}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify(members),
      createdAt: now, updatedAt: now,
    };
    return fileStore.createChannel(data);
  }

  async function membersOf(channelId: string): Promise<string[]> {
    return parseChannels((await fileStore.getChannel(channelId))!.members);
  }

  it('merges profile.channels into channel members (union, dedup, skips missing channels)', async () => {
    await createChannel('ch-1', ['p-existing']);
    await createChannel('ch-2', []);
    await createProfile('p-1', ['ch-1']);
    await createProfile('p-2', ['ch-1', 'ch-gone']); // ch-gone 不存在 → 跳过
    await createProfile('p-3', ['ch-2']);
    await createProfile('p-existing', ['ch-1']);     // 已在 members 中 → 不重复计

    const result = await migrateProfileChannelsToMembers(fileStore);

    expect(result.merged).toBe(3); // p-1→ch-1, p-2→ch-1, p-3→ch-2
    expect((await membersOf('ch-1')).sort()).toEqual(['p-1', 'p-2', 'p-existing'].sort());
    expect(await membersOf('ch-2')).toEqual(['p-3']);
  });

  it('idempotent: running twice adds no duplicate members', async () => {
    await createChannel('ch-1', []);
    await createProfile('p-1', ['ch-1']);
    await createProfile('p-2', ['ch-1']);

    const first = await migrateProfileChannelsToMembers(fileStore);
    const afterFirst = await membersOf('ch-1');
    const second = await migrateProfileChannelsToMembers(fileStore);

    expect(first.merged).toBe(2);
    expect(second.merged).toBe(0);
    expect(await membersOf('ch-1')).toEqual(afterFirst);
    expect(new Set(afterFirst).size).toBe(afterFirst.length); // 无重复
  });

  it('does not clear profile.channels (transitional — field kept readable)', async () => {
    await createChannel('ch-1', []);
    await createProfile('p-1', ['ch-1']);

    await migrateProfileChannelsToMembers(fileStore);

    expect((await fileStore.getProfile('p-1'))!.channels).toBe('["ch-1"]');
  });
});
