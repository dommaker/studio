/**
 * wu-verification 单测：固定检查模板 + WU cwd provenance + 执行语义。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockExecSh } = vi.hoisted(() => ({ mockExecSh: vi.fn() }));
vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  extractExecOutputTail,
  resolveVerifyCommands,
  runWuVerification,
  VERIFY_FAIL_TAIL_CHARS,
} from '../wu-verification.js';
import type { WorkUnitData } from '../../workunit/workunit-crud.js';
import type { WorkUnitMetadata } from '../../workunit/workunit.types.js';

const wu = () => ({ id: 'wu-1' }) as WorkUnitData;

let tmpDir: string;
let previousWorktreesDir: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  previousWorktreesDir = process.env.WORKTREES_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-verify-'));
  process.env.WORKTREES_DIR = tmpDir;
});
afterEach(() => {
  if (previousWorktreesDir === undefined) delete process.env.WORKTREES_DIR;
  else process.env.WORKTREES_DIR = previousWorktreesDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePkg(scripts: Record<string, string>, opts: { pnpmLock?: boolean } = {}, dir = tmpDir) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  if (opts.pnpmLock) fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
}

function createWorktree(): string {
  const dir = path.join(tmpDir, 'wu-wu-1');
  fs.mkdirSync(dir);
  return dir;
}

describe('extractExecOutputTail', () => {
  it('拼接 stderr/stdout/message 并从尾部截断', () => {
    const tail = extractExecOutputTail({ stderr: 'e1', stdout: 'o1', message: 'm1' }, 100);
    expect(tail).toBe('e1\no1\nm1');
    const long = extractExecOutputTail({ message: 'x'.repeat(5000) }, VERIFY_FAIL_TAIL_CHARS);
    expect(long.length).toBe(VERIFY_FAIL_TAIL_CHARS);
  });

  it('非对象错误按字符串处理；空字段跳过', () => {
    expect(extractExecOutputTail('boom', 100)).toBe('boom');
    expect(extractExecOutputTail({ stderr: '', message: 'm' }, 100)).toBe('m');
  });
});

describe('resolveVerifyCommands', () => {
  it('metadata/workspace 自定义命令不能改变服务端检查模板', async () => {
    writePkg({ test: 't' });
    const r = await resolveVerifyCommands(wu(), { verifyCommands: ['custom-command'] }, tmpDir);
    expect(r).toEqual({ commands: ['npm run test'], source: 'convention' });
  });

  it('约定：按 scripts 存在性依次取 test/typecheck/lint，lockfile 选 pnpm', async () => {
    writePkg({ typecheck: 'tsc', test: 't', lint: 'l' }, { pnpmLock: true });
    const r = await resolveVerifyCommands(wu(), {}, tmpDir);
    expect(r).toEqual({ commands: ['pnpm run test', 'pnpm run typecheck', 'pnpm run lint'], source: 'convention' });
  });

  it('约定：无 scripts / 无 package.json / 坏 JSON → 空数组', async () => {
    writePkg({ build: 'b' });
    expect((await resolveVerifyCommands(wu(), {}, tmpDir)).commands).toEqual([]);
    expect((await resolveVerifyCommands(wu(), {}, path.join(tmpDir, 'nope'))).commands).toEqual([]);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{broken');
    expect((await resolveVerifyCommands(wu(), {}, tmpDir)).commands).toEqual([]);
  });
});

describe('runWuVerification', () => {
  it('伪造 worktree 在 spawn 前拒绝', async () => {
    await expect(runWuVerification(wu(), { verifyCommands: ['custom-command'] }, tmpDir))
      .rejects.toThrow(/worktree/);
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('合法 worktree 全绿，篡改 metadata 不改变执行定义', async () => {
    const worktree = createWorktree();
    writePkg({ test: 't', typecheck: 'tsc' }, {}, worktree);
    mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });

    const r = await runWuVerification(wu(), { verifyCommands: ['custom-command'] }, worktree);

    expect(r).toEqual({ ran: ['npm run test', 'npm run typecheck'], source: 'convention' });
    expect(mockExecSh).toHaveBeenCalledTimes(2);
    expect(mockExecSh.mock.calls[0][0]).toBe('npm run test');
    expect(mockExecSh.mock.calls[0][1].cwd).toBe(fs.realpathSync(worktree));
  });

  it('篡改项目 scripts 与 Agent metadata 仍不能注入自定义命令、cwd 或 env', async () => {
    const worktree = createWorktree();
    writePkg({ test: 'custom-command --injected', custom: 'custom-command' }, {}, worktree);
    mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });

    const r = await runWuVerification(wu(), {
      verifyCommands: ['custom-command'],
      cwd: '/tmp',
      env: { INJECTED: '1' },
    } as WorkUnitMetadata, worktree);

    expect(r).toEqual({ ran: ['npm run test'], source: 'convention' });
    expect(mockExecSh).toHaveBeenCalledTimes(1);
    expect(mockExecSh).toHaveBeenCalledWith('npm run test', expect.objectContaining({
      cwd: fs.realpathSync(worktree),
      inheritProcessEnv: false,
    }));
    expect(mockExecSh.mock.calls[0][1].env).not.toHaveProperty('INJECTED');
  });

  it('任一失败即短路：ran 只含已通过项，failure 带命令与输出尾部', async () => {
    const worktree = createWorktree();
    writePkg({ test: 't', typecheck: 'tsc', lint: 'l' }, {}, worktree);
    mockExecSh
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce({ stderr: 'assert failed', message: 'exit 1' });

    const r = await runWuVerification(wu(), {}, worktree);

    expect(r.ran).toEqual(['npm run test']);
    expect(r.failure?.command).toBe('npm run typecheck');
    expect(r.failure?.tail).toContain('assert failed');
    expect(mockExecSh).toHaveBeenCalledTimes(2);
  });

  it('无命令可跑 → ran 空、无 failure（跳过验证维持现状）', async () => {
    const worktree = createWorktree();
    const r = await runWuVerification(wu(), {}, worktree);
    expect(r).toEqual({ ran: [], source: 'convention' });
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('合并后验证可使用服务端合并场景 cwd', async () => {
    writePkg({ test: 't' });
    mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
    const r = await runWuVerification(wu(), {}, tmpDir, { cwdProvenance: 'merge-target' });
    expect(r.ran).toEqual(['npm run test']);
    expect(mockExecSh).toHaveBeenCalledTimes(1);
  });
});
