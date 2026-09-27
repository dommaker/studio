/**
 * FileStore 增量水位线读口测试（2026-09 channel-flow-audit-fix B5）
 *
 * readChannelMessagesDelta：字节偏移水位的前向增量读，替代 observe 回复检测的
 * 每轮全量 queryAllMessages。断言三个维度：
 *   ① 窗口归并结果与全量 queryMessages 口径逐条等价（含更新副本/tombstone）；
 *   ② newOffset 边界语义——只越过 createdAt < boundarySinceMs 的行，候选行留在窗口重复投递；
 *   ③ 水位失效检测（压实重写缩短/错位）valid=false，调用方可回退 0 偏移全读重建。
 * listMessageChannelIds：频道目录枚举与 queryAllMessages 同口径（目录是事实源）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type ChannelMessageData } from '../file-store';

const CH = 'ch-delta';
const BASE_MS = Date.UTC(2026, 0, 1);

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-delta-'));
  store = new FileStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRow(id: string, createdAtMs: number, opts?: { workUnitId?: string; authorType?: string; content?: string }): ChannelMessageData {
  return {
    id,
    channelId: CH,
    workUnitId: opts?.workUnitId ?? null,
    authorType: opts?.authorType ?? 'human',
    agentName: null,
    content: opts?.content ?? `message ${id}`,
    replyToId: null,
    meta: '{}',
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

function messagesFileSize(channelId: string = CH): number {
  return fs.statSync(path.join(tmpDir, 'channels', channelId, 'messages.jsonl')).size;
}

describe('readChannelMessagesDelta', () => {
  it('fromOffset=0 全量读与 queryMessages 口径逐条等价（含更新副本归并 + tombstone 作废）', async () => {
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000));
    await store.appendMessage(CH, makeRow('m2', BASE_MS + 2000));
    await store.appendMessage(CH, makeRow('m3', BASE_MS + 3000));
    // m2 的更新副本（createdAt 不变、位置在尾）+ m1 tombstone
    await store.appendMessage(CH, makeRow('m2', BASE_MS + 2000, { content: 'message m2 edited' }));
    await store.softDeleteMessage(CH, 'm1');

    const delta = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: BASE_MS });
    const full = await store.queryMessages(CH);

    expect(delta.valid).toBe(true);
    expect(delta.messages).toEqual(full);
    expect(delta.endOffset).toBe(messagesFileSize());
    // 首行即候选（createdAt >= boundary）→ 水位不推进
    expect(delta.newOffset).toBe(0);
  });

  it('稳态无新行：从 endOffset 再读返回空窗口，水位原地不动', async () => {
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000));
    const first = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: Number.POSITIVE_INFINITY });
    expect(first.messages).toHaveLength(1);
    // 无候选（boundary=+∞）→ 水位推进到文件尾
    expect(first.newOffset).toBe(first.endOffset);

    const second = await store.readChannelMessagesDelta(CH, first.newOffset, { boundarySinceMs: Number.POSITIVE_INFINITY });
    expect(second.valid).toBe(true);
    expect(second.messages).toEqual([]);
    expect(second.newOffset).toBe(first.newOffset);
  });

  it('增量追加：水位只越过 createdAt < boundary 的行，候选行留在窗口重复投递', async () => {
    const boundaryMs = BASE_MS + 5000;
    await store.appendMessage(CH, makeRow('m-old', BASE_MS + 1000)); // < boundary
    const first = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: boundaryMs });
    expect(first.messages.map(m => m.id)).toEqual(['m-old']);
    // m-old 非候选 → 水位越过它到文件尾
    expect(first.newOffset).toBe(first.endOffset);

    await store.appendMessage(CH, makeRow('m-new', BASE_MS + 6000)); // >= boundary
    const second = await store.readChannelMessagesDelta(CH, first.newOffset, { boundarySinceMs: boundaryMs });
    expect(second.messages.map(m => m.id)).toEqual(['m-new']);
    // m-new 是候选 → 水位停在它的起始偏移（不越过）
    expect(second.newOffset).toBe(first.newOffset);

    // 下一轮同水位再读：候选重复投递（与全扫「未消费回复每轮可见」口径一致），m-old 不再出现
    const third = await store.readChannelMessagesDelta(CH, second.newOffset, { boundarySinceMs: boundaryMs });
    expect(third.messages.map(m => m.id)).toEqual(['m-new']);
  });

  it('更新副本/tombstone 追加只让文件变长：字节水位不丢中段新消息（id 锚毒化场景）', async () => {
    const boundaryMs = BASE_MS + 5000;
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000));
    const first = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: boundaryMs });
    let wm = first.newOffset; // m1 非候选 → 文件尾

    // m1 的更新副本（旧 createdAt 落在尾部新位置）+ 真候选 m2 —— id 锚会在副本处早停丢 m2
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000, { content: 'm1 edited' }));
    await store.appendMessage(CH, makeRow('m2', BASE_MS + 6000));
    const second = await store.readChannelMessagesDelta(CH, wm, { boundarySinceMs: boundaryMs });
    expect(second.messages.map(m => m.id)).toEqual(['m1', 'm2']);
    expect(second.messages[0].content).toBe('m1 edited'); // 副本最新版生效
    expect(second.newOffset).toBeGreaterThan(wm);
    wm = second.newOffset; // m2 候选 → 停在 m2 起始

    // tombstone 作废 m2（tombstone 行带 createdAt 但不参与边界）+ 追加 m3
    await store.softDeleteMessage(CH, 'm2');
    await store.appendMessage(CH, makeRow('m3', BASE_MS + 7000));
    const third = await store.readChannelMessagesDelta(CH, wm, { boundarySinceMs: boundaryMs });
    expect(third.messages.map(m => m.id)).toEqual(['m3']); // m2 被墓碑作废，m3 不丢
  });

  it('水位失效：压实重写缩短（fromOffset > size）→ valid=false，回退 0 偏移全读重建', async () => {
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000));
    await store.appendMessage(CH, makeRow('m2', BASE_MS + 2000));
    const first = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: Number.POSITIVE_INFINITY });
    const wm = first.newOffset;

    // 模拟压实：原子重写只留 m2（文件缩短）
    const file = path.join(tmpDir, 'channels', CH, 'messages.jsonl');
    fs.writeFileSync(file, JSON.stringify(makeRow('m2', BASE_MS + 2000)) + '\n');
    expect(messagesFileSize()).toBeLessThan(wm);

    const shrunk = await store.readChannelMessagesDelta(CH, wm, { boundarySinceMs: Number.POSITIVE_INFINITY });
    expect(shrunk.valid).toBe(false);

    // 调用方回退：0 偏移全读，与全量口径一致
    const rebuilt = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: Number.POSITIVE_INFINITY });
    expect(rebuilt.valid).toBe(true);
    expect(rebuilt.messages.map(m => m.id)).toEqual(['m2']);
  });

  it('水位失效：重写+追加后文件更长但行边界错位（fromOffset-1 非换行）→ valid=false', async () => {
    await store.appendMessage(CH, makeRow('m1', BASE_MS + 1000));
    const first = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: Number.POSITIVE_INFINITY });
    const wm = first.newOffset;

    // 模拟重写后文件反而变长：wm-1 处不再是换行符
    const file = path.join(tmpDir, 'channels', CH, 'messages.jsonl');
    const longer = [makeRow('x1', BASE_MS + 1000, { content: 'a much longer content payload to shift offsets' }),
      makeRow('x2', BASE_MS + 2000), makeRow('x3', BASE_MS + 3000)];
    fs.writeFileSync(file, longer.map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(messagesFileSize()).toBeGreaterThan(wm);

    const misaligned = await store.readChannelMessagesDelta(CH, wm, { boundarySinceMs: Number.POSITIVE_INFINITY });
    expect(misaligned.valid).toBe(false);
  });

  it('频道/文件不存在：空窗口 + valid=true + 水位归零', async () => {
    const delta = await store.readChannelMessagesDelta('ch-nonexistent', 12345, { boundarySinceMs: BASE_MS });
    expect(delta).toEqual({ messages: [], newOffset: 0, endOffset: 0, valid: true });
  });

  it('多字节字符内容：字节偏移与 UTF-8 内容混排不错位', async () => {
    await store.appendMessage(CH, makeRow('m-utf8', BASE_MS + 1000, { content: '中文内容🚀混排' }));
    const first = await store.readChannelMessagesDelta(CH, 0, { boundarySinceMs: Number.POSITIVE_INFINITY });
    await store.appendMessage(CH, makeRow('m-after', BASE_MS + 2000));
    const second = await store.readChannelMessagesDelta(CH, first.newOffset, { boundarySinceMs: Number.POSITIVE_INFINITY });
    expect(second.valid).toBe(true);
    expect(second.messages.map(m => m.id)).toEqual(['m-after']);
  });
});

describe('listMessageChannelIds', () => {
  it('枚举 channels 目录全部子目录（含无 config 的目录），排除文件', async () => {
    await store.appendMessage('ch-a', { ...makeRow('m1', BASE_MS), channelId: 'ch-a' });
    // 无 config、只有 messages.jsonl 的目录（与 queryAllMessages 扫描口径一致——目录是事实源）
    fs.mkdirSync(path.join(tmpDir, 'channels', 'ch-b'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'channels', 'ch-b', 'messages.jsonl'), '');
    // 散文件不进枚举
    fs.writeFileSync(path.join(tmpDir, 'channels', 'stray-file'), '');

    const ids = await store.listMessageChannelIds();
    expect(ids.sort()).toEqual(['ch-a', 'ch-b']);
  });

  it('channels 目录不存在 → 空数组（同 queryAllMessages 容错口径）', async () => {
    expect(await store.listMessageChannelIds()).toEqual([]);
  });
});
