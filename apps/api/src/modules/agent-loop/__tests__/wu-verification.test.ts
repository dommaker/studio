/**
 * wu-verification 单测：固定检查模板 + WU cwd provenance + 执行语义。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockExecFile, mockExecSh } = vi.hoisted(() => ({ mockExecFile: vi.fn(), mockExecSh: vi.fn() }));
vi.mock('@dommaker/studio-shared/node', async importOriginal => ({
  ...await importOriginal<typeof import('@dommaker/studio-shared/node')>(),
  execFile: mockExecFile,
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
    expect(r).toEqual({ commands: ['test'], source: 'convention' });
  });

  it('约定：按 scripts 存在性依次取 test/typecheck/lint，lockfile 不改变模板', async () => {
    writePkg({ typecheck: 'tsc', test: 't', lint: 'l' }, { pnpmLock: true });
    const r = await resolveVerifyCommands(wu(), {}, tmpDir);
    expect(r).toEqual({ commands: ['test', 'typecheck', 'lint'], source: 'convention' });
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
  it('恶意 package script 只启用检查，不进入 shell 或成为宿主 argv', async () => {
    const worktree = createWorktree();
    writePkg({ test: 'host-side-effect-must-not-run --from-package-script' }, {}, worktree);
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    await runWuVerification(wu(), {}, worktree);

    expect(mockExecSh).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'vitest', 'run'], expect.any(Object));
    expect(JSON.stringify(mockExecFile.mock.calls)).not.toContain('host-side-effect-must-not-run');
  });

  it('伪造 worktree 在 spawn 前拒绝', async () => {
    await expect(runWuVerification(wu(), { verifyCommands: ['custom-command'] }, tmpDir))
      .rejects.toThrow(/worktree/);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('合法 worktree 全绿，三个固定模板均按预期 argv 调用', async () => {
    const worktree = createWorktree();
    writePkg({ test: 't', typecheck: 'tsc', lint: 'l' }, {}, worktree);
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const r = await runWuVerification(wu(), { verifyCommands: ['custom-command'] }, worktree);

    expect(r).toEqual({ ran: ['test', 'typecheck', 'lint'], source: 'convention' });
    expect(mockExecFile.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['pnpm', ['exec', 'vitest', 'run']],
      ['pnpm', ['exec', 'tsc', '--noEmit']],
      ['pnpm', ['exec', 'eslint', '.']],
    ]);
    expect(mockExecFile.mock.calls[0][2].cwd).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('篡改项目 scripts 与 Agent metadata 仍不能注入自定义命令、cwd 或 env', async () => {
    const worktree = createWorktree();
    writePkg({ test: 'custom-command --injected', custom: 'custom-command' }, {}, worktree);
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    const r = await runWuVerification(wu(), {
      verifyCommands: ['custom-command'],
      cwd: '/tmp',
      env: { INJECTED: '1' },
    } as WorkUnitMetadata, worktree);

    expect(r).toEqual({ ran: ['test'], source: 'convention' });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'vitest', 'run'], expect.objectContaining({
      cwd: expect.stringMatching(/^\/proc\/\d+\/fd\/\d+$/),
      inheritProcessEnv: false,
    }));
    expect(mockExecFile.mock.calls[0][2].env).not.toHaveProperty('INJECTED');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('任一失败即短路：ran 只含已通过项，failure 带检查名与输出尾部', async () => {
    const worktree = createWorktree();
    writePkg({ test: 't', typecheck: 'tsc', lint: 'l' }, {}, worktree);
    mockExecFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce({ stderr: 'assert failed', message: 'exit 1' });

    const r = await runWuVerification(wu(), {}, worktree);

    expect(r.ran).toEqual(['test']);
    expect(r.failure?.command).toBe('typecheck');
    expect(r.failure?.tail).toContain('assert failed');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('无命令可跑 → ran 空、无 failure（跳过验证维持现状）', async () => {
    const worktree = createWorktree();
    const r = await runWuVerification(wu(), {}, worktree);
    expect(r).toEqual({ ran: [], source: 'convention' });
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('合并后验证可使用服务端合并场景 cwd', async () => {
    writePkg({ test: 't' });
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    const r = await runWuVerification(wu(), {}, tmpDir, { cwdProvenance: 'merge-target' });
    expect(r.ran).toEqual(['test']);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecSh).not.toHaveBeenCalled();
  });
});
