/**
 * #636：频道「最近挂接 REQ 所属 PMO」第一级派生查询测试。
 *
 * 查询原语（listChannelReqPmoProjects）自 channels/file-ref-vocabulary 下沉——
 * channels 是 requirements 下游，requirements 不可反向 import channels；
 * deriveChannelReqPmo = current-pmo 派生链第一级（seq 大→小取首个挂接 PMO），
 * 只查不建、零副作用；读取失败记日志返回 null，绝不抛出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { deriveChannelReqPmo, listChannelReqPmoProjects } from '../channel-req-pmo.js';

let tmpDir: string;
let fileStore: FileStore;
const channelId = 'ch-derive';
const now = () => new Date().toISOString();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-req-pmo-test-'));
  fileStore = new FileStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createReq(id: string, seq: number, projectId: string | null) {
  await fileStore.createRequirement({
    id, seq, title: id, status: 'open',
    channelId, createdAt: now(), createdBy: 'mention',
    ...(projectId ? { projectId } : {}),
  } as Parameters<FileStore['createRequirement']>[0]);
}

describe('deriveChannelReqPmo（#636 第一级派生）', () => {
  it('返回最近挂接 REQ（seq 大→小）所属 PMO', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-b');
    const projects: Record<string, { id: string; title: string }> = {
      'proj-a': { id: 'proj-a', title: '项目 A' },
      'proj-b': { id: 'proj-b', title: '项目 B' },
    };
    const derived = await deriveChannelReqPmo(channelId, {
      fileStore,
      getProject: async (id: string) => projects[id] ?? null,
    });
    expect(derived?.id).toBe('proj-b');
  });

  it('无挂接 REQ / 项目已不存在 → null', async () => {
    expect(await deriveChannelReqPmo(channelId, { fileStore, getProject: async () => null })).toBeNull();
    await createReq('REQ-0001', 1, null); // 无 projectId 不参与
    await createReq('REQ-0002', 2, 'proj-gone');
    expect(await deriveChannelReqPmo(channelId, { fileStore, getProject: async () => null })).toBeNull();
  });

  it('最近挂接项目解析失败 → 顺延到次近挂接（单条坏数据不拖垮整体）', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-bad');
    const derived = await deriveChannelReqPmo(channelId, {
      fileStore,
      getProject: async (id: string) => {
        if (id === 'proj-bad') throw new Error('boom');
        return { id, title: id };
      },
    });
    expect(derived?.id).toBe('proj-a');
  });

  it('REQ 列表读取失败 → null（绝不抛出）', async () => {
    const broken = { listRequirements: async () => { throw new Error('store down'); } } as unknown as FileStore;
    await expect(deriveChannelReqPmo(channelId, { fileStore: broken })).resolves.toBeNull();
  });

  it('只查不建：不产生任何写副作用', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await deriveChannelReqPmo(channelId, { fileStore, getProject: async id => ({ id, title: id }) });
    expect((await fileStore.listRequirements()).length).toBe(1);
  });

  it('B2：按 seq 降序惰性解析——首个命中即停，更早挂接不再解析', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-b');
    await createReq('REQ-0003', 3, 'proj-c');
    const calls: string[] = [];
    const derived = await deriveChannelReqPmo(channelId, {
      fileStore,
      getProject: async (id: string) => { calls.push(id); return { id, title: id }; },
    });
    expect(derived?.id).toBe('proj-c');
    expect(calls).toEqual(['proj-c']); // 原 Promise.all 全量解析 3 次
  });

  it('B2：最近挂接项目缺失 → 惰性顺延次近（仍只解析到首个命中）', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-gone');
    const calls: string[] = [];
    const derived = await deriveChannelReqPmo(channelId, {
      fileStore,
      getProject: async (id: string) => { calls.push(id); return id === 'proj-gone' ? null : { id, title: id }; },
    });
    expect(derived?.id).toBe('proj-a');
    expect(calls).toEqual(['proj-gone', 'proj-a']);
  });
});

describe('listChannelReqPmoProjects（下沉后原语义保持）', () => {
  it('跳过无 projectId / 项目缺失条目，返回挂接关联', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, null);
    await createReq('REQ-0003', 3, 'proj-missing');
    const links = await listChannelReqPmoProjects(channelId, {
      fileStore,
      getProject: async (id: string) => (id === 'proj-a' ? { id, title: id } : null),
    });
    expect(links.map(l => l.reqId)).toEqual(['REQ-0001']);
    expect(links[0].projectId).toBe('proj-a');
    expect(links[0].seq).toBe(1);
  });
});
