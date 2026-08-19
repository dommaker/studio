/**
 * B3a 工程归属链（决策 D2）— resolveWorkspaceForWU 优先级链测试
 *
 * 覆盖：显式 workspaceId > Requirement.projectId → PMO gitRepo > 频道 defaultWorkspaceId > none；
 * 各步独立容错（需求缺失 / 项目缺失 / 无 gitRepo / 查询抛错 → 落下一优先级）。
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
  // projectExists stub：挂接 projectId 不碰真实 ~/.studio/projects
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

async function setChannelDefault(workspaceId: string | null) {
  await fileStore.updateChannel(channelId, { defaultWorkspaceId: workspaceId });
}

describe('resolveWorkspaceForWU（B3a 优先级链）', () => {
  it('显式 workspaceId 最高优先：压过 Requirement 与频道默认', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({
      explicitWorkspaceId: 'ws-explicit',
      reqId: req.id,
      channelId,
      fileStore,
      getProject: async () => ({ gitRepo: '/data/repo' }),
    });

    expect(result).toEqual({
      source: 'explicit', workspaceId: 'ws-explicit', workspaceRoot: null, projectId: null,
    });
  });

  it('Requirement.projectId + PMO gitRepo → source=requirement，gitRepo 作 workspaceRoot', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });
    await setChannelDefault('ws-channel'); // 频道默认存在但被 Requirement 压过

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      channelId,
      fileStore,
      getProject: async id => (id === 'proj-1' ? { gitRepo: '/data/repo' } : null),
    });

    expect(result).toEqual({
      source: 'requirement', workspaceId: null, workspaceRoot: '/data/repo', projectId: 'proj-1',
    });
  });

  it('Requirement 无 projectId → 落频道默认', async () => {
    const req = await reqService.create({ title: 'r' });
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({ reqId: req.id, channelId, fileStore });

    expect(result).toEqual({
      source: 'channel-default', workspaceId: 'ws-channel', workspaceRoot: null, projectId: null,
    });
  });

  it('PMO 项目无 gitRepo → 落频道默认', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      channelId,
      fileStore,
      getProject: async () => ({ gitRepo: null }),
    });

    expect(result.source).toBe('channel-default');
    expect(result.workspaceId).toBe('ws-channel');
  });

  it('PMO 项目不存在 / 查询抛错 → 落频道默认（容错）', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-gone' });
    await setChannelDefault('ws-channel');

    const notFound = await resolveWorkspaceForWU({
      reqId: req.id, channelId, fileStore, getProject: async () => null,
    });
    expect(notFound.source).toBe('channel-default');

    const thrown = await resolveWorkspaceForWU({
      reqId: req.id, channelId, fileStore,
      getProject: async () => { throw new Error('boom'); },
    });
    expect(thrown.source).toBe('channel-default');
  });

  it('reqId 指向不存在的 REQ → 落频道默认', async () => {
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({ reqId: 'REQ-9999', channelId, fileStore });

    expect(result.source).toBe('channel-default');
  });

  it('REQ 无 projectId 且频道无默认 → none（调用方转 NEED_INPUT）', async () => {
    const req = await reqService.create({ title: 'r' });

    const result = await resolveWorkspaceForWU({ reqId: req.id, channelId, fileStore });

    expect(result).toEqual({ source: 'none', workspaceId: null, workspaceRoot: null, projectId: null });
  });

  it('无任何输入 → none', async () => {
    const result = await resolveWorkspaceForWU({ fileStore });

    expect(result.source).toBe('none');
  });

  it('OWNERSHIP_WAITING_QUESTION 文案（挂起提问口径）', () => {
    expect(OWNERSHIP_WAITING_QUESTION).toBe('这个任务要修改哪个工程？请回复工程名或路径');
  });
});

describe('#285（决策 #249 §4）：fileRefs 归属 rung（显式 > REQ 继承 > 文件引用 > 频道默认 > none）', () => {
  const sameRepoRefs = [
    { repo: '/data/repo', path: 'src/a.ts' },
    { repo: '/data/repo/', path: 'src/b.ts' }, // 尾斜杠写法差归一后仍同仓
  ];

  it('显式 workspaceId 压过 fileRefs', async () => {
    const result = await resolveWorkspaceForWU({
      explicitWorkspaceId: 'ws-explicit',
      fileRefs: sameRepoRefs,
      fileStore,
    });

    expect(result).toEqual({
      source: 'explicit', workspaceId: 'ws-explicit', workspaceRoot: null, projectId: null,
    });
  });

  it('REQ 继承压过 fileRefs', async () => {
    const req = await reqService.create({ title: 'r', projectId: 'proj-1' });

    const result = await resolveWorkspaceForWU({
      reqId: req.id,
      fileRefs: sameRepoRefs,
      fileStore,
      getProject: async () => ({ gitRepo: '/data/req-repo' }),
    });

    expect(result).toEqual({
      source: 'requirement', workspaceId: null, workspaceRoot: '/data/req-repo', projectId: 'proj-1',
    });
  });

  it('全部引用同仓（尾斜杠归一）→ source=file-refs，workspaceRoot=归一后的 repo，压过频道默认', async () => {
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({
      fileRefs: sameRepoRefs,
      channelId,
      fileStore,
    });

    expect(result).toEqual({
      source: 'file-refs', workspaceId: null, workspaceRoot: '/data/repo', projectId: null,
    });
  });

  it('跨仓引用不参与归属 → 落频道默认', async () => {
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({
      fileRefs: [
        { repo: '/data/repo-a', path: 'src/a.ts' },
        { repo: '/data/repo-b', path: 'src/b.ts' },
      ],
      channelId,
      fileStore,
    });

    expect(result).toEqual({
      source: 'channel-default', workspaceId: 'ws-channel', workspaceRoot: null, projectId: null,
    });
  });

  it('空数组等同无引用 → 落频道默认', async () => {
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({ fileRefs: [], channelId, fileStore });

    expect(result.source).toBe('channel-default');
  });

  it('无引用输入行为不变：无任何输入 → none', async () => {
    const result = await resolveWorkspaceForWU({ fileStore });

    expect(result).toEqual({ source: 'none', workspaceId: null, workspaceRoot: null, projectId: null });
  });

  it('仅 fileRefs 同仓、无频道默认 → source=file-refs（不落 none 挂起）', async () => {
    const result = await resolveWorkspaceForWU({ fileRefs: sameRepoRefs, channelId, fileStore });

    expect(result).toEqual({
      source: 'file-refs', workspaceId: null, workspaceRoot: '/data/repo', projectId: null,
    });
  });

  it('畸形条目（repo 缺失/非字符串）不参与归属 → 落频道默认', async () => {
    await setChannelDefault('ws-channel');

    const result = await resolveWorkspaceForWU({
      fileRefs: [
        { repo: '/data/repo', path: 'src/a.ts' },
        { repo: '', path: 'src/b.ts' },
      ],
      channelId,
      fileStore,
    });

    expect(result.source).toBe('channel-default');
  });
});
