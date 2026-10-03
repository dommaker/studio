/**
 * FileStoreMessagesBase 抽层测试（#655 刀二，PURE_MOVE）
 *
 * 频道消息子域自 file-store.ts 整块抽为 file-store-messages.ts 的
 * FileStoreMessagesBase（extends FileStoreWorkUnitBase），门面 FileStore 改继承本层。
 * 断言三个维度：
 *   ① 继承链：FileStore instanceof FileStoreMessagesBase；
 *   ② 方法承载：消息方法群在 FileStoreMessagesBase.prototype 自有属性上，
 *      FileStore.prototype 自有属性上不再有（经继承取用）；
 *   ③ 功能冒烟：FileStoreMessagesBase 实例 appendMessage → getChannelVersion →
 *      getMessagesSince 回读一致。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '../file-store';
import { FileStoreMessagesBase } from '../file-store-messages';

const CH = 'ch-msgs-base';
const BASE_MS = Date.UTC(2026, 0, 1);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-msgs-base-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRow(id: string, createdAtMs: number): ChannelMessageData {
  return {
    id,
    channelId: CH,
    workUnitId: null,
    authorType: 'human',
    agentName: null,
    content: `message ${id}`,
    replyToId: null,
    meta: '{}',
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

const MESSAGE_METHODS = [
  'appendMessage',
  'getChannelVersion',
  'getMessagesSince',
  'readMessagesTail',
  'readChannelMessagesDelta',
  'listMessageChannelIds',
  'queryMessages',
  'queryMessagesPage',
  'softDeleteMessage',
  'archiveChannelMessages',
  'thawWorkUnitMessages',
  'queryAllMessages',
  'getMessageById',
] as const;

describe('FileStoreMessagesBase 抽层（#655 刀二）', () => {
  it('FileStore extends FileStoreMessagesBase', () => {
    const store = new FileStore(tmpDir);
    expect(store).toBeInstanceOf(FileStoreMessagesBase);
  });

  it('消息方法群承载在 FileStoreMessagesBase.prototype，FileStore.prototype 自有属性上没有', () => {
    for (const name of MESSAGE_METHODS) {
      expect(typeof (FileStoreMessagesBase.prototype as Record<string, unknown>)[name], name).toBe('function');
      expect(Object.prototype.hasOwnProperty.call(FileStore.prototype, name), name).toBe(false);
    }
  });

  it('功能冒烟：appendMessage → getChannelVersion → getMessagesSince 回读一致', async () => {
    const store = new FileStoreMessagesBase(tmpDir);
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000));
    await store.appendMessage(CH, makeRow('m2', BASE_MS + 2000));

    const version = await store.getChannelVersion(CH);
    expect(version.lastMessageId).toBe('m2');

    const all = await store.getMessagesSince(CH, null);
    expect(all.map(m => m.id)).toEqual(['m1', 'm2']);

    const since = await store.getMessagesSince(CH, 'm1');
    expect(since.map(m => m.id)).toEqual(['m2']);
  });
});
