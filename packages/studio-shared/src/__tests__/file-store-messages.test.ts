/**
 * MessagesStore 组合壳测试（#681 P1-1；前身为 #655 刀二 FileStoreMessagesBase
 * 抽层测试——继承链断言改写为组合结构等价断言）
 *
 * 频道消息子域由 MessagesStore 组合壳承载（持有 MessagesCoreStore /
 * MessagesQueryStore / MessagesArchiveStore 实例并委托），门面 FileStore
 * 持有 MessagesStore 实例逐方法委托。断言三个维度：
 *   ① 组合结构：消息方法群以自有属性（委托方法）承载在 FileStore.prototype；
 *      FileStore 不再是 MessagesStore 的实例（无继承）；
 *   ② 方法承载：MessagesStore.prototype 上消息方法群齐备；
 *   ③ 功能冒烟：FileStore 实例 appendMessage → getChannelVersion →
 *      getMessagesSince 回读一致（委托链端到端通）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '../file-store';
import { MessagesStore } from '../file-store-messages';

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

describe('MessagesStore 组合壳（#681 P1-1）', () => {
  it('组合结构：FileStore 非 MessagesStore 实例，消息方法群为门面自有委托方法', () => {
    const store = new FileStore(tmpDir);
    expect(store).not.toBeInstanceOf(MessagesStore);
    for (const name of MESSAGE_METHODS) {
      expect(Object.prototype.hasOwnProperty.call(FileStore.prototype, name), name).toBe(true);
    }
  });

  it('消息方法群承载在 MessagesStore.prototype', () => {
    for (const name of MESSAGE_METHODS) {
      expect(typeof (MessagesStore.prototype as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('功能冒烟：appendMessage → getChannelVersion → getMessagesSince 回读一致', async () => {
    const store = new FileStore(tmpDir);
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
