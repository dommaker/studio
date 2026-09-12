/**
 * B3a 工程归属链（决策 D2）— resolveWorkspaceForWU 优先级链测试
 *
 * 覆盖：Requirement.projectId → PMO gitRepo > 文件引用 > 频道 defaultPath > none；
 * 各步独立容错（需求缺失 / 项目缺失 / 无 gitRepo / 查询抛错 → 落下一优先级）。
 *
 * #481（2026-09-11）：「显式 workspaceId」与「频道 defaultWorkspaceId（默认执行机器）」
 * 两级已退役——机器指针不再产出；频道只配 defaultWorkspaceId 时归属为 none。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { resolveWorkspaceForWU, OWNERSHIP_WAITING_QUESTION } from '../ownership-resolver.js';
import { RequirementService } from '../requirement.service.js';

let tmpDir: string;
let fileStore: FileStore;
let reqService: RequirementService;
const channelId = 'ownership-ch';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-resolver-test-'));
  fileStore = new FileStore(tmpDir);
  // projectExists stub：挂接 projectId（隔离 PMO 依赖）
  reqService = new RequirementService(fileStore, { projectExists: async () => true });
  await fileStore.createChannel({
    id: channelId, name: '#ownership', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 频道只配 defaultWorkspaceId（默认执行机器残骸）——#481 后不再是归属 rung */
async function setChannelMachine(workspaceId: string | null) {
  await fileStore.updateChannel(channelId, { defaultWorkspaceId: workspaceId });
}

describe('resolveWorkspaceForWU（B3a 优先级链）', () => {
  it('Requirement.projectId + PMO gitRepo → source=requirement，gitRepo 作 workspaceRoot', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });
    await setChannelMachine('ws-channel'); // 机器指针存在但被 Requirement 压过（且本就不是 rung）

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      channelId,
      fileStore,
      getProject: async id => (id === 'proj-1' ? { gitRepo: '/data/repo' } : null),
    });

    expect(result).toEqual({
      source: 'requirement', workspaceRoot: '/data/repo', projectId: 'proj-1',
    });
  });

  it('Requirement 无 projectId + 频道只配 defaultWorkspaceId → none（#481：机器指针不再产出归属）', async () => {
    const req = await reqService.create({ title: 'r' });
    await setChannelMachine('ws-channel');

    const result = await resolveWorkspaceForWU({ reqId: req.id, channelId, fileStore });

    expect(result).toEqual({ source: 'none', workspaceRoot: null, projectId: null });
  });

  it('PMO 项目无 gitRepo + 频道只配 defaultWorkspaceId → none', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });
    await setChannelMachine('ws-channel');

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      channelId,
      fileStore,
      getProject: async () => ({ gitRepo: null }),
    });

    expect(result.source).toBe('none');
  });

  it('PMO 项目不存在 / 查询抛错 → 落下一优先级（容错）', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-gone' });

    const notFound = await resolveWorkspaceForWU({
      reqId: req.id, channelId, fileStore, getProject: async () => null,
    });
    expect(notFound.source).toBe('none');

    const thrown = await resolveWorkspaceForWU({
      reqId: req.id, channelId, fileStore,
      getProject: async () => { throw new Error('boom'); },
    });
    expect(thrown.source).toBe('none');
  });

  it('reqId 指向不存在的 REQ → 落下一优先级', async () => {
    const result = await resolveWorkspaceForWU({ reqId: 'REQ-9999', channelId, fileStore });

    expect(result.source).toBe('none');
  });

  it('REQ 无 projectId 且频道无默认工程 → none（调用方转 NEED_INPUT）', async () => {
    const req = await reqService.create({ title: 'r' });

    const result = await resolveWorkspaceForWU({ reqId: req.id, channelId, fileStore });

    expect(result).toEqual({ source: 'none', workspaceRoot: null, projectId: null });
  });

  it('无任何输入 → none', async () => {
    const result = await resolveWorkspaceForWU({ fileStore });

    expect(result.source).toBe('none');
  });

  it('OWNERSHIP_WAITING_QUESTION 文案（挂起提问口径）', () => {
    expect(OWNERSHIP_WAITING_QUESTION).toBe('这个任务要修改哪个工程？请回复工程名或路径');
  });
});

describe('#285（决策 #249 §4）：fileRefs 归属 rung（REQ 继承 > 文件引用 > 频道默认工程 > none）', () => {
  const sameRepoRefs = [
    { repo: '/data/repo', path: 'src/a.ts' },
    { repo: '/data/repo/', path: 'src/b.ts' }, // 尾斜杠写法差归一后仍同仓
  ];

  it('REQ 继承压过 fileRefs', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      fileRefs: sameRepoRefs,
      fileStore,
      getProject: async () => ({ gitRepo: '/data/req-repo' }),
    });

    expect(result).toEqual({
      source: 'requirement', workspaceRoot: '/data/req-repo', projectId: 'proj-1',
    });
  });

  it('全部引用同仓（尾斜杠归一）→ source=file-refs，workspaceRoot=归一后的 repo，压过频道机器指针', async () => {
    await setChannelMachine('ws-channel');

    const result = await resolveWorkspaceForWU({
      fileRefs: sameRepoRefs,
      channelId,
      fileStore,
    });

    expect(result).toEqual({
      source: 'file-refs', workspaceRoot: '/data/repo', projectId: null,
    });
  });

  it('跨仓引用不参与归属 → none（频道机器指针不再是 rung）', async () => {
    await setChannelMachine('ws-channel');

    const result = await resolveWorkspaceForWU({
      fileRefs: [
        { repo: '/data/repo-a', path: 'src/a.ts' },
        { repo: '/data/repo-b', path: 'src/b.ts' },
      ],
      channelId,
      fileStore,
    });

    expect(result.source).toBe('none');
  });

  it('空数组等同无引用 → 落下一优先级', async () => {
    const result = await resolveWorkspaceForWU({ fileRefs: [], channelId, fileStore });

    expect(result.source).toBe('none');
  });

  it('无引用输入行为不变：无任何输入 → none', async () => {
    const result = await resolveWorkspaceForWU({ fileStore });

    expect(result).toEqual({ source: 'none', workspaceRoot: null, projectId: null });
  });

  it('仅 fileRefs 同仓、无频道默认 → source=file-refs（不落 none 挂起）', async () => {
    const result = await resolveWorkspaceForWU({ fileRefs: sameRepoRefs, channelId, fileStore });

    expect(result).toEqual({
      source: 'file-refs', workspaceRoot: '/data/repo', projectId: null,
    });
  });

  it('畸形条目（repo 缺失/非字符串）不参与归属 → 落下一优先级', async () => {
    const result = await resolveWorkspaceForWU({
      fileRefs: [
        { repo: '/data/repo', path: 'src/a.ts' },
        { repo: '', path: 'src/b.ts' },
      ],
      channelId,
      fileStore,
    });

    expect(result.source).toBe('none');
  });
});

describe('#272（决策 #251 Q2\'）：频道默认工程 defaultPath 归属 rung', () => {
  async function setChannelDefaultPath(defaultPath: string | null) {
    await fileStore.updateChannel(channelId, { defaultPath });
  }

  it('频道 defaultPath 命中 → source=channel-default-path，workspaceRoot=defaultPath', async () => {
    await setChannelDefaultPath('/data/channel-repo');

    const result = await resolveWorkspaceForWU({ channelId, fileStore });

    expect(result).toEqual({
      source: 'channel-default-path',
      workspaceRoot: '/data/channel-repo',
      projectId: null,
    });
  });

  it('fileRefs（同仓）压过频道 defaultPath', async () => {
    await setChannelDefaultPath('/data/channel-repo');

    const result = await resolveWorkspaceForWU({
      fileRefs: [{ repo: '/data/refs-repo', path: 'src/a.ts' }],
      channelId,
      fileStore,
    });

    expect(result.source).toBe('file-refs');
    expect(result.workspaceRoot).toBe('/data/refs-repo');
  });

  it('defaultPath（默认工程）命中时与 defaultWorkspaceId（机器指针）无关', async () => {
    await setChannelDefaultPath('/data/channel-repo');
    await setChannelMachine('ws-channel');

    const result = await resolveWorkspaceForWU({ channelId, fileStore });

    expect(result.source).toBe('channel-default-path');
    expect(result.workspaceRoot).toBe('/data/channel-repo');
  });

  it('defaultPath 为 null/空串 → 跳过该 rung（defaultWorkspaceId 已退役，落 none）', async () => {
    await setChannelMachine('ws-channel');

    await setChannelDefaultPath(null);
    const nullCase = await resolveWorkspaceForWU({ channelId, fileStore });
    expect(nullCase.source).toBe('none');

    await setChannelDefaultPath('');
    const emptyCase = await resolveWorkspaceForWU({ channelId, fileStore });
    expect(emptyCase.source).toBe('none');
  });

  it('REQ 继承仍压过 defaultPath（第一性归属不变）', async () => {
    await setChannelDefaultPath('/data/channel-repo');
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      channelId,
      fileStore,
      getProject: async () => ({ gitRepo: '/data/req-repo' }),
    });

    expect(result.source).toBe('requirement');
    expect(result.workspaceRoot).toBe('/data/req-repo');
  });
});
