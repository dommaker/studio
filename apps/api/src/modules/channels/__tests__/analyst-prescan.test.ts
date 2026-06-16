/**
 * Analyst PreScan — rule-based scope detection tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

import { preScan, type ScoutScope } from '../analyst-prescan.js';

describe('analyst-prescan: preScan', () => {
  const repoDir = '/tmp/test-repo';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
  });

  it('returns concerns always containing code and knowledge', () => {
    const scope = preScan('简单修复一个按钮颜色', repoDir);
    expect(scope.concerns).toContain('code');
    expect(scope.concerns).toContain('knowledge');
  });

  it('detects schema concern from prisma keyword', () => {
    const scope = preScan('添加新的 Prisma migration 来更新 User 模型', repoDir);
    expect(scope.concerns).toContain('schema');
    expect(scope.modules).toContain('prisma');
    expect(scope.modules).toContain('migration');
  });

  it('detects auth concern from login keyword', () => {
    const scope = preScan('实现 OAuth JWT token 验证', repoDir);
    expect(scope.concerns).toContain('auth');
  });

  it('detects test concern from vitest keyword', () => {
    const scope = preScan('为 executor 添加 vitest mock 测试', repoDir);
    expect(scope.concerns).toContain('test');
  });

  it('detects api concern from endpoint keyword', () => {
    const scope = preScan('添加新的 REST API endpoint', repoDir);
    expect(scope.concerns).toContain('api');
  });

  it('extracts file paths from requirement text', () => {
    const scope = preScan('修改 apps/api/src/modules/channels/channel.routes.ts 的路由', repoDir);
    expect(scope.keyFiles.length).toBeGreaterThan(0);
    expect(scope.keyFiles.some(f => f.includes('channel.routes.ts'))).toBe(true);
  });

  it('extracts directory map from CLAUDE.md', () => {
    const fakeClaudeMd = [
      '# Project',
      '',
      '## Modules',
      '| studio/ | API + Web |',
      '| harness/ | Constraints |',
      '| apps/api/src/modules/ | Core modules |',
    ].join('\n');

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(fakeClaudeMd);

    const scope = preScan('改 channel 模块', repoDir);
    expect(Object.keys(scope.directoryMap).length).toBeGreaterThan(0);
  });

  it('returns empty modules when no keywords match', () => {
    const scope = preScan('改一下颜色样式', repoDir);
    expect(scope.modules).toEqual([]);
  });

  it('handles missing CLAUDE.md gracefully', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => preScan('测试需求', repoDir)).not.toThrow();
  });
});
