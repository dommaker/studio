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

import { handleDiscover } from '../discover-handler.js';

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
