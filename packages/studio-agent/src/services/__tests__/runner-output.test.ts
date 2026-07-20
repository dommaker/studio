/**
 * runner-output 单元测试
 *
 * 覆盖 hasRecentActivity（真实 tmpdir）与 queryResolutionHints（mock FileStore）。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockListDocs, mockReadDoc } = vi.hoisted(() => ({
  mockListDocs: vi.fn(),
  mockReadDoc: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: class {
      listDocs = mockListDocs;
      readDoc = mockReadDoc;
    },
  };
});

import { hasRecentActivity, queryResolutionHints } from '../runner-output.js';

describe('hasRecentActivity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-output-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('空目录 → false', () => {
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('阈值内有文件改动 → true', () => {
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export {}');
    expect(hasRecentActivity(tmpDir)).toBe(true);
  });

  test('文件 mtime 超出阈值 → false', () => {
    const filePath = path.join(tmpDir, 'old.ts');
    fs.writeFileSync(filePath, 'old');
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, oldTime, oldTime);
    expect(hasRecentActivity(tmpDir, 3 * 60 * 1000)).toBe(false);
  });

  test('.progress.json / .agent.log / node_modules 不计入', () => {
    fs.writeFileSync(path.join(tmpDir, '.progress.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.agent.log'), 'log');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'x');
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('目录不存在 → false', () => {
    expect(hasRecentActivity('/nonexistent/path/xyz')).toBe(false);
  });
});

describe('queryResolutionHints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDocs.mockResolvedValue(['resolution-abc', 'note-x']);
    mockReadDoc.mockImplementation(async (_dir: string, key: string) => {
      if (key !== 'resolution-abc') return null;
      return {
        meta: { maturity: 'verified', pattern: 'boom error', title: 'Boom', verifyCount: 3 },
        body: '# Boom\n## Solution\napply the fix',
      };
    });
  });

  test('错误信息命中 resolution 模式 → 返回 hint 文本', async () => {
    const hint = await queryResolutionHints('a BOOM ERROR happened');
    expect(hint).toContain('已知解法 (RKB)');
    expect(hint).toContain('- **Boom**: apply the fix');
  });

  test('无匹配 → 返回空串', async () => {
    expect(await queryResolutionHints('some unrelated failure')).toBe('');
  });

  test('非 verified/canonical 文档被过滤', async () => {
    mockReadDoc.mockResolvedValue({
      meta: { maturity: 'draft', pattern: 'boom error', title: 'Boom', verifyCount: 0 },
      body: '# Boom\nfix',
    });
    expect(await queryResolutionHints('a boom error happened')).toBe('');
  });

  test('查询失败（listDocs 抛错）→ 返回空串', async () => {
    mockListDocs.mockRejectedValue(new Error('fs error'));
    expect(await queryResolutionHints('a boom error happened')).toBe('');
  });
});
