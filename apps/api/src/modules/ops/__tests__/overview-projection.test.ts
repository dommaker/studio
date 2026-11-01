import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore, type ChannelMessageData, type WorkUnitEvent, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { OverviewProjection } from '../overview-projection.js';

const NOW = new Date('2026-11-01T12:00:00.000Z').getTime();
const ISO = '2026-11-01T11:00:00.000Z';
let root: string;
let store: FileStore;
let wuFile: string;
let oldHome: string | undefined;
let oldData: string | undefined;

function message(id: string, content = id): ChannelMessageData {
  return {
    id, channelId: 'ch-1', authorType: 'human', agentName: null, content,
    replyToId: null, meta: '{}', workUnitId: null, createdAt: ISO,
  };
}

function event(id: string): WorkUnitEvent {
  return { type: 'created', wuId: id, timestamp: ISO };
}

function snapshot(id: string): WorkUnitSnapshot {
  return {
    id, parentId: null, type: 'task', scope: id, assigneeId: null, status: 'active',
    failureType: null, retryCount: 0, timeoutAt: null, channelId: null, projectPath: null,
    metadata: null, createdAt: ISO, updatedAt: ISO, claimedAt: null, completedAt: null,
  };
}

function projectionFile(): string {
  const key = createHash('sha256').update(wuFile).digest('hex').slice(0, 24);
  return path.join(root, 'logs', 'projections', `overview-${key}.json`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-projection-'));
  oldHome = process.env.STUDIO_HOME;
  oldData = process.env.STUDIO_DATA_DIR;
  process.env.STUDIO_HOME = root;
  process.env.STUDIO_DATA_DIR = path.join(root, 'data');
  store = new FileStore();
  wuFile = path.join(root, 'data', 'workunits', 'events.jsonl');
  fs.mkdirSync(path.dirname(wuFile), { recursive: true });
  fs.writeFileSync(wuFile, '');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.STUDIO_HOME; else process.env.STUDIO_HOME = oldHome;
  if (oldData === undefined) delete process.env.STUDIO_DATA_DIR; else process.env.STUDIO_DATA_DIR = oldData;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OverviewProjection 生产增量端口', () => {
  it('编辑触发重建时保留同频道幸存 human 消息', async () => {
    await store.appendMessage('ch-1', message('m1'));
    await store.appendMessage('ch-1', message('m2'));
    const projection = new OverviewProjection(store, wuFile);
    await projection.load(NOW);

    await store.appendMessage('ch-1', message('m1', 'edited'));
    const result = await projection.load(NOW);
    expect(result.humanMessages).toHaveLength(2);
  });

  it('墓碑触发重建时保留幸存 human 消息', async () => {
    await store.appendMessage('ch-1', message('m1'));
    await store.appendMessage('ch-1', message('m2'));
    const projection = new OverviewProjection(store, wuFile);
    await projection.load(NOW);

    await store.softDeleteMessage('ch-1', 'm1');
    const result = await projection.load(NOW);
    expect(result.humanMessages).toHaveLength(1);
  });

  it('invalid delta（压实缩短）重建保留幸存消息，后续稳态只读频道增量', async () => {
    await store.appendMessage('ch-1', message('m1'));
    await store.appendMessage('ch-1', message('m2'));
    const projection = new OverviewProjection(store, wuFile);
    await projection.load(NOW);
    const messagesFile = path.join(root, 'data', 'channels', 'ch-1', 'messages.jsonl');
    fs.writeFileSync(messagesFile, JSON.stringify(message('m2')) + '\n');

    expect((await projection.load(NOW)).humanMessages).toHaveLength(1);
    const delta = vi.spyOn(store, 'readChannelMessagesDelta');
    await projection.load(NOW);
    expect(delta).toHaveBeenCalledWith('ch-1', expect.any(Number), { boundarySinceMs: Number.POSITIVE_INFINITY });
    await expect(delta.mock.results[0].value).resolves.toMatchObject({ messages: [] });
  });

  it('损坏 projection 与跨实例恢复都从真源重建且不重复计数', async () => {
    await store.appendMessage('ch-1', message('m1'));
    fs.writeFileSync(wuFile, JSON.stringify(event('wu-1')) + '\n');
    const first = new OverviewProjection(store, wuFile);
    await first.load(NOW);
    fs.writeFileSync(projectionFile(), 'not-json');

    const second = new OverviewProjection(store, wuFile);
    const recovered = await second.load(NOW);
    expect(recovered.wuEvents.map(row => row.wuId)).toEqual(['wu-1']);
    expect(recovered.humanMessages).toHaveLength(1);
    expect((await second.load(NOW)).wuEvents).toHaveLength(1);
  });

  it('末尾半行只推进完整 offset；后续 append 隔离换行且新事件可恢复', async () => {
    fs.writeFileSync(wuFile, JSON.stringify(event('wu-1')) + '\n' + '{"type":"created"');
    const projection = new OverviewProjection(store, wuFile);
    expect((await projection.load(NOW)).wuEvents.map(row => row.wuId)).toEqual(['wu-1']);

    await store.appendJsonl(wuFile, event('wu-2'));
    const recovered = await new OverviewProjection(store, wuFile).load(NOW);
    expect(recovered.wuEvents.map(row => row.wuId)).toEqual(['wu-1', 'wu-2']);
  });

  it('压实换代并增长到旧 offset 以上：不错误复用水位、不复活幽灵 human', async () => {
    await store.appendMessage('ch-1', message('m1'));
    await store.appendMessage('ch-1', message('m2'));
    const projection = new OverviewProjection(store, wuFile);
    await projection.load(NOW);
    const messagesFile = path.join(root, 'data', 'channels', 'ch-1', 'messages.jsonl');
    const oldOffset = fs.statSync(messagesFile).size;

    const survivor = JSON.stringify(message('m2')) + '\n';
    const padding = { ...message('pad'), authorType: 'agent', content: '' };
    const paddingLength = oldOffset - survivor.length - (JSON.stringify(padding).length + 1);
    expect(paddingLength).toBeGreaterThanOrEqual(0);
    padding.content = 'x'.repeat(paddingLength);
    let rewritten = survivor + JSON.stringify(padding) + '\n';
    expect(rewritten.length).toBe(oldOffset); // 旧水位恰好落在行边界，旧协议会误判 valid
    rewritten += JSON.stringify({ ...message('later'), authorType: 'agent' }) + '\n';
    const tmp = `${messagesFile}.tmp`;
    fs.writeFileSync(tmp, rewritten);
    fs.renameSync(tmp, messagesFile);

    expect((await projection.load(NOW)).humanMessages).toHaveLength(1);
  });

  it('human 末尾半行保留完整行，后续 append 新消息可恢复', async () => {
    await store.appendMessage('ch-1', message('m1'));
    const messagesFile = path.join(root, 'data', 'channels', 'ch-1', 'messages.jsonl');
    fs.appendFileSync(messagesFile, '{"id":"broken"');
    const projection = new OverviewProjection(store, wuFile);
    expect((await projection.load(NOW)).humanMessages).toHaveLength(1);

    await store.appendMessage('ch-1', message('m2'));
    expect((await projection.load(NOW)).humanMessages).toHaveLength(2);
  });

  it('prune 仅跨日执行，稳态同轮不额外扫描全窗口', async () => {
    const projection = new OverviewProjection(store, wuFile);
    const prune = vi.spyOn(projection as any, 'prune');
    await projection.load(NOW);
    await projection.load(NOW);
    expect(prune).toHaveBeenCalledTimes(1);
    await projection.load(NOW + 86_400_000);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('listCurrentSnapshots 直读 PERF-02 当前态而不是历史事件', async () => {
    const current = snapshot('wu-current');
    await store.commitSnapshot(event('wu-current'), current);
    await store.commitSnapshot({ ...event('wu-current'), type: 'updated', data: { status: 'done' } }, { ...current, status: 'done' });

    await expect(store.listCurrentSnapshots()).resolves.toEqual([{ ...current, status: 'done' }]);
  });
});
