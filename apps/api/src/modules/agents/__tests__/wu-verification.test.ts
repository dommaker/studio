/**
 * wu-verification 单测：验证命令解析（覆盖优先于约定）+ 执行语义（短路失败 + 输出尾部）。
 * 覆盖 F6-c 抽出的三个消费方共用的基础行为（agent-loop 守卫 / 强制收口 / POST /verify）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockExecSh, mockGetWorkspaceRecord } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
  mockGetWorkspaceRecord: vi.fn(),
}));
vi.mock('@dommaker/studio-shared/node', () => ({ execSh: mockExecSh }));
vi.mock('../../workspaces/workspace-store', () => ({ getWorkspaceRecord: mockGetWorkspaceRecord }));

import {
  extractExecOutputTail,
  resolveVerifyCommands,
  runWuVerification,
  VERIFY_FAIL_TAIL_CHARS,
} from '../loop/wu-verification.js';
import type { WorkUnitData } from '../../workunit/workunit.service.js';

const wu = (workspaceId: string | null = null) => ({ workspaceId }) as unknown as WorkUnitData;

let tmpDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-verify-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePkg(scripts: Record<string, string>, opts: { pnpmLock?: boolean } = {}) {
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts }));
  if (opts.pnpmLock) fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
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
  it('metadata.verifyCommands 覆盖优先，不读 workspace/约定', async () => {
    writePkg({ test: 't' });
    const r = await resolveVerifyCommands(wu(), { verifyCommands: ['pnpm test --filter x'] }, tmpDir);
    expect(r).toEqual({ commands: ['pnpm test --filter x'], source: 'override' });
    expect(mockGetWorkspaceRecord).not.toHaveBeenCalled();
  });

  it('workspace 记录 verifyCommands 次优（override）', async () => {
    mockGetWorkspaceRecord.mockResolvedValue({ verifyCommands: ['make check'] });
    const r = await resolveVerifyCommands(wu('ws-1'), {}, tmpDir);
    expect(r).toEqual({ commands: ['make check'], source: 'override' });
  });

  it('workspace 读取失败/无覆盖 → 落约定', async () => {
    mockGetWorkspaceRecord.mockRejectedValue(new Error('io'));
    writePkg({ test: 't' });
    const r = await resolveVerifyCommands(wu('ws-1'), {}, tmpDir);
    expect(r.source).toBe('convention');
    expect(r.commands).toEqual(['npm run test']);
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
  it('全绿 → ran 为全部命令，cwd 指向 worktree', async () => {
    mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
    const r = await runWuVerification(wu(), { verifyCommands: ['cmd a', 'cmd b'] }, tmpDir);
    expect(r).toEqual({ ran: ['cmd a', 'cmd b'], source: 'override' });
    expect(mockExecSh).toHaveBeenCalledTimes(2);
    expect(mockExecSh.mock.calls[0][1].cwd).toBe(tmpDir);
  });

  it('任一失败即短路：ran 只含已通过项，failure 带命令与输出尾部', async () => {
    mockExecSh
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce({ stderr: 'assert failed', message: 'exit 1' });
    const r = await runWuVerification(wu(), { verifyCommands: ['ok', 'bad', 'never'] }, tmpDir);
    expect(r.ran).toEqual(['ok']);
    expect(r.failure?.command).toBe('bad');
    expect(r.failure?.tail).toContain('assert failed');
    expect(mockExecSh).toHaveBeenCalledTimes(2); // 第三条不执行
  });

  it('无命令可跑 → ran 空、无 failure（跳过验证维持现状）', async () => {
    const r = await runWuVerification(wu(), {}, tmpDir);
    expect(r).toEqual({ ran: [], source: 'convention' });
    expect(mockExecSh).not.toHaveBeenCalled();
  });
});
