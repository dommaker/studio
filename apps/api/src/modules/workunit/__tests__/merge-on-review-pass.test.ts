// B3b-ii: 评审通过后自动合并（决策 D1/D3 后半）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；git 调用（execSh/execFile）全部 mock。
// 覆盖：合并成功 / 冲突后 rebase 重试成功 / 重试仍冲突转人工（rebase 失败 & 二次 merge 失败）
//       / 防重（mergedAt 哨兵）/ 无 worktree 旁路 / reviewPassed 收口触发与旁路集成
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eventBus, FileStore, WorkUnitSnapshotConflictError } from '@dommaker/studio-shared';
import { WorkUnitService, waitForReviewPassSettled } from '../workunit-review.js';
import type { WorkUnitMetadata } from '../workunit.types.js';
import type { WorkUnitData } from '../workunit-crud.js';
import { mergeWorktreeBranchOnReviewPass, cleanupPrototypeWorktreeOnReviewPass } from '../merge-on-review-pass.js';

const { mockExecSh, mockExecFile, mockHostExecFile, mockPostWuSystemMessage, mockResolvePmoProjectId, mockSystemExecRun, mockLoadSingleSkill } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
  mockExecFile: vi.fn(),
  mockHostExecFile: vi.fn(),
  mockPostWuSystemMessage: vi.fn(),
  mockResolvePmoProjectId: vi.fn(),
  mockSystemExecRun: vi.fn(),
  mockLoadSingleSkill: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execFile: mockExecFile };
});

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execFile: mockHostExecFile, execSh: mockExecSh };
});

// 2026-08 归因统一：merge-on-review-pass 经 lazy import 的 resolvePmoProjectIdForWU 重解析
// 归属项目 id（不再读 metadata.pmoProjectId 缓存）；mock 按创建期戳 pmoId 解析
vi.mock('../../requirements/pmo-branch-resolver.js', () => ({
  resolvePmoProjectIdForWU: mockResolvePmoProjectId,
}));

// LLM 解冲突：spawn 复用 system-executor 一次性会话（mock 掉真实 LLM 调用）
vi.mock('../../agents/system-executor.js', () => ({
  getSystemExecutor: () => ({ run: mockSystemExecRun }),
}));

// LLM 解冲突：skill 全文经 skillLoader.loadSingle 加载（mock 掉磁盘 seed 依赖；
// 全 mock 对齐 claim-skill-integration.test.ts 模式——本包无 src 别名，走 dist）
vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { loadSingle: mockLoadSingleSkill },
}));

// wu-messenger 间谍包装：真实发送保留（消息断言不受影响），另断言委托参数（milestone 等）
vi.mock('../wu-messenger.js', async (importOriginal) => {
  const orig = await importOriginal() as { postWuSystemMessage: (...args: unknown[]) => Promise<unknown> };
  mockPostWuSystemMessage.mockImplementation(orig.postWuSystemMessage);
  return { ...orig, postWuSystemMessage: mockPostWuSystemMessage };
});

let REPO: string;
let WT: string;
const BRANCH = 'task/wu-1';
const BASE = 'main';
const HEAD = 'deadbeefcafe1234567890';
const HUMAN_CONFIRMATION = {
  l3: { verdict: 'approved' as const, by: 'alice', at: '2026-11-08T00:00:00Z', kind: 'human-confirm' },
};
let currentCheckout = BASE;

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let previousGitRoots: string | undefined;
let previousWorktreesDir: string | undefined;

function worktreeMeta(extra?: Partial<WorkUnitMetadata>): WorkUnitMetadata {
  return {
    worktreePath: WT,
    worktreeBranch: BRANCH,
    worktreeBaseBranch: BASE,
    worktreeBaseRepo: REPO,
    ...extra,
  };
}

async function createWu(metadata: WorkUnitMetadata, status = 'in_review', type = 'task'): Promise<WorkUnitData> {
  return wuService.create({
    scope: '实现登录接口',
    type,
    channelId: 'ch-merge',
    status,
    metadata,
  });
}

/** 默认 git mock：全部成功；rev-parse 返回固定 HEAD。失败场景由各用例 mockImplementation 覆盖 */
function mockGit(): void {
  mockExecSh.mockImplementation(async (cmd: string) => {
    if (cmd.includes('--git-common-dir')) return { stdout: `${REPO}/.git\n`, stderr: '' };
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return { stdout: `${BASE}\n`, stderr: '' };
    if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
  // studio-agent 已改 execFile 参数数组；桥到本测试既有 execSh 场景表，保持合并行为断言聚焦。
  mockExecFile.mockImplementation((
    _cmd: string,
    args: string[],
    opts: { cwd: string; timeout: number },
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (args.includes('--git-common-dir')) return cb(null, `${REPO}/.git\n`, '');
    if (args.includes('--abbrev-ref')) return cb(null, `${currentCheckout}\n`, '');
    if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(args[3], { recursive: true });
    mockExecSh(`git ${args.join(' ')}`, { cwd: opts.cwd, timeoutMs: opts.timeout }).then(
      (result: { stdout: string; stderr: string }) => cb(null, result.stdout, result.stderr),
      (error: Error) => cb(error, '', ''),
    );
  });
}

function calledCommands(): string[] {
  return mockExecSh.mock.calls.map(c => c[0] as string);
}

async function studioMessages(wuId: string) {
  const messages = await fileStore.queryMessages('ch-merge', { workUnitId: wuId });
  return messages.filter(m => m.authorType === 'agent' && m.agentName === 'Studio');
}

beforeEach(async () => {
  vi.clearAllMocks();
  currentCheckout = BASE;
  mockHostExecFile.mockResolvedValue({ stdout: '', stderr: '' });
  // 归属解析 mock 默认实现：按创建期戳 metadata.pmoId 解析（坏 JSON / 无戳 → null）
  mockResolvePmoProjectId.mockImplementation(async (wu: { metadata?: string | null }) => {
    try {
      return (JSON.parse(wu.metadata ?? '{}') as { pmoId?: string }).pmoId ?? null;
    } catch {
      return null;
    }
  });
  // LLM 解冲突默认实现：skill 可用 + spawn 成功（是否"解完"由各用例的 diff-filter=U mock 决定）
  mockLoadSingleSkill.mockReturnValue({ id: 'resolving-merge-conflicts', name: 'resolving-merge-conflicts', prompt: 'SKILL 流程卡全文' });
  mockSystemExecRun.mockResolvedValue({ output: 'resolved; typecheck+test green', usage: undefined, durationMs: 1234 });
  previousGitRoots = process.env.PMO_GIT_REPO_ROOTS;
  previousWorktreesDir = process.env.WORKTREES_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-on-review-pass-'));
  process.env.PMO_GIT_REPO_ROOTS = tmpDir;
  process.env.WORKTREES_DIR = path.join(tmpDir, 'worktrees');
  REPO = path.join(tmpDir, 'repo');
  WT = path.join(tmpDir, 'worktrees', 'wu-x');
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(WT, { recursive: true });
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  await fileStore.createChannel({
    id: 'ch-merge',
    name: '#merge-test',
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: '[]',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  mockGit();
});

afterEach(() => {
  if (previousGitRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
  else process.env.PMO_GIT_REPO_ROOTS = previousGitRoots;
  if (previousWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
  else process.env.WORKTREES_DIR = previousWorktreesDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('B3b-ii: 评审通过后自动合并', () => {
  it('数据防丢闸：worktree 有未提交改动 → 不合并不强删，WU blocked + 频道列清单转人工', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('status --porcelain')) return { stdout: ' M README.md\n?? .studio/AGENTS.generated.md\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({
      attempted: true, merged: false,
      conflictFiles: ['M README.md', '?? .studio/AGENTS.generated.md'],
      reason: 'uncommitted-changes',
    });
    const cmds = calledCommands();
    // 绝不合并、绝不强删 worktree、不删分支
    expect(cmds.some(c => c.includes('merge --no-ff'))).toBe(false);
    expect(cmds.some(c => c.includes('worktree remove'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeConflict).toBe(true);
    expect(meta.mergedAt).toBeUndefined();

    const msgs = await studioMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('未提交改动');
    expect(msgs[0].content).toContain('README.md');
    // 2026-07 PMO-flow UX（§6-3）：blocked 转人工 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('未提交改动'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('数据防丢闸：git status 调用失败按有改动处理（宁可转人工不丢数据）', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('status --porcelain')) throw new Error('worktree gone');
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome.attempted).toBe(true);
    expect(outcome.merged).toBe(false);
    expect(calledCommands().some(c => c.includes('worktree remove'))).toBe(false);
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('危险 worktree/base/PMO 分支在 status/rev-parse/merge 前零子进程拒绝', async () => {
    const scenarios: Array<Partial<WorkUnitMetadata>> = [
      ...['feature";id', 'feature$(id)', 'feature`id`', 'feature;id', 'feature\nid', '--upload-pack=id'].map(worktreeBranch => ({ worktreeBranch })),
      { worktreeBaseBranch: '--upload-pack=id' },
      { pmoBranch: 'feature$(id)', pmoId: 'proj-1' },
    ];
    for (const metadata of scenarios) {
      const wu = await createWu(worktreeMeta(metadata));
      const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);
      expect(outcome).toMatchObject({ attempted: true, merged: false, reason: 'conflict' });
      expect(mockExecSh).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockSystemExecRun).not.toHaveBeenCalled();
    }
  });

  it('PMO-b：落档 pmoBranch → 合到 PMO 分支的集成交合（不动 baseRepo checkout）', async () => {
    fs.mkdirSync(path.join(tmpDir, 'worktrees', 'pmo-proj-1'), { recursive: true });
    // 2026-08 归因统一：项目 id 不再读 pmoProjectId 缓存，由创建期戳 pmoId 经 resolver 重解析
    const wu = await createWu(worktreeMeta({ pmoBranch: 'PMO-11', pmoId: 'proj-1', attestations: HUMAN_CONFIRMATION }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    const cmds = calledCommands();
    // 集成分支确保（rev-parse verify / branch）与交合 worktree add
    expect(cmds.some(c => c.includes('rev-parse --verify') && c.includes('PMO-11'))).toBe(true);
    expect(cmds.some(c => c.includes('worktree add') && c.includes('pmo-proj-1') && c.includes('PMO-11'))).toBe(true);
    // merge 落在集成交合，而非 baseRepo
    const mergeCmd = cmds.find(c => c.includes('merge --no-ff'));
    expect(mergeCmd).toBeDefined();
    expect(mergeCmd).toContain('pmo-proj-1');
    expect(mergeCmd).not.toContain(`git -C '${REPO}'`);
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', expect.stringContaining('pmo-proj-1'), 'merge', '--no-ff', '-m', `merge: ${wu.id} 实现登录接口`, '--', BRANCH],
      expect.objectContaining({ cwd: expect.stringContaining('pmo-proj-1') }), expect.any(Function),
    );
    // mergeCommit 读集成交合 HEAD
    expect(cmds.some(c => c.includes('rev-parse HEAD') && c.includes('pmo-proj-1'))).toBe(true);
    // 频道通知说 PMO 分支
    const msgs = await studioMessages(wu.id);
    expect(msgs.some(m => m.content.includes('已合并到 PMO-11'))).toBe(true);
  });

  it('PMO-b：集成交合准备失败 → 转人工（不静默回落错误目标）', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('worktree add') && cmd.includes('pmo-proj-1')) {
        throw new Error('PMO-11 is already checked out at /elsewhere');
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta({ pmoBranch: 'PMO-11', pmoId: 'proj-1' }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome.attempted).toBe(true);
    expect(outcome.merged).toBe(false);
    // 未执行 merge；WU blocked 转人工
    expect(calledCommands().some(c => c.includes('merge --no-ff'))).toBe(false);
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
    const msgs = await studioMessages(wu.id);
    const humanMsg = msgs.find(m => m.content.includes('PMO 集成分支') && m.content.includes('转人工'));
    expect(humanMsg).toBeDefined();
    // 2026-07 PMO-flow UX（§6-3）：转人工 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('PMO 集成分支'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('PMO-b：pmoBranch 落档但归属项目解析不出 → 转人工（不静默回落错误目标）', async () => {
    // 无任何创建期戳（pmoId/reqId 均缺）→ resolver 返回 null
    const wu = await createWu(worktreeMeta({ pmoBranch: 'PMO-11' }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: [], reason: 'conflict' });
    // 未执行 merge、未建集成交合；WU blocked 转人工
    const cmds = calledCommands();
    expect(cmds.some(c => c.includes('merge --no-ff'))).toBe(false);
    expect(cmds.some(c => c.includes('worktree add'))).toBe(false);
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
    const msgs = await studioMessages(wu.id);
    expect(msgs.some(m => m.content.includes('归属项目解析失败') && m.content.includes('转人工'))).toBe(true);
  });

  it('#701 非 PMO 当前 checkout 不等于记录 baseBranch → 不合并且保留现场转人工', async () => {
    currentCheckout = 'feature/wip';
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: [], reason: 'conflict' });
    const cmds = calledCommands();
    expect(cmds.some(c => c.includes('merge --no-ff'))).toBe(false);
    expect(cmds.some(c => c.includes('rebase'))).toBe(false);
    expect(cmds.some(c => c.includes('worktree remove'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    expect((JSON.parse(updated!.metadata!) as WorkUnitMetadata).mergedAt).toBeUndefined();
    expect((await studioMessages(wu.id)).some(m => m.content.includes('main') && m.content.includes('feature/wip'))).toBe(true);
  });

  it('合并成功：unavailable 有人工 L3 时记 receipt → 清理 worktree+分支 → 频道通知', async () => {
    const wu = await createWu(worktreeMeta({ attestations: HUMAN_CONFIRMATION }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    const cmds = calledCommands();
    const mergeCmd = cmds.find(c => c.includes('merge --no-ff'));
    expect(mergeCmd).toBeDefined();
    expect(mergeCmd).toMatch(/-C \/proc\/\d+\/fd\/\d+ /);
    expect(mergeCmd).toContain(BRANCH);
    expect(mergeCmd).toContain(`-m merge: ${wu.id}`);
    // 无冲突 → 不走 rebase / abort
    expect(cmds.some(c => c.includes('rebase'))).toBe(false);
    expect(cmds.some(c => c.includes('merge --abort'))).toBe(false);
    // 清理：先 worktree remove，再 branch -d
    expect(cmds.some(c => c.includes('worktree remove --force') && c.includes(WT))).toBe(true);
    expect(cmds.some(c => c.includes('branch -d') && c.includes(BRANCH))).toBe(true);

    const updated = await wuService.getById(wu.id);
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
    expect(meta.mergeCommit).toBe(HEAD);

    const msgs = await studioMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain(`已合并到 ${BASE}`);
    expect(msgs[0].content).toContain(HEAD.slice(0, 7));
    // 2026-07 PMO-flow UX §10：合并成功 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining(`已合并到 ${BASE}`),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('冲突重试成功：首次 merge 失败 → abort → worktree rebase 到 base → 再 merge 成功', async () => {
    let mergeAttempts = 0;
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) {
        mergeAttempts++;
        if (mergeAttempts === 1) throw new Error('CONFLICT: content');
        return { stdout: '', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    expect(mergeAttempts).toBe(2);
    const cmds = calledCommands();
    const rebaseCmd = cmds.find(c => c.includes(`rebase -- ${BASE}`));
    expect(rebaseCmd).toBeDefined();
    expect(rebaseCmd).toContain(WT);
    // 命令顺序：merge → abort → rebase → merge
    const mergeIdx = cmds.map((c, i) => c.includes('merge --no-ff') ? i : -1).filter(i => i >= 0);
    const abortIdx = cmds.findIndex(c => c.includes('merge --abort'));
    const rebaseIdx = cmds.findIndex(c => c.includes(`rebase -- ${BASE}`));
    expect(mergeIdx).toHaveLength(2);
    expect(abortIdx).toBeGreaterThan(mergeIdx[0]);
    expect(rebaseIdx).toBeGreaterThan(abortIdx);
    expect(mergeIdx[1]).toBeGreaterThan(rebaseIdx);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).not.toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
  });

  it('冲突兜底转人工（rebase 冲突，LLM 解后仍有残留冲突）：LLM 尝试过 → 清理现场 → WU blocked + 频道转人工', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT: content');
      if (cmd.includes(`rebase -- ${BASE}`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) {
        return { stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: ['src/a.ts', 'src/b.ts'] });
    // LLM 解冲突已尝试（spawn cwd = rebase 现场 worktree），但 mock 下冲突清单不变 → 判定未解完 → 兜底
    expect(mockLoadSingleSkill).toHaveBeenCalledWith('resolving-merge-conflicts');
    expect(mockSystemExecRun).toHaveBeenCalledTimes(1);
    expect(mockSystemExecRun.mock.calls[0][1]).toEqual(expect.objectContaining({ cwd: WT, eventSource: 'merge-conflict-resolution' }));
    const cmds = calledCommands();
    // 现场清理：LLM 兜底后 rebase --abort 执行过；不清理 worktree/分支（留人工）
    expect(cmds.some(c => c.includes('rebase --abort'))).toBe(true);
    expect(cmds.some(c => c.includes('worktree remove'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeConflict).toBe(true);
    expect(meta.conflictFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(meta.mergedAt).toBeUndefined();
    // LLM 解冲突审计落档：未解完（仍有残留冲突）
    expect(meta.mergeResolution).toEqual(expect.objectContaining({ ok: false, state: 'rebase', cwd: WT }));
    expect(meta.mergeResolution!.error).toContain('仍有 2 个冲突文件');

    const msgs = await studioMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('转人工');
    expect(msgs[0].content).toContain('src/a.ts');
    expect(msgs[0].content).toContain('src/b.ts');
    // 2026-07 PMO-flow UX（§6-3）：blocked 转人工 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('转人工'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('冲突兜底转人工（rebase 成功但二次 merge 仍冲突，LLM 解后仍有残留）：冲突文件取自合并目标现场', async () => {
    let mergeAttempts = 0;
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) {
        mergeAttempts++;
        throw new Error('CONFLICT: content');
      }
      if (cmd.includes('diff --name-only --diff-filter=U')) {
        return { stdout: 'src/x.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: ['src/x.ts'] });
    expect(mergeAttempts).toBe(2);
    const cmds = calledCommands();
    expect(cmds.some(c => c.includes(`rebase -- ${BASE}`))).toBe(true);
    expect(cmds.filter(c => c.includes('merge --abort'))).not.toHaveLength(0);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const msgs = await studioMessages(wu.id);
    expect(msgs[0].content).toContain('src/x.ts');
  });

  it('冲突保留现场交 LLM 解（rebase 冲突）：不先 abort；LLM 解完 rebase → 重放 merge 成功 → verify 绿 → merged', async () => {
    let mergeAttempts = 0;
    let llmCalled = false;
    mockSystemExecRun.mockImplementation(async () => {
      llmCalled = true;
      return { output: 'resolved src/a.ts src/b.ts; typecheck+test green', usage: undefined, durationMs: 5678 };
    });
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) {
        mergeAttempts++;
        if (mergeAttempts === 1) throw new Error('CONFLICT: content');
        return { stdout: '', stderr: '' }; // LLM 解完 rebase 后重放成功
      }
      if (cmd.includes(`rebase -- ${BASE}`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) {
        // LLM 调用前：rebase 现场有冲突；LLM 调用后：已解清
        return { stdout: llmCalled ? '' : 'src/a.ts\nsrc/b.ts\n', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    expect(mergeAttempts).toBe(2); // 首次失败 + LLM 解完 rebase 后重放
    // spawn 一次性解冲突会话：skill 全文作 systemPrompt，cwd = rebase 现场（worktree）
    expect(mockLoadSingleSkill).toHaveBeenCalledWith('resolving-merge-conflicts');
    expect(mockSystemExecRun).toHaveBeenCalledTimes(1);
    const [prompt, spawnOpts] = mockSystemExecRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(spawnOpts).toEqual(expect.objectContaining({
      cwd: WT,
      systemPrompt: 'SKILL 流程卡全文',
      eventSource: 'merge-conflict-resolution',
    }));
    expect(prompt).toContain(`cwd: ${WT}`);
    expect(prompt).toContain('rebase 进行中');
    expect(prompt).toContain(`目标分支: ${BASE}`);
    expect(prompt).toContain(`来源分支: ${BRANCH}`);
    expect(prompt).toContain('src/a.ts');
    const cmds = calledCommands();
    // 现场保留：rebase --abort 从未执行（LLM 解成功，无需兜底清理）
    expect(cmds.some(c => c.includes('rebase --abort'))).toBe(false);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).not.toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
    // LLM 解冲突审计落档：成功 + 输出摘要
    expect(meta.mergeResolution).toEqual(expect.objectContaining({
      ok: true, state: 'rebase', cwd: WT, durationMs: 5678,
      conflictFiles: ['src/a.ts', 'src/b.ts'],
    }));
    expect(meta.mergeResolution!.summary).toContain('resolved src/a.ts');
  });

  it('冲突保留现场交 LLM 解（二次 merge 冲突）：LLM 在合并目标目录解 merge → merged', async () => {
    let mergeAttempts = 0;
    let llmCalled = false;
    mockSystemExecRun.mockImplementation(async () => {
      llmCalled = true;
      return { output: 'merge committed', usage: undefined, durationMs: 100 };
    });
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) {
        mergeAttempts++;
        throw new Error('CONFLICT: content'); // 首次 + 二次均冲突；LLM 自己 commit merge（无第三次）
      }
      if (cmd.includes('diff --name-only --diff-filter=U')) {
        return { stdout: llmCalled ? '' : 'src/x.ts\n', stderr: '' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    expect(mergeAttempts).toBe(2); // LLM 解 merge 现场后无重放（merge 由 LLM commit）
    // spawn cwd = 合并目标目录（baseRepo），prompt 指明 merge 现场
    const [prompt, spawnOpts] = mockSystemExecRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(spawnOpts).toEqual(expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/) }));
    expect(prompt).toContain('merge 进行中');
    const cmds = calledCommands();
    // 现场保留：LLM 调用后不再有 merge --abort（仅 rebase 重试前清首次现场那一次）
    expect(cmds.filter(c => c.includes('merge --abort'))).toHaveLength(1);

    const meta = JSON.parse((await wuService.getById(wu.id))!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
    expect(meta.mergeResolution).toEqual(expect.objectContaining({ ok: true, state: 'merge', cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/) }));
  });

  it('LLM 仅清掉冲突文件但源分支未进入目标 HEAD → 不记 merged，回退人工', async () => {
    let llmCalled = false;
    mockSystemExecRun.mockImplementation(async () => {
      llmCalled = true;
      return { output: 'conflict markers removed, no commit', usage: undefined, durationMs: 100 };
    });
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT: content');
      if (cmd.includes(`rebase -- ${BASE}`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) return { stdout: llmCalled ? '' : 'src/a.ts\n', stderr: '' };
      if (cmd.includes('merge-base --is-ancestor')) throw new Error('source is not ancestor');
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta({ worktreePath: undefined }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome.merged).toBe(false);
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeUndefined();
    expect(meta.mergeResolution).toEqual(expect.objectContaining({ ok: false }));
    expect(meta.mergeResolution!.error).toContain('未进入目标 HEAD');
  });

  it('LLM 解冲突失败/超时 → 回退现有 abort + blockForMergeFailure 转人工（兜底不变）', async () => {
    mockSystemExecRun.mockRejectedValue(new Error('LLM session timeout'));
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT: content');
      if (cmd.includes(`rebase -- ${BASE}`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) return { stdout: 'src/a.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: ['src/a.ts'] });
    const cmds = calledCommands();
    // 兜底清理：rebase --abort 执行过；worktree/分支保留
    expect(cmds.some(c => c.includes('rebase --abort'))).toBe(true);
    expect(cmds.some(c => c.includes('worktree remove'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeConflict).toBe(true);
    expect(meta.mergedAt).toBeUndefined();
    expect(meta.mergeResolution).toEqual(expect.objectContaining({ ok: false, state: 'rebase' }));
    expect(meta.mergeResolution!.error).toContain('LLM session timeout');
    const msgs = await studioMessages(wu.id);
    expect(msgs.some(m => m.content.includes('转人工'))).toBe(true);
  });

  it('skill 不可用 → 不 spawn LLM，直接回退 abort + 转人工', async () => {
    mockLoadSingleSkill.mockReturnValue(null);
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT: content');
      if (cmd.includes(`rebase -- ${BASE}`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) return { stdout: 'src/a.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome.merged).toBe(false);
    expect(mockSystemExecRun).not.toHaveBeenCalled();
    expect(calledCommands().some(c => c.includes('rebase --abort'))).toBe(true);
    const meta = JSON.parse((await wuService.getById(wu.id))!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeResolution!.ok).toBe(false);
    expect(meta.mergeResolution!.error).toContain('resolving-merge-conflicts 不可用');
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('合并后 verify 红 → blocked 且保留 merged receipt/commit，不伪装冲突或未合并', async () => {
    fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }));
    fs.writeFileSync(path.join(REPO, 'pnpm-lock.yaml'), '');
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    mockHostExecFile.mockRejectedValueOnce(
      Object.assign(new Error('exit 1'), { stderr: 'TS2322: type mismatch in merged code' }),
    );
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: [], reason: 'merge-verify-failed' });
    const cmds = calledCommands();
    // merge 成功 + verify 在合并目标目录跑过；红 → 不删 worktree、不删分支
    expect(cmds.some(c => c.includes('merge --no-ff'))).toBe(true);
    expect(mockHostExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'tsc', '--noEmit'], expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/) }));
    expect(cmds.some(c => c.includes('worktree remove'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);
    // 无冲突 → 不走 LLM 解冲突
    expect(mockSystemExecRun).not.toHaveBeenCalled();

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
    expect(meta.mergeCommit).toBe(HEAD);
    expect(meta.mergeConflict).toBeUndefined();
    expect(meta.mergeReceipt).toEqual(expect.objectContaining({
      merged: true,
      mergeCommit: HEAD,
      verification: expect.objectContaining({ status: 'failed' }),
    }));
    expect(meta.blockReason).toContain('merge-verify-failed');
    expect(meta.blockReason).toContain('typecheck');

    const msgs = await studioMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('合并后验证失败');
    expect(msgs[0].content).toContain('TS2322');
  });

  it('合并后 rev-parse HEAD 失败：保留 merged 事实但无有效 receipt，不接受不清理', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('rev-parse HEAD')) throw new Error('cannot read HEAD');
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta({ attestations: HUMAN_CONFIRMATION }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: [], reason: 'conflict' });
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeReceipt).toEqual(expect.objectContaining({
      merged: true,
      verification: { status: 'not-run', ran: [] },
    }));
    expect(meta.mergeReceipt!.mergeCommit).toBeUndefined();
    expect(calledCommands().some(c => c.includes('worktree remove'))).toBe(false);
    expect(calledCommands().some(c => c.includes('branch -d'))).toBe(false);
  });

  it('合并后 verify：无冲突直合也重跑（合并目标目录），全绿 → merged', async () => {
    fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc' } }));
    fs.writeFileSync(path.join(REPO, 'pnpm-lock.yaml'), '');
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    // verify 固定 argv 在合并目标目录（非 worktree）依次跑过
    expect(mockHostExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'vitest', 'run'], expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/) }));
    expect(mockHostExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'tsc', '--noEmit'], expect.objectContaining({ cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/) }));
    const meta = JSON.parse((await wuService.getById(wu.id))!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
  });

  it('worktree 清理失败不写真完成哨兵，保留后续恢复机会', async () => {
    fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    fs.writeFileSync(path.join(REPO, 'pnpm-lock.yaml'), '');
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('worktree remove')) throw new Error('permission denied');
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    const meta = JSON.parse((await wuService.getById(wu.id))!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeCleanedAt).toBeUndefined();
  });

  it('baseRepo 在合并前被替换时，后续 Git/verify 仍使用固定 capability', async () => {
    const outside = path.join(tmpDir, 'outside');
    const original = path.join(tmpDir, 'repo-original');
    fs.mkdirSync(outside);
    const oldRoots = process.env.PMO_GIT_REPO_ROOTS;
    process.env.PMO_GIT_REPO_ROOTS = tmpDir;
    let replaced = false;
    mockExecSh.mockImplementation(async (cmd: string, opts: { cwd: string }) => {
      if (!replaced) {
        replaced = true;
        fs.renameSync(REPO, original);
        fs.symlinkSync(outside, REPO);
        fs.writeFileSync(path.join(opts.cwd, 'capability-marker'), 'safe');
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });
    try {
      const wu = await createWu(worktreeMeta());
      const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

      expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
      expect(fs.existsSync(path.join(outside, 'capability-marker'))).toBe(false);
      expect(fs.readFileSync(path.join(original, 'capability-marker'), 'utf8')).toBe('safe');
      for (const call of mockExecSh.mock.calls) expect(call[1].cwd).not.toBe(REPO);
    } finally {
      fs.rmSync(REPO, { force: true });
      if (fs.existsSync(original)) fs.renameSync(original, REPO);
      if (oldRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
      else process.env.PMO_GIT_REPO_ROOTS = oldRoots;
    }
  });

  it('防重：metadata.mergedAt 已存在 → 跳过，无任何 git 调用', async () => {
    const wu = await createWu(worktreeMeta({ mergedAt: new Date().toISOString(), mergeCommit: HEAD }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: false, reason: 'already-merged' });
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(await studioMessages(wu.id)).toHaveLength(0);
  });

  it('无 worktree 旁路：metadata 无 worktree 落档 → 跳过合并，频道补「评审通过，任务完成」里程碑', async () => {
    const wu = await createWu({}); // analysis 等非代码类 WU：无 worktree 字段

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: false, reason: 'no-worktree' });
    expect(mockExecSh).not.toHaveBeenCalled();
    // B1：非代码类 WU 评审通过 → done 时频道补一条完成里程碑（经 wu-messenger 统一出口）
    const msgs = await studioMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('评审通过，任务完成');
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('评审通过，任务完成'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('in_review'); // 状态不被合并模块触碰
  });

  it('reviewPassed 先保持 in_review，merge receipt 与目标验证成功后才完成', async () => {
    fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }));
    fs.writeFileSync(path.join(REPO, 'pnpm-lock.yaml'), '');
    const wu = await createWu(worktreeMeta());

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('in_review');
    expect(passed.completedAt).toBeNull();
    expect(JSON.parse(passed.metadata!).mergeIntent).toEqual(expect.objectContaining({ state: 'queued' }));

    await waitForReviewPassSettled();
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('done');
    expect(updated!.completedAt).not.toBeNull();
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeReceipt).toEqual(expect.objectContaining({
      merged: true,
      mergeCommit: HEAD,
      targetBranch: BASE,
      verification: expect.objectContaining({ status: 'passed' }),
    }));
    expect(calledCommands().some(c => c.includes('merge --no-ff'))).toBe(true);
    expect((await studioMessages(wu.id)).some(m => m.content.includes(`已合并到 ${BASE}`))).toBe(true);
  });

  it('并发 reviewPassed 单飞：同一 WU 只执行一次 Git merge', async () => {
    fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }));
    fs.writeFileSync(path.join(REPO, 'pnpm-lock.yaml'), '');
    const wu = await createWu(worktreeMeta());

    await Promise.all([wuService.reviewPassed(wu.id), wuService.reviewPassed(wu.id)]);
    await waitForReviewPassSettled();

    expect(calledCommands().filter(c => c.includes('merge --no-ff'))).toHaveLength(1);
    expect((await wuService.getById(wu.id))!.status).toBe('done');
  });

  it('settleMerge 遇快照代际冲突会重读重试，不停在 not-run', async () => {
    const wu = await createWu(worktreeMeta());
    const receipt = {
      id: `merge:${wu.id}`, merged: true, mergedAt: new Date().toISOString(),
      mergeCommit: HEAD, targetBranch: BASE,
      verification: { status: 'passed' as const, ran: ['pnpm test'] },
    };
    const original = fileStore.commitSnapshot.bind(fileStore);
    let calls = 0;
    vi.spyOn(fileStore, 'commitSnapshot').mockImplementation(async (event, snapshot, opts) => {
      calls++;
      if (calls === 1) throw new WorkUnitSnapshotConflictError(wu.id);
      return original(event, snapshot, opts);
    });

    const settled = await wuService.settleMerge(wu.id, { receipt, outcome: 'done' });

    expect(settled.status).toBe('done');
    expect(calls).toBe(2);
  });

  it('两个并发接受者竞争同一 receipt 时只写一次 done/completedAt', async () => {
    const wu = await createWu(worktreeMeta());
    const receipt = {
      id: `merge:${wu.id}`, merged: true, mergedAt: new Date().toISOString(),
      mergeCommit: HEAD, targetBranch: BASE,
      verification: { status: 'passed' as const, ran: ['pnpm test'] },
    };
    const completions: string[] = [];
    const handler = (payload: { previousStatus?: string; workunit: { id: string; status: string } }) => {
      if (payload.workunit.id === wu.id && payload.workunit.status === 'done' && payload.previousStatus !== 'done') {
        completions.push(payload.workunit.id);
      }
    };
    eventBus.subscribe('workunit.status_changed', handler);
    try {
      const results = await Promise.allSettled([
        wuService.settleMerge(wu.id, { receipt, outcome: 'done' }),
        wuService.settleMerge(wu.id, { receipt, outcome: 'done' }),
      ]);
      expect(results.some(r => r.status === 'fulfilled')).toBe(true);
      expect((await wuService.getById(wu.id))!.status).toBe('done');
      expect(completions).toHaveLength(1);
    } finally {
      eventBus.unsubscribe('workunit.status_changed', handler);
    }
  });

  it('无目标验证命令记 unavailable，人工 L3 后完成且同一接受结果只完成一次', async () => {
    const wu = await createWu(worktreeMeta());
    const completions: string[] = [];
    const handler = (payload: { previousStatus?: string; workunit: { id: string; status: string } }) => {
      if (payload.workunit.id === wu.id && payload.workunit.status === 'done' && payload.previousStatus !== 'done') {
        completions.push(payload.workunit.id);
      }
    };
    eventBus.subscribe('workunit.status_changed', handler);
    try {
      await wuService.reviewPassed(wu.id, { kind: 'agent-review', by: 'reviewer-1' });
      await waitForReviewPassSettled();

      const waiting = await wuService.getById(wu.id);
      expect(waiting!.status).toBe('in_review');
      expect(waiting!.completedAt).toBeNull();
      expect(JSON.parse(waiting!.metadata!).mergeReceipt).toEqual(expect.objectContaining({
        merged: true,
        verification: { status: 'unavailable', ran: [] },
      }));
      expect(completions).toHaveLength(0);

      const confirmed = await wuService.reviewPassed(wu.id, { kind: 'human-confirm', by: 'alice' });
      expect(confirmed.status).toBe('done');
      expect(confirmed.completedAt).not.toBeNull();
      const completedAt = confirmed.completedAt;
      await wuService.reviewPassed(wu.id, { kind: 'human-confirm', by: 'alice' });
      expect((await wuService.getById(wu.id))!.completedAt).toEqual(completedAt);
      expect(completions).toHaveLength(1);
    } finally {
      eventBus.unsubscribe('workunit.status_changed', handler);
    }
  });

  it('reviewPassed 旁路：无 worktree 落档的 WU 不做合并（done，无 git），频道补完成里程碑', async () => {
    const wu = await createWu({}, 'in_review');

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('done');
    expect(passed.completedAt).not.toBeNull();

    // 「不发生」断言：settled 后收尾链已落定（旁路即时返回），比定长 sleep 窗口更强
    await waitForReviewPassSettled();
    expect(mockExecSh).not.toHaveBeenCalled();
    // B1：旁路时频道补一条「评审通过，任务完成」里程碑
    const msgs = await studioMessages(wu.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('评审通过，任务完成');
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('done'); // 不被置 blocked
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeUndefined();
    expect(meta.mergeConflict).toBeUndefined();
  });

  it('merge effect 非预期异常也转 blocked，不永久卡 merge queued', async () => {
    const wu = await createWu(worktreeMeta());
    fs.rmSync(REPO, { recursive: true, force: true });

    await wuService.reviewPassed(wu.id);
    await waitForReviewPassSettled();

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeReceipt).toEqual(expect.objectContaining({ merged: false }));
    expect(meta.blockReason).toContain('merge-effect-failed');
  });

  it('merge 在途禁止拒绝或直接写 done，不能绕过 receipt', async () => {
    const wu = await createWu(worktreeMeta({
      mergeIntent: {
        id: 'merge:pending', state: 'queued', requestedAt: new Date().toISOString(),
        sourceBranch: BRANCH, targetBranch: BASE,
      },
    }));

    await expect(wuService.reviewRejected(wu.id, '不能返工')).rejects.toThrow('merge');
    await expect(wuService.transitionStatus(wu.id, 'done')).rejects.toThrow('merge receipt');
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('reviewPassed 合并冲突：保持 in_review 后转 blocked，不提前完成', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT');
      if (cmd.includes(`rebase -- ${BASE}`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) return { stdout: 'src/a.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('in_review');

    await waitForReviewPassSettled();
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeConflict).toBe(true);
    expect(meta.conflictFiles).toEqual(['src/a.ts']);
    const msgs = await studioMessages(wu.id);
    expect(msgs.some(m => m.content.includes('转人工'))).toBe(true);
  });
});

describe('#157（T6）：analysis 原型单——合并旁路 + 原型收尾清理', () => {
  const PROTO_BRANCH = 'prototype/wu-9';

  it('合并按类型硬旁路：analysis 有 worktree 落档也不合并，零 git 调用', async () => {
    const wu = await createWu(worktreeMeta({ worktreeBranch: PROTO_BRANCH, prototype: true }), 'in_review', 'analysis');

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: false, reason: 'analysis-bypass' });
    expect(mockExecSh).not.toHaveBeenCalled();
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('in_review'); // 状态不被合并模块触碰
    expect(await studioMessages(wu.id)).toHaveLength(0);
  });

  it('原型收尾：删 worktree 目录、保留 prototype/ 分支（不合并不删分支）', async () => {
    const wu = await createWu(worktreeMeta({ worktreeBranch: PROTO_BRANCH, prototype: true }), 'in_review', 'analysis');

    const outcome = await cleanupPrototypeWorktreeOnReviewPass(wu);

    expect(outcome).toEqual({ attempted: true, removed: true });
    const cmds = calledCommands();
    expect(cmds.some(c => c.includes('worktree remove --force') && c.includes(WT))).toBe(true);
    expect(cmds.some(c => c.includes(' merge --no-ff'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -D'))).toBe(false);
  });

  it('原型收尾数据防丢：worktree 有未提交改动 → 不删（留人工），目录与分支都保留', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('status --porcelain')) return { stdout: ' M proto.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta({ worktreeBranch: PROTO_BRANCH, prototype: true }), 'in_review', 'analysis');

    const outcome = await cleanupPrototypeWorktreeOnReviewPass(wu);

    expect(outcome).toEqual({ attempted: true, removed: false });
    expect(calledCommands().some(c => c.includes('worktree remove'))).toBe(false);
  });

  it('原型收尾旁路：非 analysis / 无 worktree 落档 → 零 git 调用', async () => {
    const taskWu = await createWu(worktreeMeta());
    expect(await cleanupPrototypeWorktreeOnReviewPass(taskWu))
      .toEqual({ attempted: false, reason: 'not-analysis-prototype' });

    const plainAnalysis = await createWu({}, 'in_review', 'analysis');
    expect(await cleanupPrototypeWorktreeOnReviewPass(plainAnalysis))
      .toEqual({ attempted: false, reason: 'not-analysis-prototype' });

    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('reviewPassed 收口：analysis 原型单 done 后删 worktree 留分支，不触发合并', async () => {
    const wu = await createWu(worktreeMeta({ worktreeBranch: PROTO_BRANCH, prototype: true }), 'in_review', 'analysis');

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('done'); // done 迁移不被收尾阻断

    await waitForReviewPassSettled();
    const cmds = calledCommands();
    expect(cmds.some(c => c.includes('worktree remove --force'))).toBe(true);
    expect(cmds.some(c => c.includes('merge --no-ff'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d') && c.includes(PROTO_BRANCH))).toBe(false);
    const updated = await wuService.getById(wu.id);
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeUndefined();
    expect(updated!.status).toBe('done'); // 不被置 blocked
  });

  it('reviewPassed 普通 analysis（无标记无落档）：行为完全不变（done，无 git，无消息）', async () => {
    const wu = await createWu({}, 'in_review', 'analysis');

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('done');

    // 「不发生」断言：settled 后收尾链已落定（analysis 旁路即时返回），比定长 sleep 窗口更强
    await waitForReviewPassSettled();
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(await studioMessages(wu.id)).toHaveLength(0);
  });
});
