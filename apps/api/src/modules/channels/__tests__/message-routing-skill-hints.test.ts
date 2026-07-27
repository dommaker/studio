// §10.3 显式覆盖 → 决策 11 重构：路由层不再解析 +skill名（解析挪到 skill-selector，
// agent-loop step 时从 scope 提取，见 skill-domain-match.test.ts 的 parseSkillHintsFromScope 用例）。
// 本文件守卫路由层新契约：
// - routeMessage 不再写 metadata.skillHints（路由层不认识 skill）
// - +token 保留在 WU scope 原文（供 step 时解析）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;

/** 从 FileStore 中按 id 查找 WorkUnit snapshot */
async function findWu(id: string): Promise<import('@dommaker/studio-shared').WorkUnitSnapshot | null> {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

describe('§10.3 → 决策 11: routeMessage 与 +skill 解耦', () => {
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

  it('@mention 路径：+token 保留在 scope 原文，metadata 不再写 skillHints', async () => {
    await fileStore.createProfile({
      id: 'hint-agent-1', name: 'HintAgent', description: 'hint test',
      channels: '[]', status: 'active',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const content = '@HintAgent +tdd +review 实现登录';
    const result = await routeMessage(channelId, content, undefined, fileStore);

    const wu = await findWu(result.workUnitId!);
    expect(wu).not.toBeNull();
    // +token 保留在 scope 原文（step 时由 parseSkillHintsFromScope 解析）
    expect(wu!.scope).toBe('+tdd +review 实现登录');
    const meta = JSON.parse(wu!.metadata!);
    expect(meta.skillHints).toBeUndefined();
    // 消息原文不改写
    expect(result.content).toBe(content);
  });

  it('plain 路径：不创建 WorkUnit（未配置频道默认角色时维持纯存储）', async () => {
    const result = await routeMessage(channelId, '+tdd 随便聊聊', undefined, fileStore);

    expect(result.workUnitId).toBeFalsy();
    expect((await fileStore.getIndex()).filter(s => s.channelId === channelId)).toHaveLength(0);
  });
});
