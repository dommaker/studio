// #327 阶段6：超龄（已归档）消息只读降级——编辑/删除/convert-to-task 走既有 not-found
// 明确错误路径（非 500 崩溃）；replyTo 父消息在冷文件时引用降级放行（帖子成立、
// workUnitId 继承失效落 null、不崩）。
// 约定与 message-routing.test.ts 一致：真实 FileStore（tmpdir）+ singleton 注入。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { ConvertToTaskService } from '../convert-to-task.service.js';

let tmpDir: string;
let fileStore: FileStore;
const CH = 'ch-archived-readonly';

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

function makeMessage(id: string, opts?: { workUnitId?: string | null; createdAt?: string }): ChannelMessageData {
  return {
    id,
    channelId: CH,
    workUnitId: opts?.workUnitId ?? null,
    authorType: 'human',
    agentName: null,
    content: `message ${id}`,
    replyToId: null,
    meta: '{}',
    createdAt: opts?.createdAt ?? new Date().toISOString(),
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-archive-readonly-'));
  fileStore = new FileStore(tmpDir);
  await fileStore.createChannel({
    id: CH, name: '#archived-readonly', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  channelMessageService.setFileStore(fileStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 追加一条 40 天前的消息并 sweep 归档（默认 maxAgeDays=30） */
async function seedArchivedMessage(id: string, opts?: { workUnitId?: string | null }): Promise<ChannelMessageData> {
  const msg = makeMessage(id, { ...opts, createdAt: daysAgo(40) });
  await fileStore.appendMessage(CH, msg);
  const result = await fileStore.archiveChannelMessages();
  expect(result.archivedMessages).toBeGreaterThan(0);
  return msg;
}

describe('归档消息只读降级（#327）', () => {
  it('replyTo 父消息已归档 → 降级放行：帖子成立、replyToId 保留、workUnitId 落 null', async () => {
    const parent = await seedArchivedMessage('parent-archived');

    const reply = await routeMessage(CH, '回复一条已归档的消息', parent.id, fileStore);

    expect(reply.replyToId).toBe(parent.id);
    expect(reply.workUnitId ?? null).toBeNull();
    // 帖子落在热文件，热只读查询面可见
    const hot = await fileStore.queryMessages(CH);
    expect(hot.map(m => m.id)).toContain(reply.id);
  });

  it('replyTo 父消息不存在 → 同样降级放行（与已归档不可区分，不整帖抛错）', async () => {
    const reply = await routeMessage(CH, '回复一条不存在的消息', 'ghost-parent', fileStore);

    expect(reply.replyToId).toBe('ghost-parent');
    expect(reply.workUnitId ?? null).toBeNull();
    const hot = await fileStore.queryMessages(CH);
    expect(hot.map(m => m.id)).toContain(reply.id);
  });

  it('replyTo 父消息在热层 → 行为不变：继承 workUnitId', async () => {
    // 父消息挂在一个 active WU 上（永归不了档）
    await fileStore.appendMessage(CH, makeMessage('parent-hot', { workUnitId: 'wu-live' }));

    const reply = await routeMessage(CH, '正常线程回复', 'parent-hot', fileStore);

    expect(reply.workUnitId).toBe('wu-live');
  });

  it('归档消息编辑 → updateMessage / updateMessageMeta 抛 not found（路由映射 404 的既有路径）', async () => {
    const archived = await seedArchivedMessage('edit-archived');

    await expect(channelMessageService.updateMessage(archived.id, { content: '改' }))
      .rejects.toThrow(/not found/);
    await expect(channelMessageService.updateMessageMeta(archived.id, { status: 'done' }))
      .rejects.toThrow(/not found/);
  });

  it('归档消息 convert-to-task → 抛 not found（路由映射 404 的既有路径）', async () => {
    const archived = await seedArchivedMessage('convert-archived');
    const service = new ConvertToTaskService(fileStore);

    await expect(service.convert(CH, archived.id, {})).rejects.toThrow(/not found/);
  });

  it('归档消息删除 → FileStore.softDeleteMessage 抛 Message not found（热层无此行）', async () => {
    const archived = await seedArchivedMessage('delete-archived');

    await expect(fileStore.softDeleteMessage(CH, archived.id))
      .rejects.toThrow(`Message not found: ${archived.id}`);
  });
});
