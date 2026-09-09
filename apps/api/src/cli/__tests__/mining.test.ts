/**
 * cli/mining.ts flag 解析与退出码映射测试（studio#459）
 *
 * Seam：studioUpdateUserModel / studioAnalyzeSessions(args)。
 * 隔离面：update-user-model / analyze-sessions 命令实现打 mock，
 * 只锁定 args → options 映射与 CommandResult → exitCode 映射。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { studioUpdateUserModel, studioAnalyzeSessions } from '../mining.js';
import { updateUserModel } from '../update-user-model.js';
import { analyzeSessions } from '../analyze-sessions.js';

vi.mock('../update-user-model.js', () => ({ updateUserModel: vi.fn() }));
vi.mock('../analyze-sessions.js', () => ({ analyzeSessions: vi.fn() }));

const mockUum = updateUserModel as vi.Mock;
const mockAnalyze = analyzeSessions as vi.Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockUum.mockResolvedValue({ kind: 'ok' });
  mockAnalyze.mockResolvedValue({ kind: 'ok' });
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe('studioUpdateUserModel flag 解析', () => {
  it('--json --dry-run --days 3 全量映射', async () => {
    await studioUpdateUserModel(['--json', '--dry-run', '--days', '3']);
    expect(mockUum).toHaveBeenCalledWith({ days: 3, json: true, dryRun: true });
  });

  it('--days=7 等号形式', async () => {
    await studioUpdateUserModel(['--days=7']);
    expect(mockUum).toHaveBeenCalledWith({ days: 7, json: false, dryRun: false });
  });

  it('无参数：days undefined，json/dryRun false', async () => {
    await studioUpdateUserModel([]);
    expect(mockUum).toHaveBeenCalledWith({ days: undefined, json: false, dryRun: false });
  });
});

describe('studioAnalyzeSessions flag 解析', () => {
  it('-d 1 --json 映射', async () => {
    await studioAnalyzeSessions(['-d', '1', '--json']);
    expect(mockAnalyze).toHaveBeenCalledWith({ days: 1, json: true });
  });
});

describe('CommandResult → exitCode 映射', () => {
  it('fail → exitCode 1；ok/skip → 0', async () => {
    mockUum.mockResolvedValue({ kind: 'fail', reason: 'boom' });
    await studioUpdateUserModel([]);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    mockUum.mockResolvedValue({ kind: 'skip', reason: '没有新会话可处理' });
    await studioUpdateUserModel([]);
    expect(process.exitCode).toBe(0);
  });
});
