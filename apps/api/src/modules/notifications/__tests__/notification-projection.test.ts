import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore } from '@dommaker/studio-shared';
import { NotificationProjection, type NotificationRow } from '../notification-projection.js';

let root: string;
let store: FileStore;
let source: string;
let oldData: string | undefined;

function row(id: string, userId = 'user-a'): NotificationRow {
  return {
    id, userId, type: 'system', title: id, content: id,
    createdAt: '2026-11-01T11:00:00.000Z',
  };
}

function recipientFile(userId: string): string {
  const key = createHash('sha256').update(userId).digest('hex');
  return path.join(root, 'logs', 'projections', 'notifications', 'recipients', `${key}.json`);
}

function entryFile(id: string): string {
  const key = createHash('sha256').update(id).digest('hex');
  return path.join(root, 'logs', 'projections', 'notifications', 'entries', `${key}.json`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-projection-'));
  oldData = process.env.STUDIO_DATA_DIR;
  process.env.STUDIO_DATA_DIR = path.join(root, 'data');
  store = new FileStore();
  source = path.join(root, 'logs', 'notifications.jsonl');
  fs.mkdirSync(path.dirname(source), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldData === undefined) delete process.env.STUDIO_DATA_DIR; else process.env.STUDIO_DATA_DIR = oldData;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NotificationProjection 接收者当前态与恢复', () => {
  it('同步元数据与接收者读取解耦；unread 不读其他接收者或全历史', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`n-${i}`, i % 2 ? 'user-a' : 'user-b'));
    fs.writeFileSync(source, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
    const projection = new NotificationProjection(store, source);
    await projection.sync();
    expect((await projection.readRecipient('user-a')).unreadCount).toBe(50);
    expect((await projection.readRecipient('user-b')).unreadCount).toBe(50);

    const cold = new NotificationProjection(store, source);
    const parse = vi.spyOn(JSON, 'parse');
    const reads = vi.spyOn(store, 'readJsonUncached');
    await cold.sync();
    expect(await cold.readUnreadCount('user-a')).toBe(50);
    expect(parse).toHaveBeenCalledTimes(2); // 小 manifest + 目标 recipient，无 100 行历史/其他接收者
    expect(reads.mock.calls.map(call => String(call[0]))).toEqual([
      path.join(root, 'logs', 'projections', 'notifications', 'manifest.json'),
      recipientFile('user-a'),
    ]);
  });

  it('末尾半行同步不抛错；后续 append 换行隔离，新记录跨实例恢复', async () => {
    fs.writeFileSync(source, JSON.stringify(row('n-1')) + '\n' + '{"id":"broken"');
    const projection = new NotificationProjection(store, source);
    await projection.sync();
    expect(await projection.readUnreadCount('user-a')).toBe(1);

    await store.appendJsonl(source, row('n-2'));
    const recovered = new NotificationProjection(store, source);
    await recovered.sync();
    const recipient = await recovered.readRecipient('user-a');
    expect(recipient.unreadCount).toBe(2);
    expect(Object.keys(recipient.items)).toHaveLength(2);
  });

  it('损坏 manifest 自动重建；换 inode 只保留新真源接收者状态', async () => {
    fs.writeFileSync(source, JSON.stringify(row('old')) + '\n');
    const projection = new NotificationProjection(store, source);
    await projection.sync();
    fs.writeFileSync(path.join(root, 'logs', 'projections', 'notifications', 'manifest.json'), 'broken');
    await projection.sync();
    expect(await projection.readUnreadCount('user-a')).toBe(1);

    fs.renameSync(source, `${source}.rotated`);
    fs.writeFileSync(source, JSON.stringify(row('new', 'user-b')) + '\n');
    const replaced = new NotificationProjection(store, source);
    await replaced.sync();
    expect(await replaced.readUnreadCount('user-a')).toBe(0);
    expect(await replaced.readUnreadCount('user-b')).toBe(1);
  });

  it.each(['missing', 'corrupt'] as const)('已知 recipient 文件 %s 时从真源定向重建；未知接收者不扫历史', async mode => {
    fs.writeFileSync(source, [row('n-1'), row('n-2')].map(value => JSON.stringify(value)).join('\n') + '\n');
    const projection = new NotificationProjection(store, source);
    await projection.sync();
    if (mode === 'missing') fs.rmSync(recipientFile('user-a'));
    else fs.writeFileSync(recipientFile('user-a'), 'broken');
    const fullReads = vi.spyOn(store, 'readJsonl');

    const recovered = await projection.readRecipient('user-a');
    expect(recovered.unreadCount).toBe(2);
    expect(Object.keys(recovered.items)).toHaveLength(2);
    expect(fullReads).toHaveBeenCalledTimes(1);

    await projection.sync();
    await projection.readRecipient('user-a');
    expect(fullReads).toHaveBeenCalledTimes(1);
    expect((await projection.readRecipient('unknown')).unreadCount).toBe(0);
    expect(fullReads).toHaveBeenCalledTimes(1);
  });

  it('entry 新/recipient 旧/manifest 旧：新通知重放幂等，unread 不重复计数', async () => {
    const projection = new NotificationProjection(store, source);
    const manifestPath = path.join(root, 'logs', 'projections', 'notifications', 'manifest.json');
    await projection.sync();
    const oldManifest = JSON.stringify({ version: 3, head: null, recipientIds: [] });
    fs.writeFileSync(source, JSON.stringify(row('n-new')) + '\n');
    await projection.sync();
    fs.writeFileSync(manifestPath, oldManifest);
    fs.rmSync(recipientFile('user-a'));

    await projection.sync();
    await projection.sync(); // 同一崩溃点重复恢复也不增加 count
    expect(await projection.readUnreadCount('user-a')).toBe(1);
  });

  it('entry 新墓碑/recipient 旧未读/manifest 旧：重放按 recipient 实际项递减到零', async () => {
    fs.writeFileSync(source, JSON.stringify(row('n-read')) + '\n');
    const projection = new NotificationProjection(store, source);
    await projection.sync();
    const manifestPath = path.join(root, 'logs', 'projections', 'notifications', 'manifest.json');
    const oldManifest = fs.readFileSync(manifestPath, 'utf8');
    const oldRecipient = fs.readFileSync(recipientFile('user-a'), 'utf8');
    await store.appendJsonl(source, { id: 'n-read', deleted: true, deletedAt: '2026-11-01T12:00:00.000Z' });
    await projection.sync();

    fs.writeFileSync(manifestPath, oldManifest);
    fs.writeFileSync(recipientFile('user-a'), oldRecipient);
    await projection.sync();
    await projection.sync();
    expect(await projection.readUnreadCount('user-a')).toBe(0);
  });

  it('entry 损坏后追加同 id 墓碑：从真源重建，manifest 不携带永久未读推进', async () => {
    fs.writeFileSync(source, [row('n-read'), row('n-open')].map(value => JSON.stringify(value)).join('\n') + '\n');
    const projection = new NotificationProjection(store, source);
    await projection.sync();
    fs.writeFileSync(entryFile('n-read'), 'broken');
    await store.appendJsonl(source, { id: 'n-read', deleted: true, deletedAt: '2026-11-01T12:00:00.000Z' });

    await projection.sync();
    await projection.sync(); // 恢复后重复同步保持稳定，不重复增减 unread
    const recipient = await projection.readRecipient('user-a');
    expect(recipient.unreadCount).toBe(1);
    expect(recipient.items['n-read'].read).toBe(true);
    expect(recipient.items['n-open'].read).toBe(false);
  });
});
