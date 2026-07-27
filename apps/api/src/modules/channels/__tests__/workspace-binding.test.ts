/**
 * F6: WorkUnit 绑定工程
 *
 * - routeMessage: 显式 workspaceId 优先，其次频道 defaultWorkspaceId
 * - ConvertToTaskService.convert: 同样绑定规则
 * - validateDefaultWorkspaceId: 频道 PATCH 校验（workspace 须已注册，'' → 清除）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { ConvertToTaskService } from '../convert-to-task.service.js';
import { validateDefaultWorkspaceId } from '../channel.routes.js';

const WORKSPACES_DIR = path.join(os.homedir(), '.studio', 'workspaces');

let tmpDir: string;
let fileStore: FileStore;
let channelId: string;

/** 在真实 ~/.studio/workspaces 下写一条临时 workspace 记录（channel-members.test.ts 同款约定：用真实目录 + afterAll 清理） */
const testWsId = `ws-f6-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function wsFilePath(id: string): string {
  return path.join(WORKSPACES_DIR, `${id}.json`);
}

async function createChannel(defaultWorkspaceId: string | null): Promise<string> {
  const id = `ch-f6-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id, name: `#f6-${id.slice(-8)}`, type: 'rnd',
    defaultWorkspaceId, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]',
    createdAt: now, updatedAt: now,
  });
  return id;
}

async function findWu(id: string) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f6-binding-test-'));
  fileStore = new FileStore(tmpDir);
  channelMessageService.setFileStore(fileStore);
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fs.writeFileSync(wsFilePath(testWsId), JSON.stringify({
    id: testWsId, name: 'f6-test', workspaceRoot: '/tmp/f6-test-root',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
});

afterAll(async () => {
  delete process.env.STUDIO_PROJECTS_ROOT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.unlinkSync(wsFilePath(testWsId)); } catch { /* already gone */ }
});

beforeEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fileStore = new FileStore(tmpDir);
  channelMessageService.setFileStore(fileStore);
  channelId = await createChannel(null);
  // B3a：线程回复触发归属解析时会查 project-discovery —— 指向空 tmp 目录保持隔离
  process.env.STUDIO_PROJECTS_ROOT = tmpDir;
});

describe('F6: routeMessage workspace binding', () => {
  it('binds channel defaultWorkspaceId when no explicit workspaceId', async () => {
    channelId = await createChannel(testWsId);

    const msg = await routeMessage(channelId, '@Agent do this', undefined, fileStore);

    const wu = await findWu(msg.workUnitId!);
    expect(wu).toBeTruthy();
    expect(wu!.workspaceId).toBe(testWsId);
  });

  it('explicit workspaceId wins over channel default', async () => {
    channelId = await createChannel(testWsId);

    const msg = await routeMessage(channelId, '@Agent do this', undefined, fileStore, { workspaceId: 'ws-explicit-1' });

    const wu = await findWu(msg.workUnitId!);
    expect(wu!.workspaceId).toBe('ws-explicit-1');
  });

  it('workspaceId=null when channel has no default and none given', async () => {
    const msg = await routeMessage(channelId, '@Agent do this', undefined, fileStore);

    const wu = await findWu(msg.workUnitId!);
    expect(wu!.workspaceId ?? null).toBeNull();
  });

  it('thread reply does not create/bind WorkUnit (unchanged)', async () => {
    const anchor = await routeMessage(channelId, '@Agent do this', undefined, fileStore);
    const reply = await routeMessage(channelId, 'follow up', anchor.id, fileStore);
    expect(reply.workUnitId).toBe(anchor.workUnitId);
  });
});

describe('F6: convert-to-task workspace binding', () => {
  async function createSourceMessage(): Promise<string> {
    const now = new Date().toISOString();
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fileStore.appendMessage(channelId, {
      id: msgId, channelId, authorType: 'human', agentName: null,
      content: 'source message', replyToId: null, meta: '{}', workUnitId: null, createdAt: now,
    });
    return msgId;
  }

  it('binds channel defaultWorkspaceId when no explicit workspaceId', async () => {
    channelId = await createChannel(testWsId);
    const msgId = await createSourceMessage();
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, { title: 'task' });

    expect(wu.workspaceId).toBe(testWsId);
  });

  it('explicit workspaceId wins over channel default', async () => {
    channelId = await createChannel(testWsId);
    const msgId = await createSourceMessage();
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, { title: 'task', workspaceId: 'ws-explicit-2' });

    expect(wu.workspaceId).toBe('ws-explicit-2');
  });

  it('workspaceId=null when channel has no default and none given', async () => {
    const msgId = await createSourceMessage();
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, { title: 'task' });

    expect(wu.workspaceId ?? null).toBeNull();
  });
});

describe('F6: validateDefaultWorkspaceId (channel PATCH)', () => {
  it('accepts a registered workspace id', async () => {
    const result = await validateDefaultWorkspaceId(testWsId);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(testWsId);
  });

  it('rejects an unknown workspace id', async () => {
    const result = await validateDefaultWorkspaceId('ws-does-not-exist-f6');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ws-does-not-exist-f6');
  });

  it("normalizes '' to null (clear default)", async () => {
    const result = await validateDefaultWorkspaceId('');
    expect(result.ok).toBe(true);
    expect(result.value).toBeNull();
  });

  it('normalizes null/non-string to null (clear default)', async () => {
    expect((await validateDefaultWorkspaceId(null)).value).toBeNull();
    expect((await validateDefaultWorkspaceId(123)).value).toBeNull();
  });
});
