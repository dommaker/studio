// B3b-i: 每 WU worktree 隔离 + COMPLETE 前自动验证
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；git（execSync）、验证命令（execSh）、
// worktree 创建（ensureWuWorktree）、CLI 执行（executeLightweight）、workspace 解析均 mock
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

const { mockExecSh } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execSh: mockExecSh };
});

const { mockResolveWorkspaceRoot, mockGetWorkspaceRecord } = vi.hoisted(() => ({
  mockResolveWorkspaceRoot: vi.fn(),
  mockGetWorkspaceRecord: vi.fn(),
}));

vi.mock('../../workspaces/workspace-store', () => ({
  resolveWorkspaceRoot: mockResolveWorkspaceRoot,
  getWorkspaceRecord: mockGetWorkspaceRecord,
}));

const { mockExecuteLightweight, mockEnsureWuWorktree } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
  mockEnsureWuWorktree: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
  ensureWuWorktree: mockEnsureWuWorktree,
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
  id: 'role-wt',
  name: 'wt-agent',
  description: 'worktree verify test agent',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface LoopPrivates {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{
    action: string;
    summary: string;
    metadataUpdates?: Partial<WorkUnitMetadata>;
  }>;
}

describe('B3b-i: 每 WU worktree 隔离 + 自动验证', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;
  let repoRoot: string;    // 共享 git 仓库根（带 .git）
  let worktreeDir: string; // 伪造的 WU worktree

  const WT = () => worktreeDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-b3b-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-b3b-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#b3b-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    agentLoop = new AgentLoop(mockRole, fileStore);

    // 真实目录：repoRoot 带 .git（isGitRepoRoot 通过）；worktreeDir 放 package.json 等验证素材
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b3b-repo-'));
    fs.mkdirSync(path.join(repoRoot, '.git'));
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3b-wt-'));

    // 默认：git 干净；ensureWuWorktree 返回专属 worktree；CLI 成功
    mockExecSync.mockImplementation((cmd: string) =>
      String(cmd).includes('rev-parse') ? 'h1\n' : ''
    );
    mockEnsureWuWorktree.mockImplementation(async ({ wuId, repoDir, baseBranch }: { wuId: string; repoDir: string; baseBranch?: string }) => ({
      worktreePath: WT(),
      branch: `task/${wuId}`,
      baseBranch: baseBranch ?? 'main',
      baseRepo: repoDir,
    }));
    mockExecuteLightweight.mockResolvedValue({
      success: true, outputText: 'ACTION: PROGRESS:继续',
      logFile: '/tmp/log', worktree: WT(), outputFiles: [], sessionCount: 1,
    });
    mockExecSh.mockResolvedValue({ stdout: 'ok', stderr: '' });
    mockResolveWorkspaceRoot.mockResolvedValue(null);
    mockGetWorkspaceRecord.mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  async function createWu(type: string, metadata?: WorkUnitMetadata, extra?: Record<string, unknown>) {
    const wu = await wuService.create({
      scope: '实现功能', channelId, type,
      status: 'active', assigneeId: 'instance-1',
      ...(extra ?? {}),
      ...(metadata ? { metadata } : {}),
    });
    const anchor: ChannelMessageData = {
      id: uuidv4(), channelId, authorType: 'human', agentName: null,
      content: '@wt-agent 实现功能', replyToId: null, meta: '{}',
      workUnitId: wu.id, createdAt: new Date().toISOString(),
    };
    await fileStore.appendMessage(channelId, anchor);
    return wu;
  }

  async function metaOf(wuId: string): Promise<WorkUnitMetadata> {
    const wu = (await wuService.getById(wuId))!;
    return JSON.parse(wu.metadata!);
  }

  async function channelTexts(wuId: string): Promise<string[]> {
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wuId });
    return messages.filter(m => m.authorType === 'agent').map(m => m.content);
  }

  const loop = () => agentLoop as unknown as LoopPrivates;

  // ─── 改造项 1：专属 worktree 执行 ───

  it('代码类 WU 首个 step：创建专属 worktree，cwd 不再指向共享目录，元数据落档', async () => {
    const wu = await createWu('task', { workspaceRoot: repoRoot });

    const step = await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).toHaveBeenCalledWith(expect.objectContaining({
      wuId: wu.id,
      repoDir: repoRoot,
      baseBranch: undefined,
    }));
    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.parameters.workspaceRoot).toBe(WT());
    expect(task.parameters.workspaceRoot).not.toBe(repoRoot);
    expect(step.metadataUpdates).toMatchObject({
      worktreePath: WT(),
      worktreeBranch: `task/${wu.id}`,
      worktreeBaseBranch: 'main',
      worktreeBaseRepo: repoRoot,
    });
  });

  it('同一 WU 后续 step：复用 metadata 中的 worktree（不重复落档，baseBranch 沿用记录）', async () => {
    const wu = await createWu('bug', {
      workspaceRoot: repoRoot,
      worktreePath: WT(),
      worktreeBranch: `task/x`,
      worktreeBaseBranch: 'release/1.0',
      worktreeBaseRepo: repoRoot,
    });

    const step = await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).toHaveBeenCalledWith(expect.objectContaining({
      wuId: wu.id,
      baseBranch: 'release/1.0',
    }));
    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.parameters.workspaceRoot).toBe(WT());
    expect(step.metadataUpdates?.worktreePath).toBeUndefined();
  });

  it('worktree 创建失败：走失败分支（action=failed），不执行 CLI、不退回共享目录', async () => {
    mockEnsureWuWorktree.mockRejectedValue(new Error('git worktree add failed'));
    const wu = await createWu('task', { workspaceRoot: repoRoot });

    const step = await loop().agentStep({ workUnit: wu });

    expect(step.action).toBe('failed');
    expect(step.metadataUpdates?.errorType).toBe('worktree_creation_failed');
    expect(mockExecuteLightweight).not.toHaveBeenCalled();

    // recordResult：记 consecutiveStuck，不发频道消息，状态保持 active
    await loop().recordResult({ workUnit: wu }, step);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const meta = await metaOf(wu.id);
    expect(meta.consecutiveStuck).toBe(1);
    expect(meta.errorType).toBe('worktree_creation_failed');
    expect(await channelTexts(wu.id)).toHaveLength(0);
  });

  it('非代码类 WU（analysis）：不建 worktree，维持共享目录 cwd', async () => {
    const wu = await createWu('analysis', { workspaceRoot: repoRoot });

    await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
    expect(mockExecuteLightweight.mock.calls[0][0].parameters.workspaceRoot).toBe(repoRoot);
  });

  it('绑定根不是 git 仓库（无 .git）：不建 worktree，维持现状', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3b-plain-'));
    try {
      const wu = await createWu('task', { workspaceRoot: plainDir });

      await loop().agentStep({ workUnit: wu });

      expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
      expect(mockExecuteLightweight.mock.calls[0][0].parameters.workspaceRoot).toBe(plainDir);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('review WU：父 metadata 有 worktreePath → 评审在父 worktree 执行', async () => {
    const parent = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });
    const reviewWu = await createWu('review', undefined, { parentId: parent.id });

    await loop().agentStep({ workUnit: reviewWu });

    expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
    expect(mockExecuteLightweight.mock.calls[0][0].parameters.workspaceRoot).toBe(WT());
  });

  it('review WU：父无 worktreePath → 维持现状（不传 workspaceRoot）', async () => {
    const parent = await createWu('task');
    const reviewWu = await createWu('review', undefined, { parentId: parent.id });

    await loop().agentStep({ workUnit: reviewWu });

    expect(mockExecuteLightweight.mock.calls[0][0].parameters.workspaceRoot).toBeUndefined();
  });

  it('提交守卫在 worktree 路径下跑 git status', async () => {
    mockExecSync.mockImplementation((cmd: string) =>
      String(cmd).includes('rev-parse') ? 'h1\n' : ' M src/a.ts\n'
    );
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSync).toHaveBeenCalledWith(
      'git status --porcelain',
      expect.objectContaining({ cwd: WT() }),
    );
    expect((await wuService.getById(wu.id))!.status).toBe('active'); // 打回 progress
  });

  // ─── 改造项 2：COMPLETE 前自动验证 ───

  it('验证覆盖（metadata.verifyCommands）> 约定：全绿 → in_review + verifyReport + 频道简报', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    const wu = await createWu('feature', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['make check', './scripts/ci.sh'],
    });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSh).toHaveBeenCalledTimes(2);
    expect(mockExecSh).toHaveBeenNthCalledWith(1, 'make check', expect.objectContaining({ cwd: WT(), timeoutMs: 600_000 }));
    expect(mockExecSh).toHaveBeenNthCalledWith(2, './scripts/ci.sh', expect.objectContaining({ cwd: WT(), timeoutMs: 600_000 }));
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    const meta = await metaOf(wu.id);
    expect(meta.verifyReport).toMatchObject({ commands: ['make check', './scripts/ci.sh'], source: 'override' });
    expect(meta.verifyFailCount).toBe(0);
    const texts = await channelTexts(wu.id);
    expect(texts.some(t => t.includes('自动验证通过') && t.includes('make check'))).toBe(true);
  });

  it('验证覆盖（workspace 记录 verifyCommands）：metadata 无覆盖时取用', async () => {
    mockGetWorkspaceRecord.mockResolvedValue({ id: 'ws-1', verifyCommands: ['./ci.sh'] });
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() }, { workspaceId: 'ws-1' });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSh).toHaveBeenCalledWith('./ci.sh', expect.objectContaining({ cwd: WT() }));
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).verifyReport?.source).toBe('override');
  });

  it('约定：package.json 有 test/typecheck/lint 时依次跑（pnpm-lock → pnpm）', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({
      scripts: { test: 'vitest', typecheck: 'tsc', lint: 'eslint .', build: 'x' },
    }));
    fs.writeFileSync(path.join(WT(), 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSh.mock.calls.map(c => c[0])).toEqual(['pnpm run test', 'pnpm run typecheck', 'pnpm run lint']);
    expect((await metaOf(wu.id)).verifyReport?.source).toBe('convention');
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('约定：无 lockfile → npm；只有部分 script 时只跑存在的', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSh.mock.calls.map(c => c[0])).toEqual(['npm run test']);
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('无 package.json / 无可跑 script → 跳过验证，正常 in_review', async () => {
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSh).not.toHaveBeenCalled();
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).verifyReport).toBeUndefined();
  });

  it('验证失败 → 降级 progress：失败命令+输出尾部（截 2000）注入下一轮 prompt，verifyFailCount 计数', async () => {
    const longOutput = `header-${'x'.repeat(3000)}-tail-marker`;
    const err = Object.assign(new Error('Command exited with code 1'), { stderr: longOutput, stdout: '' });
    mockExecSh.mockRejectedValue(err);
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(), verifyCommands: ['make check'],
    });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect((await wuService.getById(wu.id))!.status).toBe('active');
    const meta = await metaOf(wu.id);
    expect(meta.verifyFailCount).toBe(1);
    expect(meta.verifyFailHint).toContain('make check');
    expect(meta.verifyFailHint).toContain('tail-marker');
    expect(meta.verifyFailHint!.length).toBeLessThan(2_200); // 尾部截断生效（含提示头）

    // 提示注入下一轮 prompt，注入后即消费
    const step = await loop().agentStep({ workUnit: (await wuService.getById(wu.id))! });
    const prompt = mockExecuteLightweight.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('## 验证失败');
    expect(prompt).toContain('make check');
    expect(step.metadataUpdates).toHaveProperty('verifyFailHint', undefined);
  });

  it('验证连续失败 3 次 → blocked 并频道说明', async () => {
    mockExecSh.mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'boom' }));
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(), verifyCommands: ['make check'],
    });

    for (let i = 0; i < 2; i++) {
      await loop().recordResult({ workUnit: (await wuService.getById(wu.id))! }, { action: 'complete', summary: '做完了' });
      expect((await wuService.getById(wu.id))!.status).toBe('active');
    }
    await loop().recordResult({ workUnit: (await wuService.getById(wu.id))! }, { action: 'complete', summary: '做完了' });

    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
    expect((await metaOf(wu.id)).verifyFailCount).toBe(3);
    const texts = await channelTexts(wu.id);
    expect(texts.some(t => t.includes('自动验证连续失败 3 次') && t.includes('blocked'))).toBe(true);
  });

  it('review WU（非代码类）：跳过自动验证，维持现状', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    const parent = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });
    const reviewWu = await createWu('review', { workspaceRoot: repoRoot, worktreePath: WT() }, { parentId: parent.id });

    await loop().recordResult({ workUnit: reviewWu }, { action: 'complete', summary: 'REVIEW_RESULT: {"verdict":"pass"}' });

    expect(mockExecSh).not.toHaveBeenCalled();
    // review 子 WU complete 直接收口 done（P0 修复路径）
    expect((await wuService.getById(reviewWu.id))!.status).toBe('done');
  });

  // ─── F6-c 断点 1：步骤超限强制收口补跑 L1 ───

  it('强制收口（progress 超限）：代码类 + worktree + 验证全绿 → in_review + l1 approved + verifyReport', async () => {
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['make check'], stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect(mockExecSh).toHaveBeenCalledTimes(1);
    expect(mockExecSh).toHaveBeenCalledWith('make check', expect.objectContaining({ cwd: WT(), timeoutMs: 600_000 }));
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    const meta = await metaOf(wu.id);
    expect(meta.attestations?.l1?.verdict).toBe('approved');
    expect(meta.attestations?.l1?.kind).toBe('verify');
    expect(meta.verifyReport?.commands).toEqual(['make check']);
    const texts = await channelTexts(wu.id);
    expect(texts.some(t => t.includes('步骤数超限'))).toBe(true);
  });

  it('强制收口（progress 超限）：验证失败 → 仍 in_review + l1 rejected，不计 verifyFailCount、不写 verifyReport', async () => {
    mockExecSh.mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'boom' }));
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['make check'], stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    const meta = await metaOf(wu.id);
    expect(meta.attestations?.l1?.verdict).toBe('rejected');
    expect(meta.attestations?.l1?.summary).toContain('make check');
    expect(meta.verifyFailCount).toBeUndefined();
    expect(meta.verifyReport).toBeUndefined();
  });

  it('强制收口：非代码类（analysis）即使有 worktree 落档也不跑验证、不落 l1', async () => {
    const wu = await createWu('analysis', {
      workspaceRoot: repoRoot, worktreePath: WT(), stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect(mockExecSh).not.toHaveBeenCalled();
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).attestations?.l1).toBeUndefined();
  });

  it('强制收口：代码类但无 worktree → 不跑验证、不落 l1（维持现状）', async () => {
    const wu = await createWu('task', { workspaceRoot: repoRoot, stepCount: 15 });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect(mockExecSh).not.toHaveBeenCalled();
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).attestations?.l1).toBeUndefined();
  });

  it('超限 + COMPLETE：COMPLETE 守卫本 step 已跑验证 → 强制收口不重复跑（execSh 仅一次）', async () => {
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['make check'], stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecSh).toHaveBeenCalledTimes(1);
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).attestations?.l1?.verdict).toBe('approved');
  });
});
