/**
 * Behavioral test: execSh error message includes stderr or falls back to stdout.
 *
 * AC:
 *   1. Error message includes stderr when present
 *   2. Error message falls back to stdout when stderr is empty
 */
import { describe, test, expect } from 'vitest';
import { execFile, execSh } from '../process-io';

const baseOpts = { cwd: '/tmp', timeoutMs: 10_000 };

describe('execSh error message aggregation', () => {
  test('includes stderr when present', async () => {
    await expect(
      execSh('echo "real error" >&2; exit 1', baseOpts),
    ).rejects.toThrow(/real error/);
  });

  test('falls back to stdout when stderr is empty', async () => {
    await expect(
      execSh('echo "stdout-only-error"; exit 1', baseOpts),
    ).rejects.toThrow(/stdout-only-error/);
  });

  test('prefers stderr over stdout when both present', async () => {
    await expect(
      execSh('echo "stderr-msg" >&2; echo "stdout-msg"; exit 1', baseOpts),
    ).rejects.toThrow(/stderr-msg/);
  });

  test('stderr 同样受 maxBuffer 上限约束', async () => {
    await expect(execSh('node -e "process.stderr.write(\'x\'.repeat(2048))"', {
      ...baseOpts,
      maxBuffer: 1024,
      killProcessGroup: true,
    })).rejects.toThrow(/stderr maxBuffer/);
  });

  test('maxBuffer 按 UTF-8 字节数限制非 ASCII 输出', async () => {
    await expect(execSh('node -e "process.stdout.write(\'界\'.repeat(512))"', {
      ...baseOpts,
      maxBuffer: 1024,
      killProcessGroup: true,
    })).rejects.toThrow(/stdout maxBuffer/);
  });

  test('maxBuffer 限制 stdout 与 stderr 的合计字节数', async () => {
    await expect(execSh('node -e "process.stdout.write(\'x\'.repeat(768)); process.stderr.write(\'y\'.repeat(768))"', {
      ...baseOpts,
      maxBuffer: 1024,
      killProcessGroup: true,
    })).rejects.toThrow(/maxBuffer/);
  });

  test('inheritProcessEnv=false 只向子进程传显式白名单环境', async () => {
    process.env.STUDIO_EXEC_SH_TEST_MARKER = 'must-not-leak';
    try {
      const result = await execSh('printf "%s" "${STUDIO_EXEC_SH_TEST_MARKER:-}"', {
        ...baseOpts,
        inheritProcessEnv: false,
        env: { PATH: process.env.PATH },
      });
      expect(result.stdout).toBe('');
    } finally {
      delete process.env.STUDIO_EXEC_SH_TEST_MARKER;
    }
  });
});

describe('execFile argv execution', () => {
  test('直接执行文件且不解释 argv 中的 shell 元字符', async () => {
    const literal = 'literal;echo not-a-command';
    const result = await execFile(process.execPath, [
      '-e', 'process.stdout.write(process.argv[1])', literal,
    ], {
      ...baseOpts,
      inheritProcessEnv: false,
      env: { PATH: process.env.PATH },
    });
    expect(result.stdout).toBe(literal);
  });
});
