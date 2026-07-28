// §10.5 提交守卫：COMPLETE 打回（worktree 有未提交改动）+ PROGRESS 连续无新提交监视
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；git 调用（execSync）、workspace 解析、CLI 执行 mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

const { mockResolveWorkspaceRoot } = vi.hoisted(() => ({
  mockResolveWorkspaceRoot: vi.fn(),
}));

vi.mock('../../workspaces/workspace-store', () => ({
  resolveWorkspaceRoot: mockResolveWorkspaceRoot,
}));

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../agent-loop';

const mockRole = {
  id: 'role-guard',
  name: 'guard-agent',
  description: 'commit guard test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

const COMMIT_HINT = '有未提交改动，请先 git add/commit 再报告完成';

describe('§10.5: 提交守卫', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-guard-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-guard-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#guard-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 不 start()：recordResult/agentStep 不依赖运行中的 loop 实例
    agentLoop = new AgentLoop(mockRole, fileStore);
    mockResolveWorkspaceRoot.mockResolvedValue('/tmp/fake-worktree');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** git mock：statusOut = `git status --porcelain` 输出；head = `git rev-parse HEAD` 输出 */
  function mockGit(statusOut: string, head: string) {
    mockExecSync.mockImplementation((cmd: string) =>
      String(cmd).includes('rev-parse') ? head : statusOut
    );
  }

  /** 创建 active WorkUnit（绑定 workspace）+ anchor 消息 */
  async function setupWorkUnit(metadata?: WorkUnitMetadata) {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-1', workspaceId: 'ws-1',
      ...(metadata ? { metadata } : {}),
    });
    const anchor: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '@guard-agent 实现登录功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return wu;
  }

  async function progress(wuId: string) {
    const wu = (await wuService.getById(wuId))!;
    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'progress', summary: '继续中' },
    );
  }

  async function metaOf(wuId: string): Promise<WorkUnitMetadata> {
    const wu = (await wuService.getById(wuId))!;
    return JSON.parse(wu.metadata!);
  }

  async function noticeCount(wuId: string): Promise<number> {
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wuId });
    return messages.filter(m => m.authorType === 'agent' && m.content.includes('连续 3 步无新提交')).length;
  }

  it('COMPLETE + 未提交改动 → 打回 progress（保持 active），提示写入 metadata 并注入下一轮 prompt', async () => {
    mockGit(' M src/a.ts\n', 'h1\n');
    const wu = await setupWorkUnit();
    const loop = agentLoop as unknown as RecordResultCapable;

    await loop.recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    // 不进入 in_review，按 progress 处理（摘要仍发到频道）
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.commitGuardHint).toBe(COMMIT_HINT);
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.authorType === 'agent' && m.content.includes('做完了'))).toBe(true);

    // 提示注入下一轮 prompt，注入后即消费
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:继续',
      logFile: '/tmp/log', worktree: '/tmp/wt', outputFiles: [], sessionCount: 1,
    });
    const step = await loop.agentStep({ workUnit: after });
    const prompt = mockExecuteLightweight.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(COMMIT_HINT);
    expect(step.metadataUpdates).toHaveProperty('commitGuardHint', undefined);
  });

  it('首 step COMPLETE：worktreePath 仅在 metadataUpdates（未落库）时，守卫以合并视图检查 worktree 而非主仓库', async () => {
    // cwd 感知 mock：worktree 脏、主仓库干净 —— 修复前守卫查主仓库放行（假 complete）
    mockExecSync.mockImplementation((cmd: string, opts?: { cwd?: string }) => {
      if (String(cmd).includes('rev-parse')) return 'h1\n';
      return opts?.cwd === '/tmp/wt-dirty' ? ' M README.md\n' : '';
    });
    mockResolveWorkspaceRoot.mockResolvedValue('/tmp/main-clean');
    const wu = await setupWorkUnit(); // 持久化 metadata 无 worktreePath（首 step 未落库）

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      {
        action: 'complete',
        summary: '做完了',
        metadataUpdates: {
          worktreePath: '/tmp/wt-dirty',
          worktreeBranch: 'task/x',
          worktreeBaseBranch: 'master',
          worktreeBaseRepo: '/tmp/main-clean',
        },
      },
    );

    // 守卫应命中 worktree 的脏状态 → 打回 progress（保持 active）
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.commitGuardHint).toBe(COMMIT_HINT);
    // 本 step 的 worktree 落档仍正常写入
    expect(meta.worktreePath).toBe('/tmp/wt-dirty');
  });

  it('COMPLETE + 干净 worktree → 正常进入 in_review', async () => {
    mockGit('', 'h1\n');
    const wu = await setupWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '做完了' },
    );

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('in_review');
    expect(JSON.parse(after.metadata!).commitGuardHint).toBeUndefined();
  });

  it('COMPLETE + git 调用失败 → 静默跳过守卫，正常完成', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repository'); });
    const wu = await setupWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '做完了' },
    );

    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('workspace 路径解析失败 → 静默跳过守卫，正常完成', async () => {
    mockResolveWorkspaceRoot.mockResolvedValue(null);
    const wu = await setupWorkUnit();

    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action: 'complete', summary: '做完了' },
    );

    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('PROGRESS 无提交监视：首次记录 HEAD，相同累加，新提交归零', async () => {
    let head = 'h1';
    mockGit('', head);
    mockExecSync.mockImplementation((cmd: string) =>
      String(cmd).includes('rev-parse') ? head : ''
    );
    const wu = await setupWorkUnit();

    await progress(wu.id); // 首次：记录 HEAD
    let meta = await metaOf(wu.id);
    expect(meta.lastCommitHash).toBe('h1');
    expect(meta.noCommitSteps).toBe(0);

    await progress(wu.id); // 相同 → 1
    meta = await metaOf(wu.id);
    expect(meta.noCommitSteps).toBe(1);

    await progress(wu.id); // 相同 → 2
    meta = await metaOf(wu.id);
    expect(meta.noCommitSteps).toBe(2);

    head = 'h2'; // 新提交 → 归零并更新 hash
    await progress(wu.id);
    meta = await metaOf(wu.id);
    expect(meta.lastCommitHash).toBe('h2');
    expect(meta.noCommitSteps).toBe(0);
    expect(await noticeCount(wu.id)).toBe(0);
  });

  it('连续 3 步无新提交 → 频道提醒一次并归零，之后每 3 步再提醒', async () => {
    mockGit('', 'h1\n');
    const wu = await setupWorkUnit({ lastCommitHash: 'h1' });

    await progress(wu.id);
    await progress(wu.id);
    expect(await noticeCount(wu.id)).toBe(0);
    await progress(wu.id); // 第 3 步 → 提醒

    expect(await noticeCount(wu.id)).toBe(1);
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.content.includes('连续 3 步无新提交'))!;
    expect(notice.content).toContain(wu.id);
    expect(notice.authorType).toBe('agent');
    expect((await metaOf(wu.id)).noCommitSteps).toBe(0);

    // 归零后重新累计，再走 3 步 → 第二次提醒
    await progress(wu.id);
    await progress(wu.id);
    await progress(wu.id);
    expect(await noticeCount(wu.id)).toBe(2);
  });

  it('PROGRESS + git 调用失败 → 静默跳过（metadata 不变，无提醒）', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('git down'); });
    const wu = await setupWorkUnit({ lastCommitHash: 'h1', noCommitSteps: 2 });

    await progress(wu.id);

    const meta = await metaOf(wu.id);
    expect(meta.lastCommitHash).toBe('h1');
    expect(meta.noCommitSteps).toBe(2);
    expect(await noticeCount(wu.id)).toBe(0);
  });
});
