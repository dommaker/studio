import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockExecFile, mockExecSh } = vi.hoisted(() => ({ mockExecFile: vi.fn(), mockExecSh: vi.fn() }));
vi.mock('@dommaker/studio-shared/node', () => ({ execFile: mockExecFile, execSh: mockExecSh }));

import {
  assertTrustedWuWorktree,
  resolveHostPath,
  runHostCheck,
} from '../host-execution-policy.js';

describe('HostExecutionPolicy', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-policy-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'host-policy-outside-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('只接受 worktrees 根内与当前 WU 精确绑定的真实目录', () => {
    const valid = path.join(root, 'wu-current');
    fs.mkdirSync(valid);

    expect(assertTrustedWuWorktree('current', valid, root)).toBe(fs.realpathSync(valid));
    for (const candidate of [root, path.join(root, 'wu-other'), outside]) {
      expect(() => assertTrustedWuWorktree('current', candidate, root)).toThrow(/worktree/);
    }
  });

  it('符号链接越界按拒绝处理', () => {
    const link = path.join(root, 'wu-current');
    fs.symlinkSync(outside, link, 'dir');

    expect(() => assertTrustedWuWorktree('current', link, root)).toThrow(/worktree/);
  });

  it('Spec 文件检查限制在服务端项目根，包含符号链接目标', () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'not-public');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

    expect(resolveHostPath(root, 'ok.txt')).toBe(path.join(fs.realpathSync(root), 'ok.txt'));
    expect(resolveHostPath(root, 'missing.txt')).toBe(path.join(fs.realpathSync(root), 'missing.txt'));
    expect(() => resolveHostPath(root, '../outside')).toThrow(/项目根/);
    expect(() => resolveHostPath(root, 'link.txt')).toThrow(/项目根/);
  });

  it('只执行服务端固定 argv，子进程不继承宿主环境并有资源上限', async () => {
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

    await runHostCheck('test', root);

    expect(mockExecFile).toHaveBeenCalledWith('pnpm', ['exec', 'vitest', 'run'], expect.objectContaining({
      cwd: fs.realpathSync(root),
      timeoutMs: 600_000,
      maxBuffer: 1024 * 1024,
      killProcessGroup: true,
      inheritProcessEnv: false,
    }));
    const options = mockExecFile.mock.calls[0][2];
    expect(Object.keys(options.env)).toEqual(['PATH', 'CI', 'NO_COLOR']);
    expect(mockExecSh).not.toHaveBeenCalled();

    await expect(runHostCheck('custom-command' as never, root)).rejects.toThrow(/未登记/);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});
