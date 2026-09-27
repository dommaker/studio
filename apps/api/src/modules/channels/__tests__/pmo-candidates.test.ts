/**
 * #638：频道 PMO 候选补全派生（deriveChannelPmoCandidates）测试。
 *
 * 候选集 = [当前 PMO（含杂务回退，若有）, ...本频道挂接 REQ 所属 PMO（seq 大→小，
 * 按 projectId 去重保留首次，排除当前 PMO 自身）]，映射 {id, pmoNumber, title}。
 * pmoNumber 为空的项目无法形成合法 #PMO-n token（req-binding PMO_TOKEN_RE），一律过滤。
 * 各来源独立容错：REQ 列表读取失败记日志返回既有结果（可能仅 current 或 []），绝不抛出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { deriveChannelPmoCandidates } from '../pmo-candidates.js';
import type { CurrentPmoProject } from '../current-pmo.js';

let tmpDir: string;
let fileStore: FileStore;
const channelId = 'ch-candidates';
const now = () => new Date().toISOString();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-candidates-test-'));
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

function project(id: string, pmoNumber: string | undefined, title: string): CurrentPmoProject {
  return { id, title, ...(pmoNumber ? { pmoNumber } : {}) };
}

const noChore = async () => null;

describe('deriveChannelPmoCandidates（#638）', () => {
  it('当前 PMO 置顶，其余挂接项目按 seq 降序跟随', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-b');
    await createReq('REQ-0003', 3, 'proj-c');
    const projects: Record<string, CurrentPmoProject> = {
      'proj-a': project('proj-a', 'PMO-1', '商城重构'),
      'proj-b': project('proj-b', 'PMO-2', '订单链路'),
      'proj-c': project('proj-c', 'PMO-3', '结算迁移'),
    };
    const out = await deriveChannelPmoCandidates(channelId, {
      fileStore,
      getProject: async (id: string) => projects[id] ?? null,
      findChoreProject: noChore,
    });
    expect(out).toEqual([
      { id: 'proj-c', pmoNumber: 'PMO-3', title: '结算迁移' },
      { id: 'proj-b', pmoNumber: 'PMO-2', title: '订单链路' },
      { id: 'proj-a', pmoNumber: 'PMO-1', title: '商城重构' },
    ]);
  });

  it('同一项目被多条 REQ 挂接 → 去重保留 seq 最大首次', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-b');
    await createReq('REQ-0003', 3, 'proj-a'); // 再次挂接 proj-a
    const projects: Record<string, CurrentPmoProject> = {
      'proj-a': project('proj-a', 'PMO-1', '商城重构'),
      'proj-b': project('proj-b', 'PMO-2', '订单链路'),
    };
    const out = await deriveChannelPmoCandidates(channelId, {
      fileStore,
      getProject: async (id: string) => projects[id] ?? null,
      findChoreProject: noChore,
    });
    // 当前 PMO = 最近挂接 proj-a（置顶），proj-b 次之；proj-a 不重复出现
    expect(out.map(c => c.id)).toEqual(['proj-a', 'proj-b']);
  });

  it('无挂接 REQ → 杂务 PMO 回退入列', async () => {
    const out = await deriveChannelPmoCandidates(channelId, {
      fileStore,
      getProject: async () => null,
      findChoreProject: async () => project('proj-chore', 'PMO-9', '研发杂务'),
    });
    expect(out).toEqual([{ id: 'proj-chore', pmoNumber: 'PMO-9', title: '研发杂务' }]);
  });

  it('无挂接 REQ 且无杂务 PMO → []', async () => {
    const out = await deriveChannelPmoCandidates(channelId, {
      fileStore,
      getProject: async () => null,
      findChoreProject: noChore,
    });
    expect(out).toEqual([]);
  });

  it('REQ 列表读取失败 → 不抛出（记日志降级，返回 [] 或仅 current）', async () => {
    const broken = { listRequirements: async () => { throw new Error('store down'); } } as unknown as FileStore;
    await expect(deriveChannelPmoCandidates(channelId, {
      fileStore: broken,
      getProject: async () => null,
      findChoreProject: noChore,
    })).resolves.toEqual([]);
  });

  it('pmoNumber 为空的项目被过滤（无法形成合法 #PMO-n token），含当前 PMO', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-nonum'); // 最近挂接项目无 pmoNumber
    const projects: Record<string, CurrentPmoProject> = {
      'proj-a': project('proj-a', 'PMO-1', '商城重构'),
      'proj-nonum': project('proj-nonum', undefined, '无编号项目'),
    };
    const out = await deriveChannelPmoCandidates(channelId, {
      fileStore,
      getProject: async (id: string) => projects[id] ?? null,
      findChoreProject: noChore,
    });
    expect(out).toEqual([{ id: 'proj-a', pmoNumber: 'PMO-1', title: '商城重构' }]);
  });

  it('B2：current 与候选共享同一次 links 拉取（每项目只解析一次，原两趟各解析一遍）', async () => {
    await createReq('REQ-0001', 1, 'proj-a');
    await createReq('REQ-0002', 2, 'proj-b');
    const calls: string[] = [];
    const out = await deriveChannelPmoCandidates(channelId, {
      fileStore,
      getProject: async (id: string) => {
        calls.push(id);
        return project(id, `PMO-${id}`, `项目 ${id}`);
      },
      findChoreProject: noChore,
    });
    // seq 最大者即 current 置顶，同一趟 links 出两结果
    expect(out.map(c => c.id)).toEqual(['proj-b', 'proj-a']);
    expect([...calls].sort()).toEqual(['proj-a', 'proj-b']);
  });
});
