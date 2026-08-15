/**
 * runner-params 单元测试
 *
 * 覆盖纯参数构建函数：prompt 拼接、session flag、--add-dir、
 * spawn cmd 组装、spawn env。
 * （#155：resolveSddTaskData 已随 SDD 体系退役删除，相关用例一并移除）
 */

import { describe, test, expect, vi } from 'vitest';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import {
  buildAugmentedPrompt,
  buildSessionFlag,
  buildAddDirArgs,
  buildSessionCommand,
  buildSessionEnv,
} from '../runner-params.js';
import type { AgentTask } from '../types.js';

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

  // #147 P1：kimi 多 WU 隔离——KIMI_CODE_HOME 仅在 provider=kimi 且 per-worktree
  // home 已生成（config.toml 存在）时注入；否则回落全局 home。
  test('kimi + per-worktree home 已生成 → 注入 KIMI_CODE_HOME', () => {
    const wt = fsSync.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
    try {
      fsSync.mkdirSync(path.join(wt, '.kimi-code'), { recursive: true });
      fsSync.writeFileSync(path.join(wt, '.kimi-code', 'config.toml'), 'x\n', 'utf-8');

      const env = buildSessionEnv({ task: makeTask({ provider: 'kimi' }), role: 'executor', worktree: wt });
      expect(env.KIMI_CODE_HOME).toBe(path.join(wt, '.kimi-code'));
    } finally {
      fsSync.rmSync(wt, { recursive: true, force: true });
    }
  });

  test('kimi 但 home 未生成 → 不注入（回落全局 home）', () => {
    const wt = fsSync.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
    try {
      const env = buildSessionEnv({ task: makeTask({ provider: 'kimi' }), role: 'executor', worktree: wt });
      expect(env.KIMI_CODE_HOME).toBeUndefined();
    } finally {
      fsSync.rmSync(wt, { recursive: true, force: true });
    }
  });

  test('非 kimi provider 不注入 KIMI_CODE_HOME', () => {
    const wt = fsSync.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
    try {
      fsSync.mkdirSync(path.join(wt, '.kimi-code'), { recursive: true });
      fsSync.writeFileSync(path.join(wt, '.kimi-code', 'config.toml'), 'x\n', 'utf-8');

      const env = buildSessionEnv({ task: makeTask({ provider: 'claude' }), role: 'executor', worktree: wt });
      expect(env.KIMI_CODE_HOME).toBeUndefined();
    } finally {
      fsSync.rmSync(wt, { recursive: true, force: true });
    }
  });
});
