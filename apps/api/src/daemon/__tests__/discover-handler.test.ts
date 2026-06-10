/**
 * Discover Handler tests — P6-03 directory scanning
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleDiscover, handleDiscoverRecursive } from '../discover-handler.js';

describe('handleDiscover', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists immediate children directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.mkdirSync(path.join(tmpDir, 'docs'));

    const result = await handleDiscover(tmpDir, '');

    expect(result).toHaveLength(2);
    const names = result.map(e => e.path);
    expect(names).toContain('src');
    expect(names).toContain('docs');
  });

  it('detects git-repo type', async () => {
    fs.mkdirSync(path.join(tmpDir, 'my-project', '.git'), { recursive: true });

    const result = await handleDiscover(tmpDir, '');

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('my-project');
    expect(result[0].type).toBe('git-repo');
  });

  it('detects directory type', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));

    const result = await handleDiscover(tmpDir, '');

    expect(result[0].type).toBe('directory');
  });

  it('returns lastModified in ISO format', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));

    const result = await handleDiscover(tmpDir, '');

    expect(result[0].lastModified).toBeDefined();
    expect(new Date(result[0].lastModified).toISOString()).toBe(result[0].lastModified);
  });

  it('scans subdirectory when path provided', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });

    const result = await handleDiscover(tmpDir, 'src');

    expect(result).toHaveLength(2);
    const names = result.map(e => e.path);
    expect(names).toContain('src/components');
    expect(names).toContain('src/utils');
  });

  it('returns empty for nonexistent path', async () => {
    const result = await handleDiscover(tmpDir, 'nonexistent');
    expect(result).toEqual([]);
  });

  it('skips files, only lists directories', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');
    fs.mkdirSync(path.join(tmpDir, 'dir'));

    const result = await handleDiscover(tmpDir, '');

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('dir');
  });

  it('throws on path traversal', async () => {
    await expect(handleDiscover(tmpDir, '../../etc')).rejects.toThrow('Path traversal blocked');
  });
});

describe('handleDiscoverRecursive', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-recursive-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds git repos in nested directories (company structure)', async () => {
    // qunar/backend/repo-a(.git), qunar/backend/repo-b(.git)
    fs.mkdirSync(path.join(tmpDir, 'backend', 'repo-a', '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'backend', 'repo-b', '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'fekit', 'repo-c', '.git'), { recursive: true });

    const result = await handleDiscoverRecursive(tmpDir, 3);

    expect(result).toHaveLength(3);
    const paths = result.map(e => e.path);
    expect(paths).toContain('backend/repo-a');
    expect(paths).toContain('backend/repo-b');
    expect(paths).toContain('fekit/repo-c');
  });

  it('extracts category from parent directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'backend', 'repo-a', '.git'), { recursive: true });

    const result = await handleDiscoverRecursive(tmpDir, 3);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('backend');
    expect(result[0].name).toBe('repo-a');
  });

  it('respects maxDepth limit', async () => {
    // depth 4: workspace/category/sub/repo(.git)
    fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'repo', '.git'), { recursive: true });

    // maxDepth=2 should NOT find it (needs depth 3)
    const shallow = await handleDiscoverRecursive(tmpDir, 2);
    expect(shallow).toHaveLength(0);

    // maxDepth=3 should find it
    const deep = await handleDiscoverRecursive(tmpDir, 3);
    expect(deep).toHaveLength(1);
  });

  it('detects .git file (submodule) as git-repo', async () => {
    fs.mkdirSync(path.join(tmpDir, 'submod'));
    fs.writeFileSync(path.join(tmpDir, 'submod', '.git'), 'gitdir: ../.git/modules/submod');

    const result = await handleDiscoverRecursive(tmpDir, 3);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('git-repo');
  });

  it('skips non-git directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'backend', 'not-a-repo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'backend', 'real-repo', '.git'), { recursive: true });

    const result = await handleDiscoverRecursive(tmpDir, 3);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('backend/real-repo');
  });

  it('finds repos at workspaceRoot level (2-level structure)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'studio', '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'harness', '.git'), { recursive: true });

    const result = await handleDiscoverRecursive(tmpDir, 3);

    expect(result).toHaveLength(2);
    const paths = result.map(e => e.path);
    expect(paths).toContain('studio');
    expect(paths).toContain('harness');
  });

  it('returns empty for empty directory', async () => {
    const result = await handleDiscoverRecursive(tmpDir, 3);
    expect(result).toEqual([]);
  });
});
