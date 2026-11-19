// B3b-i: 每 WU worktree 隔离 + COMPLETE 前自动验证
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；git（execSync）、固定验证 argv（execFile）、
// worktree 创建（ensureWuWorktree）、CLI 执行（executeLightweight）、workspace 解析均 mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit-review.js';
import type { WorkUnitMetadata } from '../../workunit/workunit.types.js';

const { mockExecSync, mockExecFile } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  execFile: mockExecFile,
  // 健康探针已迁 execAsync（回调式 exec）：默认立即成功回调，兼容 2/3 参调用形态
  exec: vi.fn((cmd: any, opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (typeof callback === 'function') callback(null, '', '');
  }),
}));

const { mockHostExecFile, mockExecSh } = vi.hoisted(() => ({
  mockHostExecFile: vi.fn(),
  mockExecSh: vi.fn(),
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execFile: mockHostExecFile, execSh: mockExecSh };
});

const { mockResolveWorkspaceRoot, mockGetWorkspaceRecord } = vi.hoisted(() => ({
  mockResolveWorkspaceRoot: vi.fn(),
  mockGetWorkspaceRecord: vi.fn(),
}));

vi.mock('../../workspaces/workspace-store', () => ({
  resolveWorkspaceRoot: mockResolveWorkspaceRoot,
  getWorkspaceRecord: mockGetWorkspaceRecord,
}));

const {
  mockExecuteLightweight,
  mockEnsureWuWorktree,
  mockEnsureBranchExists,
  mockGetDefaultBranch,
  mockResolvePmoBranchForWU,
  mockResolvePmoProjectIdForWU,
} = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
  mockEnsureWuWorktree: vi.fn(),
  mockEnsureBranchExists: vi.fn(),
  mockGetDefaultBranch: vi.fn(() => 'main'),
  mockResolvePmoBranchForWU: vi.fn(),
  mockResolvePmoProjectIdForWU: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
  ensureWuWorktree: mockEnsureWuWorktree,
  ensureBranchExists: mockEnsureBranchExists,
  getDefaultBranch: mockGetDefaultBranch,
}));

vi.mock('../../requirements/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../requirements/index.js')>(),
  resolvePmoBranchForWU: mockResolvePmoBranchForWU,
  resolvePmoProjectIdForWU: mockResolvePmoProjectIdForWU,
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
  let worktreeDir: string; // 当前 WU 的受控 worktree
  let worktreesRoot: string;
  let previousWorktreesDir: string | undefined;
  let previousGitRoots: string | undefined;

  const WT = () => worktreeDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    // 收口守卫的 git 探针已改 execFile 异步出口：默认干净（旧口径 = execSync 未设 impl 时
    // 返回 undefined 触发 fail-open 视为干净；execFile 不回 callback 会挂起 promise，必须显式回）
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
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
    worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b3b-wt-'));
    worktreeDir = path.join(worktreesRoot, 'staging');
    fs.mkdirSync(worktreeDir);
    previousWorktreesDir = process.env.WORKTREES_DIR;
    process.env.WORKTREES_DIR = worktreesRoot;
    previousGitRoots = process.env.PMO_GIT_REPO_ROOTS;
    process.env.PMO_GIT_REPO_ROOTS = os.tmpdir();

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
    mockExecuteLightweight.mockImplementation(async (task: { parameters?: Record<string, unknown> }) => {
      const workspaceRoot = task.parameters?.workspaceRoot;
      if (typeof workspaceRoot === 'string' && workspaceRoot.startsWith(`/proc/${process.pid}/fd/`)) {
        // 在 capability 仍有效时解析，后续断言继续检查语义目录而非 fd 编号。
        task.parameters!.workspaceRoot = fs.realpathSync(workspaceRoot);
      }
      return {
        success: true, outputText: 'ACTION: PROGRESS:继续',
        logFile: '/tmp/log', worktree: WT(), outputFiles: [], sessionCount: 1,
      };
    });
    mockHostExecFile.mockResolvedValue({ stdout: 'ok', stderr: '' });
    mockResolvePmoBranchForWU.mockResolvedValue(null);
    mockResolvePmoProjectIdForWU.mockResolvedValue(null);
    mockEnsureBranchExists.mockResolvedValue(undefined);
    mockResolveWorkspaceRoot.mockResolvedValue(null);
    mockGetWorkspaceRecord.mockResolvedValue(null);
  });

  afterEach(() => {
    if (previousWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
    else process.env.WORKTREES_DIR = previousWorktreesDir;
    if (previousGitRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
    else process.env.PMO_GIT_REPO_ROOTS = previousGitRoots;
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
  });

  async function createWu(type: string, metadata?: WorkUnitMetadata, extra?: Record<string, unknown>) {
    let wu = await wuService.create({
      scope: '实现功能', channelId, type,
      status: 'active', assigneeId: 'instance-1',
      ...(extra ?? {}),
      ...(metadata ? { metadata } : {}),
    });
    if (metadata?.worktreePath) {
      if (worktreeDir === path.join(worktreesRoot, 'staging')) {
        const canonical = path.join(worktreesRoot, `wu-${wu.id}`);
        fs.renameSync(worktreeDir, canonical);
        worktreeDir = canonical;
      }
      if (metadata.verifyCommands && !fs.existsSync(path.join(WT(), 'package.json'))) {
        // 遗留自定义字段只作篡改夹具；固定 test 模板用于证明它不会成为执行定义。
        fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
      }
      wu = await wuService.update(wu.id, { metadata: { ...metadata, worktreePath: WT() } });
    }
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

  const loop = () => agentLoop;

  // ─── 改造项 1：专属 worktree 执行 ───

  it('代码类 WU 首个 step：创建专属 worktree，cwd 不再指向共享目录，元数据落档', async () => {
    const wu = await createWu('task', { workspaceRoot: repoRoot });

    const step = await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).toHaveBeenCalledWith(expect.objectContaining({
      wuId: wu.id,
      repoDir: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/),
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

  it('#701 PMO 代码 WU：任务分支从匹配腿 branch 创建并落档', async () => {
    mockResolvePmoBranchForWU.mockResolvedValue({
      projectId: 'proj-1', branch: 'PMO-leg-a', deliveryPolicy: 'auto-merge',
    });
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, pmoId: 'proj-1', pmoBranch: 'PMO-leg-a',
    });

    const step = await loop().agentStep({ workUnit: wu });

    expect(mockEnsureBranchExists).toHaveBeenCalledWith(expect.objectContaining({
      branch: 'PMO-leg-a', baseBranch: 'main',
    }));
    expect(mockEnsureWuWorktree).toHaveBeenCalledWith(expect.objectContaining({
      wuId: wu.id, baseBranch: 'PMO-leg-a',
    }));
    expect(step.metadataUpdates).toMatchObject({
      worktreeBaseBranch: 'PMO-leg-a', worktreeBaseRepo: repoRoot, pmoBranch: 'PMO-leg-a',
    });
  });

  it('#701 多腿 PMO WU 未声明 pmoBranch 且腿解析失败：同样不默认 base', async () => {
    mockResolvePmoProjectIdForWU.mockResolvedValue('proj-1');
    const wu = await createWu('task', { workspaceRoot: repoRoot, pmoId: 'proj-1' });

    const step = await loop().agentStep({ workUnit: wu });

    expect(step.action).toBe('failed');
    expect(step.metadataUpdates?.errorType).toBe('worktree_creation_failed');
    expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
    expect(mockExecuteLightweight).not.toHaveBeenCalled();
  });

  it('#701 已声明 pmoBranch 但腿解析或建支失败：不默认 base、不执行 CLI', async () => {
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, pmoId: 'proj-1', pmoBranch: 'PMO-missing-leg',
    });

    const unresolved = await loop().agentStep({ workUnit: wu });
    expect(unresolved.action).toBe('failed');
    expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
    expect(mockExecuteLightweight).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockResolvePmoBranchForWU.mockResolvedValue({
      projectId: 'proj-1', branch: 'PMO-leg-a', deliveryPolicy: 'auto-merge',
    });
    mockEnsureBranchExists.mockRejectedValue(new Error('cannot create leg'));
    mockEnsureWuWorktree.mockResolvedValue({ worktreePath: WT(), branch: 'task/x', baseBranch: 'main', baseRepo: repoRoot });
    mockExecuteLightweight.mockResolvedValue({ success: true, outputText: 'ACTION: PROGRESS:x', outputFiles: [] });

    const ensureFailed = await loop().agentStep({ workUnit: wu });
    expect(ensureFailed.action).toBe('failed');
    expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
    expect(mockExecuteLightweight).not.toHaveBeenCalled();
  });

  it('配置后到 worktree 使用前 repo 被替换时仍使用固定 capability，metadata 保留原路径', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-capability-outside-'));
    const original = `${repoRoot}-original`;
    const oldRoots = process.env.PMO_GIT_REPO_ROOTS;
    process.env.PMO_GIT_REPO_ROOTS = os.tmpdir();
    mockEnsureWuWorktree.mockImplementation(async ({ wuId, repoDir, baseBranch }: { wuId: string; repoDir: string; baseBranch?: string }) => {
      fs.renameSync(repoRoot, original);
      fs.symlinkSync(outside, repoRoot);
      fs.writeFileSync(path.join(repoDir, 'capability-marker'), 'safe');
      return { worktreePath: WT(), branch: `task/${wuId}`, baseBranch: baseBranch ?? 'main', baseRepo: repoDir };
    });
    try {
      const wu = await createWu('task', { workspaceRoot: repoRoot });
      const step = await loop().agentStep({ workUnit: wu });

      expect(fs.existsSync(path.join(outside, 'capability-marker'))).toBe(false);
      expect(fs.readFileSync(path.join(original, 'capability-marker'), 'utf8')).toBe('safe');
      expect(step.metadataUpdates?.worktreeBaseRepo).toBe(repoRoot);
    } finally {
      fs.rmSync(repoRoot, { force: true });
      if (fs.existsSync(original)) fs.renameSync(original, repoRoot);
      if (oldRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
      else process.env.PMO_GIT_REPO_ROOTS = oldRoots;
      fs.rmSync(outside, { recursive: true, force: true });
    }
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

    // recordResult：记 consecutiveStuck，发一条步失败系统消息（#175），状态保持 active
    await loop().recordResult({ workUnit: wu }, step);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const meta = await metaOf(wu.id);
    expect(meta.consecutiveStuck).toBe(1);
    expect(meta.errorType).toBe('worktree_creation_failed');
    const texts = await channelTexts(wu.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('执行失败（第 1 次）');
  });

  it('非代码类 WU（analysis）：不建 worktree，维持共享目录 cwd', async () => {
    const wu = await createWu('analysis', { workspaceRoot: repoRoot });

    await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).not.toHaveBeenCalled();
    expect(mockExecuteLightweight.mock.calls[0][0].parameters.workspaceRoot).toBe(repoRoot);
  });

  it('analysis 原型单（metadata.prototype=true，#157 T6）：挂专属 worktree，分支前缀 prototype/', async () => {
    mockEnsureWuWorktree.mockImplementation(async ({ wuId, repoDir, baseBranch, branchPrefix }: { wuId: string; repoDir: string; baseBranch?: string; branchPrefix?: string }) => ({
      worktreePath: WT(),
      branch: `${branchPrefix ?? 'task'}/${wuId}`,
      baseBranch: baseBranch ?? 'main',
      baseRepo: repoDir,
    }));
    const wu = await createWu('analysis', { workspaceRoot: repoRoot, prototype: true });

    const step = await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).toHaveBeenCalledWith(expect.objectContaining({
      wuId: wu.id,
      repoDir: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/),
      branchPrefix: 'prototype',
    }));
    const task = mockExecuteLightweight.mock.calls[0][0];
    expect(task.parameters.workspaceRoot).toBe(WT());
    expect(task.parameters.workspaceRoot).not.toBe(repoRoot);
    expect(step.metadataUpdates).toMatchObject({
      worktreePath: WT(),
      worktreeBranch: `prototype/${wu.id}`,
      worktreeBaseBranch: 'main',
      worktreeBaseRepo: repoRoot,
    });
  });

  it('analysis 原型单后续 step：复用 metadata 中的 worktree（branchPrefix 仍为 prototype）', async () => {
    const wu = await createWu('analysis', {
      workspaceRoot: repoRoot,
      prototype: true,
      worktreePath: WT(),
      worktreeBranch: `prototype/${'x'}`,
      worktreeBaseBranch: 'main',
      worktreeBaseRepo: repoRoot,
    });

    const step = await loop().agentStep({ workUnit: wu });

    expect(mockEnsureWuWorktree).toHaveBeenCalledWith(expect.objectContaining({
      wuId: wu.id,
      branchPrefix: 'prototype',
      baseBranch: 'main',
    }));
    expect(step.metadataUpdates?.worktreePath).toBeUndefined();
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
    // 收口守卫已改 execFile 回调式异步出口（completion-gates 2026-09 性能治理）
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(null, args.includes('rev-parse') ? 'h1\n' : ' M src/a.ts\n', '')
    );
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/) }),
      expect.any(Function),
    );
    expect((await wuService.getById(wu.id))!.status).toBe('active'); // 打回 progress
  });

  // ─── 改造项 2：COMPLETE 前自动验证 ───

  it('代码类 WU 校验后替换 worktree：验证 fail-closed，零 spawn 零越界读取', async () => {
    const outside = path.join(testDir, 'verify-outside');
    const original = `${WT()}-original`;
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'safe-test' } }));
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ scripts: { test: 'outside-test' } }));
    const realpath = fs.realpathSync.bind(fs);
    let checks = 0;
    vi.spyOn(fs, 'realpathSync').mockImplementation(candidate => {
      const resolved = realpath(candidate);
      checks += 1;
      if (checks === 2) {
        fs.renameSync(WT(), original);
        fs.symlinkSync(outside, WT());
      }
      return resolved;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    try {
      await expect(loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' })).rejects.toThrow();
      expect(readSpy.mock.calls.filter(call => String(call[0]).startsWith(outside))).toEqual([]);
      expect(mockHostExecFile).not.toHaveBeenCalled();
      expect((await wuService.getById(wu.id))!.status).toBe('active');
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(WT(), { force: true });
      if (fs.existsSync(original)) fs.renameSync(original, WT());
    }
  });

  it('metadata/workspace 自定义命令不生效：固定模板全绿 → in_review + verifyReport + 频道简报', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'x', typecheck: 'x' } }));
    mockGetWorkspaceRecord.mockResolvedValue({ id: 'ws-1', verifyCommands: ['./ci.sh'] });
    const wu = await createWu('feature', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['test', './scripts/ci.sh'],
    }, { workspaceId: 'ws-1' });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockHostExecFile).toHaveBeenCalledTimes(2);
    expect(mockHostExecFile).toHaveBeenNthCalledWith(1, 'pnpm', ['exec', 'vitest', 'run'], expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/), timeoutMs: 600_000 }));
    expect(mockHostExecFile).toHaveBeenNthCalledWith(2, 'pnpm', ['exec', 'tsc', '--noEmit'], expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/), timeoutMs: 600_000 }));
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    const meta = await metaOf(wu.id);
    expect(meta.verifyReport).toMatchObject({ commands: ['test', 'typecheck'], source: 'convention' });
    expect(meta.verifyFailCount).toBe(0);
    const texts = await channelTexts(wu.id);
    expect(texts.some(t => t.includes('自动验证通过') && t.includes('test'))).toBe(true);
  });

  it('约定：package.json 有 test/typecheck/lint 时依次跑固定 argv', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({
      scripts: { test: 'vitest', typecheck: 'tsc', lint: 'eslint .', build: 'x' },
    }));
    fs.writeFileSync(path.join(WT(), 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockHostExecFile.mock.calls.map(c => c.slice(0, 2))).toEqual([
      ['pnpm', ['exec', 'vitest', 'run']],
      ['pnpm', ['exec', 'tsc', '--noEmit']],
      ['pnpm', ['exec', 'eslint', '.']],
    ]);
    expect((await metaOf(wu.id)).verifyReport?.source).toBe('convention');
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('约定：无 lockfile 仍用固定 argv；只有部分 script 时只跑存在的', async () => {
    fs.writeFileSync(path.join(WT(), 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockHostExecFile.mock.calls.map(c => c.slice(0, 2))).toEqual([['pnpm', ['exec', 'vitest', 'run']]]);
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('无 package.json / 无可跑 script → 跳过验证，正常 in_review', async () => {
    const wu = await createWu('task', { workspaceRoot: repoRoot, worktreePath: WT() });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockHostExecFile).not.toHaveBeenCalled();
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).verifyReport).toBeUndefined();
  });

  it('验证失败 → 降级 progress：失败命令+输出尾部（截 2000）注入下一轮 prompt，verifyFailCount 计数', async () => {
    const longOutput = `header-${'x'.repeat(3000)}-tail-marker`;
    const err = Object.assign(new Error('Command exited with code 1'), { stderr: longOutput, stdout: '' });
    mockHostExecFile.mockRejectedValue(err);
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(), verifyCommands: ['test'],
    });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect((await wuService.getById(wu.id))!.status).toBe('active');
    const meta = await metaOf(wu.id);
    expect(meta.verifyFailCount).toBe(1);
    expect(meta.verifyFailHint).toContain('test');
    expect(meta.verifyFailHint).toContain('tail-marker');
    expect(meta.verifyFailHint!.length).toBeLessThan(2_200); // 尾部截断生效（含提示头）

    // 提示注入下一轮 prompt，注入后即消费
    const step = await loop().agentStep({ workUnit: (await wuService.getById(wu.id))! });
    const prompt = mockExecuteLightweight.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('## 验证失败');
    expect(prompt).toContain('test');
    expect(step.metadataUpdates).toHaveProperty('verifyFailHint', undefined);
  });

  it('验证连续失败 3 次 → blocked 并频道说明', async () => {
    mockHostExecFile.mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'boom' }));
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(), verifyCommands: ['test'],
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

    await loop().recordResult({ workUnit: reviewWu }, {
      action: 'complete', summary: 'REVIEW_RESULT: {"verdict":"pass"}',
      // reviewReport 模拟 agentStep 协议行解析落档（收口闸 2 要求 review 契约产物非空）
      metadataUpdates: { reviewReport: { approved: true } },
    });

    expect(mockHostExecFile).not.toHaveBeenCalled();
    // review 子 WU complete 直接收口 done（P0 修复路径）
    expect((await wuService.getById(reviewWu.id))!.status).toBe('done');
  });

  // ─── F6-c 断点 1：步骤超限强制收口补跑 L1 ───

  it('强制收口（progress 超限）：代码类 + worktree + 验证全绿 → in_review + l1 approved + verifyReport', async () => {
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['test'], stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect(mockHostExecFile).toHaveBeenCalledTimes(1);
    expect(mockHostExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'vitest', 'run'], expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/), timeoutMs: 600_000 }));
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    const meta = await metaOf(wu.id);
    expect(meta.attestations?.l1?.verdict).toBe('approved');
    expect(meta.attestations?.l1?.kind).toBe('verify');
    expect(meta.verifyReport?.commands).toEqual(['test']);
    const texts = await channelTexts(wu.id);
    expect(texts.some(t => t.includes('步骤数超限'))).toBe(true);
  });

  it('强制收口（progress 超限）：验证失败 → 仍 in_review + l1 rejected，不计 verifyFailCount、不写 verifyReport', async () => {
    mockHostExecFile.mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'boom' }));
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['test'], stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    const meta = await metaOf(wu.id);
    expect(meta.attestations?.l1?.verdict).toBe('rejected');
    expect(meta.attestations?.l1?.summary).toContain('test');
    expect(meta.verifyFailCount).toBeUndefined();
    expect(meta.verifyReport).toBeUndefined();
  });

  it('强制收口：非代码类（analysis）即使有 worktree 落档也不跑验证、不落 l1', async () => {
    const wu = await createWu('analysis', {
      workspaceRoot: repoRoot, worktreePath: WT(), stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect(mockHostExecFile).not.toHaveBeenCalled();
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).attestations?.l1).toBeUndefined();
  });

  it('强制收口：代码类但无 worktree → 不跑验证、不落 l1（维持现状）', async () => {
    const wu = await createWu('task', { workspaceRoot: repoRoot, stepCount: 15 });

    await loop().recordResult({ workUnit: wu }, { action: 'progress', summary: '继续中' });

    expect(mockHostExecFile).not.toHaveBeenCalled();
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).attestations?.l1).toBeUndefined();
  });

  it('超限 + COMPLETE：COMPLETE 守卫本 step 已跑验证 → 强制收口不重复跑（execFile 仅一次）', async () => {
    const wu = await createWu('task', {
      workspaceRoot: repoRoot, worktreePath: WT(),
      verifyCommands: ['test'], stepCount: 15,
    });

    await loop().recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });

    expect(mockHostExecFile).toHaveBeenCalledTimes(1);
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    expect((await metaOf(wu.id)).attestations?.l1?.verdict).toBe('approved');
  });
});
