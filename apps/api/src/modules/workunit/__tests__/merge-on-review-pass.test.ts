// B3b-ii: 评审通过后自动合并（决策 D1/D3 后半）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；git 调用（execSh）全部 mock。
// 覆盖：合并成功 / 冲突后 rebase 重试成功 / 重试仍冲突转人工（rebase 失败 & 二次 merge 失败）
//       / 防重（mergedAt 哨兵）/ 无 worktree 旁路 / reviewPassed 收口触发与旁路集成
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit.service.js';
import { mergeWorktreeBranchOnReviewPass } from '../merge-on-review-pass.js';

const { mockExecSh, mockPostWuSystemMessage, mockResolvePmoProjectId } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
  mockPostWuSystemMessage: vi.fn(),
  mockResolvePmoProjectId: vi.fn(),
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execSh: mockExecSh };
});

// 2026-08 归因统一：merge-on-review-pass 经 lazy import 的 resolvePmoProjectIdForWU 重解析
// 归属项目 id（不再读 metadata.pmoProjectId 缓存）；mock 按创建期戳 pmoId 解析
vi.mock('../../requirements/pmo-branch-resolver.js', () => ({
  resolvePmoProjectIdForWU: mockResolvePmoProjectId,
}));

// wu-messenger 间谍包装：真实发送保留（消息断言不受影响），另断言委托参数（milestone 等）
vi.mock('../wu-messenger.js', async (importOriginal) => {
  const orig = await importOriginal() as { postWuSystemMessage: (...args: unknown[]) => Promise<unknown> };
  mockPostWuSystemMessage.mockImplementation(orig.postWuSystemMessage);
  return { ...orig, postWuSystemMessage: mockPostWuSystemMessage };
});

const REPO = '/repo/shared';
const WT = '/worktrees/wu-x';
const BRANCH = 'task/wu-1';
const BASE = 'main';
const HEAD = 'deadbeefcafe1234567890';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

function worktreeMeta(extra?: Partial<WorkUnitMetadata>): WorkUnitMetadata {
  return {
    worktreePath: WT,
    worktreeBranch: BRANCH,
    worktreeBaseBranch: BASE,
    worktreeBaseRepo: REPO,
    ...extra,
  };
}

async function createWu(metadata: WorkUnitMetadata, status = 'in_review'): Promise<WorkUnitData> {
  return wuService.create({
    scope: '实现登录接口',
    type: 'task',
    channelId: 'ch-merge',
    status,
    metadata,
  });
}

/** 默认 git mock：全部成功；rev-parse 返回固定 HEAD。失败场景由各用例 mockImplementation 覆盖 */
function mockGit(): void {
  mockExecSh.mockImplementation(async (cmd: string) => {
    if (cmd.includes('rev-parse HEAD')) return { stdout: `${HEAD}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

function calledCommands(): string[] {
  return mockExecSh.mock.calls.map(c => c[0] as string);
}

async function studioMessages(wuId: string) {
  const messages = await fileStore.queryMessages('ch-merge', { workUnitId: wuId });
  return messages.filter(m => m.authorType === 'agent' && m.agentName === 'Studio');
}

async function waitFor(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('waitFor timeout');
}

beforeEach(async () => {
  vi.clearAllMocks();
  // 归属解析 mock 默认实现：按创建期戳 metadata.pmoId 解析（坏 JSON / 无戳 → null）
  mockResolvePmoProjectId.mockImplementation(async (wu: { metadata?: string | null }) => {
    try {
      return (JSON.parse(wu.metadata ?? '{}') as { pmoId?: string }).pmoId ?? null;
    } catch {
      return null;
    }
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-on-review-pass-'));
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

  it('PMO-b：落档 pmoBranch → 合到 PMO 分支的集成交合（不动 baseRepo checkout）', async () => {
    // 2026-08 归因统一：项目 id 不再读 pmoProjectId 缓存，由创建期戳 pmoId 经 resolver 重解析
    const wu = await createWu(worktreeMeta({ pmoBranch: 'PMO-11', pmoId: 'proj-1' }));

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

  it('合并成功：--no-ff merge → 记 mergedAt/mergeCommit → 清理 worktree+分支 → 频道通知', async () => {
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: true, mergeCommit: HEAD });
    const cmds = calledCommands();
    const mergeCmd = cmds.find(c => c.includes('merge --no-ff'));
    expect(mergeCmd).toBeDefined();
    expect(mergeCmd).toContain(REPO);
    expect(mergeCmd).toContain(BRANCH);
    expect(mergeCmd).toContain(`-m 'merge: ${wu.id}`);
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
    const rebaseCmd = cmds.find(c => c.includes(`rebase '${BASE}'`));
    expect(rebaseCmd).toBeDefined();
    expect(rebaseCmd).toContain(WT);
    // 命令顺序：merge → abort → rebase → merge
    const mergeIdx = cmds.map((c, i) => c.includes('merge --no-ff') ? i : -1).filter(i => i >= 0);
    const abortIdx = cmds.findIndex(c => c.includes('merge --abort'));
    const rebaseIdx = cmds.findIndex(c => c.includes(`rebase '${BASE}'`));
    expect(mergeIdx).toHaveLength(2);
    expect(abortIdx).toBeGreaterThan(mergeIdx[0]);
    expect(rebaseIdx).toBeGreaterThan(abortIdx);
    expect(mergeIdx[1]).toBeGreaterThan(rebaseIdx);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).not.toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeDefined();
  });

  it('冲突转人工（rebase 冲突）：取冲突文件清单 → 清理现场 → WU blocked + 频道转人工', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT: content');
      if (cmd.includes(`rebase '${BASE}'`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) {
        return { stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: true, merged: false, conflictFiles: ['src/a.ts', 'src/b.ts'] });
    const cmds = calledCommands();
    // 现场清理：rebase --abort 执行过；不清理 worktree/分支（留人工）
    expect(cmds.some(c => c.includes('rebase --abort'))).toBe(true);
    expect(cmds.some(c => c.includes('worktree remove'))).toBe(false);
    expect(cmds.some(c => c.includes('branch -d'))).toBe(false);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeConflict).toBe(true);
    expect(meta.conflictFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(meta.mergedAt).toBeUndefined();

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

  it('冲突转人工（rebase 成功但二次 merge 仍冲突）：冲突文件取自 baseRepo 现场', async () => {
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
    expect(cmds.some(c => c.includes(`rebase '${BASE}'`))).toBe(true);
    expect(cmds.filter(c => c.includes('merge --abort'))).not.toHaveLength(0);

    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('blocked');
    const msgs = await studioMessages(wu.id);
    expect(msgs[0].content).toContain('src/x.ts');
  });

  it('防重：metadata.mergedAt 已存在 → 跳过，无任何 git 调用', async () => {
    const wu = await createWu(worktreeMeta({ mergedAt: new Date().toISOString(), mergeCommit: HEAD }));

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: false, reason: 'already-merged' });
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(await studioMessages(wu.id)).toHaveLength(0);
  });

  it('无 worktree 旁路：metadata 无 worktree 落档 → 跳过，无任何 git 调用', async () => {
    const wu = await createWu({}); // analysis 等非代码类 WU：无 worktree 字段

    const outcome = await mergeWorktreeBranchOnReviewPass(wuService, wu, fileStore);

    expect(outcome).toEqual({ attempted: false, reason: 'no-worktree' });
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(await studioMessages(wu.id)).toHaveLength(0);
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('in_review'); // 状态不被合并模块触碰
  });

  it('reviewPassed 收口触发：有 worktree 落档的 WU 评审通过后自动合并（best-effort 不阻断 done）', async () => {
    const wu = await createWu(worktreeMeta());

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('done'); // done 迁移不被合并阻断

    await waitFor(async () => {
      const updated = await wuService.getById(wu.id);
      const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
      return typeof meta.mergedAt === 'string';
    });
    const cmds = calledCommands();
    expect(cmds.some(c => c.includes('merge --no-ff'))).toBe(true);
    const msgs = await studioMessages(wu.id);
    expect(msgs.some(m => m.content.includes(`已合并到 ${BASE}`))).toBe(true);
  });

  it('reviewPassed 旁路：无 worktree 落档的 WU 行为完全不变（done，无 git，无消息）', async () => {
    const wu = await createWu({}, 'in_review');

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('done');
    expect(passed.completedAt).not.toBeNull();

    await new Promise(r => setTimeout(r, 150)); // 给 best-effort 分支充分执行窗口
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(await studioMessages(wu.id)).toHaveLength(0);
    const updated = await wuService.getById(wu.id);
    expect(updated!.status).toBe('done'); // 不被置 blocked
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergedAt).toBeUndefined();
    expect(meta.mergeConflict).toBeUndefined();
  });

  it('reviewPassed 合并冲突：done 迁移完成后 WU 被置 blocked 转人工', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT');
      if (cmd.includes(`rebase '${BASE}'`)) throw new Error('rebase conflict');
      if (cmd.includes('diff --name-only --diff-filter=U')) return { stdout: 'src/a.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const wu = await createWu(worktreeMeta());

    const passed = await wuService.reviewPassed(wu.id);
    expect(passed.status).toBe('done'); // 冲突不回滚评审结论

    await waitFor(async () => (await wuService.getById(wu.id))!.status === 'blocked');
    const updated = await wuService.getById(wu.id);
    const meta = JSON.parse(updated!.metadata!) as WorkUnitMetadata;
    expect(meta.mergeConflict).toBe(true);
    expect(meta.conflictFiles).toEqual(['src/a.ts']);
    const msgs = await studioMessages(wu.id);
    expect(msgs.some(m => m.content.includes('转人工'))).toBe(true);
  });
});
