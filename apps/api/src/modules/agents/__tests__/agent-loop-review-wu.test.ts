// P1: review 类 WU 守卫豁免 —— 提交守卫对 review 直接跳过（评审职责是读不是写，
// cwd 解析到父 WU worktree，dev 的提交/工具产物与评审无关）；stepCount 上限放宽到 30，
// 保证 COMPLETE 能走 in_review→done 自动收口（超 30 仍有安全阀强制 in_review）。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；git 调用（execSync）、workspace 解析 mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
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

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: vi.fn(),
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop } from '../loop/agent-loop';

const mockRole = {
  id: 'role-reviewer',
  name: 'reviewer-agent',
  description: 'review wu exemption test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
}

describe('P1: review WU 守卫豁免', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-review-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-review-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#review-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);
    mockResolveWorkspaceRoot.mockResolvedValue('/tmp/fake-worktree');
    // 父 worktree 有未提交改动（dev 已提交后残留的工具产物）—— 对 review WU 应无影响
    mockExecSync.mockImplementation((cmd: string) =>
      String(cmd).includes('rev-parse') ? 'h1\n' : ' M src/a.ts\n'
    );
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 父 WU（task，带 worktree）+ review 子 WU（active） */
  async function setupReviewWu(metadata?: WorkUnitMetadata) {
    const parent = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-dev', workspaceId: 'ws-1',
      metadata: { worktreePath: '/tmp/fake-worktree' },
    });
    const reviewWu = await wuService.create({
      scope: '评审登录功能实现', channelId, type: 'review',
      status: 'active', assigneeId: 'instance-reviewer', workspaceId: 'ws-1',
      parentId: parent.id,
      ...(metadata ? { metadata } : {}),
    });
    return { parent, reviewWu };
  }

  async function record(wuId: string, action: string, summary = '结果') {
    const wu = (await wuService.getById(wuId))!;
    await (agentLoop as unknown as RecordResultCapable).recordResult(
      { workUnit: wu },
      { action, summary },
    );
    return (await wuService.getById(wuId))!;
  }

  it('review WU + 父 worktree 有未提交改动 + COMPLETE → 不打回，in_review → done 自动收口，且全程不碰 git', async () => {
    const { reviewWu } = await setupReviewWu();

    const after = await record(reviewWu.id, 'complete', 'LGTM，评审通过');

    expect(after.status).toBe('done');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.commitGuardHint).toBeUndefined();
    // 豁免 = 连 git status / rev-parse 都不该调用
    expect(mockExecSync).not.toHaveBeenCalled();
    const messages = await fileStore.queryMessages(channelId, { workUnitId: reviewWu.id });
    expect(messages.some(m => m.authorType === 'agent' && m.content.includes('LGTM'))).toBe(true);
  });

  it('review WU + PROGRESS → 不做无提交监视（不调用 git，不写 lastCommitHash/noCommitSteps）', async () => {
    const { reviewWu } = await setupReviewWu();

    const after = await record(reviewWu.id, 'progress', '还在看代码');

    expect(after.status).toBe('active');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.lastCommitHash).toBeUndefined();
    expect(meta.noCommitSteps).toBeUndefined();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('review WU stepCount 超 15 未超 30 时 COMPLETE → 不被强制拦截，仍走 complete → done 收口', async () => {
    const { reviewWu } = await setupReviewWu({ stepCount: 15 });

    const after = await record(reviewWu.id, 'complete', '评审通过');

    expect(after.status).toBe('done');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: reviewWu.id });
    expect(messages.some(m => m.content.includes('步骤数超限'))).toBe(false);
  });

  it('review WU stepCount 超 30 → 安全阀仍生效：强制 in_review 交人工', async () => {
    const { reviewWu } = await setupReviewWu({ stepCount: 30 });

    const after = await record(reviewWu.id, 'progress', '仍在评审');

    expect(after.status).toBe('in_review');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: reviewWu.id });
    expect(messages.some(m => m.content.includes('步骤数超限'))).toBe(true);
  });

  it('代码类 WU stepCount 超 15 → 强制 in_review（原行为不回归）', async () => {
    const wu = await wuService.create({
      scope: '实现登录功能', channelId, type: 'task',
      status: 'active', assigneeId: 'instance-dev', workspaceId: 'ws-1',
      metadata: { stepCount: 15 },
    });

    const after = await record(wu.id, 'progress', '继续中');

    expect(after.status).toBe('in_review');
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('步骤数超限'))).toBe(true);
  });
});
