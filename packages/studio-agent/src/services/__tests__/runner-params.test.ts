/**
 * runner-params 单元测试
 *
 * 覆盖纯参数构建函数：prompt 拼接、session flag、--add-dir、
 * spawn cmd 组装、spawn env，以及 SDD task 层解析（mock SDD 读取）。
 */

import { describe, test, expect, vi } from 'vitest';

const { mockFindSddDocById, mockReadSddDoc } = vi.hoisted(() => ({
  mockFindSddDocById: vi.fn(),
  mockReadSddDoc: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    findSddDocById: mockFindSddDocById,
    readSddDoc: mockReadSddDoc,
  };
});

import {
  buildAugmentedPrompt,
  buildSessionFlag,
  buildAddDirArgs,
  buildSessionCommand,
  buildSessionEnv,
  resolveSddTaskData,
} from '../runner-params.js';
import type { AgentTask } from '../session-manager.js';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    executionId: 'exec-abcdef123456',
    provider: 'claude',
    prompt: 'do something',
    ...overrides,
  };
}

describe('buildAugmentedPrompt', () => {
  test('无 knowledgeContext 时原样返回', () => {
    expect(buildAugmentedPrompt('hello')).toBe('hello');
    expect(buildAugmentedPrompt('hello', '')).toBe('hello');
    expect(buildAugmentedPrompt('hello', '   ')).toBe('hello');
  });

  test('有 knowledgeContext 时前置拼接', () => {
    expect(buildAugmentedPrompt('write code', 'project context'))
      .toBe('project context\n\n---\n\nwrite code');
  });
});

describe('buildSessionFlag', () => {
  test('claude 首个新 session：--session-id + --name', () => {
    expect(buildSessionFlag('claude', 1, true, 'sess-uuid-1', 'exec-abcdef123456'))
      .toBe('--session-id sess-uuid-1 --name "executor-exec-abc"');
  });

  test('claude 首个非新 session / 后续 session：--continue', () => {
    expect(buildSessionFlag('claude', 1, false, 'sess-uuid-1', 'exec-1')).toBe('--continue');
    expect(buildSessionFlag('claude', 2, true, 'sess-uuid-1', 'exec-1')).toBe('--continue');
  });

  test('非 claude provider 不带 session flag', () => {
    expect(buildSessionFlag('kimi', 1, true, 'sess-uuid-1', 'exec-1')).toBe('');
  });
});

describe('buildAddDirArgs', () => {
  test('无 analystContext → 空串', () => {
    expect(buildAddDirArgs(makeTask(), 'claude')).toBe('');
  });

  test('verifiedFiles → 每个文件父目录一个 --add-dir', () => {
    const task = makeTask({
      parameters: { analystContext: { verifiedFiles: ['src/a.ts', 'src/lib/b.ts'] } },
    });
    expect(buildAddDirArgs(task, 'claude')).toBe('--add-dir "src" --add-dir "src/lib"');
  });

  test('verifiedFiles 为空数组 → 空串', () => {
    const task = makeTask({ parameters: { analystContext: { verifiedFiles: [] } } });
    expect(buildAddDirArgs(task, 'claude')).toBe('');
  });
});

describe('buildSessionCommand', () => {
  const base = {
    worktree: '/wt',
    promptFile: '/wt/.daemon/prompt.md',
    sessionFlags: '--continue',
  };

  test('claude：cd 开头、stdin 喂 prompt、2>&1 收尾、--verbose 不重复', () => {
    const cmd = buildSessionCommand({ ...base, provider: 'claude', spawnParams: { worktreeDir: '/wt' } });
    expect(cmd.startsWith('cd "/wt" && claude ')).toBe(true);
    expect(cmd).toContain('< "/wt/.daemon/prompt.md"');
    expect(cmd.endsWith('2>&1')).toBe(true);
    expect(cmd).toContain('--continue');
    expect(cmd.match(/--verbose/g)?.length).toBe(1);
  });

  test('claude：addDirArgs 拼入命令', () => {
    const cmd = buildSessionCommand({
      ...base, provider: 'claude', spawnParams: { worktreeDir: '/wt' }, addDirArgs: '--add-dir "src"',
    });
    expect(cmd).toContain('--add-dir "src"');
  });

  test('promptFlag 型 provider 用 --prompt "$(cat ...)" 形式', () => {
    const cmd = buildSessionCommand({ ...base, provider: 'kimi', spawnParams: { worktreeDir: '/wt' }, sessionFlags: '' });
    expect(cmd).toContain('--prompt "$(cat \"/wt/.daemon/prompt.md\")"');
  });
});

describe('buildSessionEnv', () => {
  test('基础：STUDIO_EXECUTION_ID 注入', () => {
    const env = buildSessionEnv({ task: makeTask(), role: 'executor' });
    expect(env.STUDIO_EXECUTION_ID).toBe('exec-abcdef123456');
    expect(env.STUDIO_WORKUNIT_ID).toBeUndefined();
  });

  test('goalId → STUDIO_GOAL_ID', () => {
    const task = makeTask({ parameters: { goalId: 'goal-9' } });
    const env = buildSessionEnv({ task, role: 'executor' });
    expect(env.STUDIO_GOAL_ID).toBe('goal-9');
  });

  test('withWorkUnitEnv：注入 STUDIO_WORKUNIT_ID 与 extraEnv', () => {
    const task = makeTask({ parameters: { workUnitId: 'wu-7', extraEnv: { FOO: 'bar' } } });
    const env = buildSessionEnv({ task, role: 'executor', withWorkUnitEnv: true });
    expect(env.STUDIO_WORKUNIT_ID).toBe('wu-7');
    expect(env.FOO).toBe('bar');
  });

  test('无 withWorkUnitEnv：不注入 STUDIO_WORKUNIT_ID / extraEnv', () => {
    const task = makeTask({ parameters: { workUnitId: 'wu-7', extraEnv: { FOO: 'bar' } } });
    const env = buildSessionEnv({ task, role: 'executor' });
    expect(env.STUDIO_WORKUNIT_ID).toBeUndefined();
    expect(env.FOO).toBeUndefined();
  });

  // 2026-07-30 走查实锤：root + cwd settings bypassPermissions 下，claude --resume
  // 自注入 --dangerously-skip-permissions 被 root guard 秒拒（code 1）；IS_SANDBOX=1 放行。
  test('IS_SANDBOX 默认注入 1（root 下 --resume 自愈），host 已设则尊重 host', () => {
    const saved = process.env.IS_SANDBOX;
    try {
      delete process.env.IS_SANDBOX;
      expect(buildSessionEnv({ task: makeTask(), role: 'executor' }).IS_SANDBOX).toBe('1');
      process.env.IS_SANDBOX = '0';
      expect(buildSessionEnv({ task: makeTask(), role: 'executor' }).IS_SANDBOX).toBe('0');
    } finally {
      if (saved === undefined) delete process.env.IS_SANDBOX;
      else process.env.IS_SANDBOX = saved;
    }
  });
});

describe('resolveSddTaskData', () => {
  test('无 slug → 回退 DB 值', async () => {
    mockFindSddDocById.mockResolvedValue(null);
    const task = makeTask({ parameters: { contractTests: [{ file: 'a.test.ts', content: 'x' }] } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual([{ file: 'a.test.ts', content: 'x' }]);
    expect(result.testFiles).toEqual([]);
  });

  test('sddSlug + task.md 命中 → 使用 SDD 层数据', async () => {
    mockReadSddDoc.mockResolvedValue({
      body: [
        '## Contract Tests',
        '### src/__tests__/x.test.ts',
        '```typescript',
        "import { test } from 'vitest';",
        '```',
        '## Test Files',
        '- src/__tests__/x.test.ts',
      ].join('\n'),
    });
    const task = makeTask({ parameters: { sddSlug: 'my-feature' } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toHaveLength(1);
    expect(result.contractTests![0].file).toBe('src/__tests__/x.test.ts');
    expect(result.testFiles).toEqual(['src/__tests__/x.test.ts']);
  });

  test('readSddDoc 返回 null → 回退 DB 值', async () => {
    mockReadSddDoc.mockResolvedValue(null);
    const task = makeTask({ parameters: { sddSlug: 'missing', contractTests: [{ file: 'db.test.ts', content: 'y' }] } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual([{ file: 'db.test.ts', content: 'y' }]);
  });

  test('readSddDoc 抛错 → 回退 DB 值', async () => {
    mockReadSddDoc.mockRejectedValue(new Error('io error'));
    const task = makeTask({ parameters: { sddSlug: 'broken' } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toBeUndefined();
    expect(result.testFiles).toEqual([]);
  });
});
