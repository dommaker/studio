// §10.3 显式覆盖：消息中 +skill名 → 创建 WorkUnit 时写入 metadata.skillHints（token 保留原文不改写）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage, parseSkillHints } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;

/** 从 FileStore 中按 id 查找 WorkUnit snapshot */
async function findWu(id: string): Promise<import('@dommaker/studio-shared').WorkUnitSnapshot | null> {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

describe('§10.3: parseSkillHints', () => {
  it('解析全部 +skill名 token（按序）', () => {
    expect(parseSkillHints('实现登录 +tdd +review 谢谢')).toEqual(['tdd', 'review']);
  });

  it('去重且保持首次出现顺序', () => {
    expect(parseSkillHints('+a +b +a')).toEqual(['a', 'b']);
  });

  it('无 token → 空数组（plain 文本同样适用）', () => {
    expect(parseSkillHints('随便聊聊，没有 hint')).toEqual([]);
  });

  it('支持连字符与下划线 skill 名', () => {
    expect(parseSkillHints('+skill-design-skill +my_skill')).toEqual(['skill-design-skill', 'my_skill']);
  });
});

describe('§10.3: routeMessage 写入 metadata.skillHints', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hints-routing-'));
    fileStore = new FileStore(tmpDir);
    channelId = `test-hints-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#test-hints', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    channelMessageService.setFileStore(fileStore);
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    await fileStore.createChannel({
      id: channelId, name: '#test-hints', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    channelMessageService.setFileStore(fileStore);
  });

  it('@mention 路径：+skill名 写入 WU metadata.skillHints，消息原文不改写', async () => {
    await fileStore.createProfile({
      id: 'hint-agent-1', name: 'HintAgent', description: 'hint test',
      channels: '[]', status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const content = '@HintAgent +tdd +review 实现登录';
    const result = await routeMessage(channelId, content, undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu).not.toBeNull();
    const meta = JSON.parse(wu!.metadata!);
    expect(meta.skillHints).toEqual(['tdd', 'review']);
    // token 保留在消息原文中（不改写）
    expect(result.content).toBe(content);
  });

  it('@mention 路径：无 +token 时不写 skillHints 字段', async () => {
    const result = await routeMessage(channelId, '@Nobody 实现登录', undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    const meta = JSON.parse(wu!.metadata!);
    expect(meta.skillHints).toBeUndefined();
  });

  it('plain 路径：不创建 WorkUnit（无 metadata 可写）', async () => {
    const result = await routeMessage(channelId, '+tdd 随便聊聊', undefined, fileStore);

    expect(result.workUnitId).toBeFalsy();
    expect((await fileStore.getIndex()).filter(s => s.channelId === channelId)).toHaveLength(0);
  });
});
