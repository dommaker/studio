import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../file-store';

let tmpDir: string;
let docsDir: string;
let outsideDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-docs-security-'));
  docsDir = path.join(tmpDir, 'docs');
  outsideDir = path.join(tmpDir, 'outside');
  fs.mkdirSync(docsDir);
  fs.mkdirSync(outsideDir);
  store = new FileStore(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function outsideFile(name = 'outside.md', content = 'outside sentinel') {
  const filePath = path.join(outsideDir, name);
  fs.writeFileSync(filePath, content);
  return { filePath, content };
}

describe('FileStore Markdown 文档键与 no-follow 边界（SEC-04）', () => {
  it('readDoc/writeDoc/deleteDoc 统一拒绝绝对路径、分隔符和 ..', async () => {
    const outside = outsideFile();
    const operations = {
      read: (key: string) => store.readDoc(docsDir, key),
      write: (key: string) => store.writeDoc(docsDir, key, {}, 'must not escape'),
      delete: (key: string) => store.deleteDoc(docsDir, key),
    };
    for (const [name, operation] of Object.entries(operations)) {
      for (const key of ['../outside', '/absolute', 'nested/name', 'nested\\name', '..', 'safe..name']) {
        await expect(operation(key), `${name} must reject ${JSON.stringify(key)}`)
          .rejects.toThrow('Invalid document key');
      }
    }
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
  });

  it('已存在文档 symlink 不可读、不可写、不可经 deleteDoc 跟随', async () => {
    const outside = outsideFile();
    fs.symlinkSync(outside.filePath, path.join(docsDir, 'linked.md'));

    await expect(store.readDoc(docsDir, 'linked')).rejects.toThrow();
    await expect(store.writeDoc(docsDir, 'linked', {}, 'must not escape')).rejects.toThrow();
    await expect(store.deleteDoc(docsDir, 'linked')).rejects.toThrow();
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
  });

  it('文档目录 symlink 不可读，新建文件也不会落到越界目录', async () => {
    const outside = outsideFile('existing.md');
    fs.rmSync(docsDir, { recursive: true });
    fs.symlinkSync(outsideDir, docsDir);

    await expect(store.readDoc(docsDir, 'existing')).rejects.toThrow();
    await expect(store.writeDoc(docsDir, 'new', {}, 'must not escape')).rejects.toThrow();
    await expect(store.deleteDoc(docsDir, 'existing')).rejects.toThrow();
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
    expect(fs.existsSync(path.join(outsideDir, 'new.md'))).toBe(false);
  });

  it('真实父目录检查后最终文件被替换为 symlink 时读写均 fail-closed', async () => {
    const outside = outsideFile();
    const target = path.join(docsDir, 'race.md');
    fs.writeFileSync(target, 'original');
    const replaceWithSymlink = () => {
      if (fs.existsSync(path.join(docsDir, 'original.md'))) return;
      fs.renameSync(target, path.join(docsDir, 'original.md'));
      fs.symlinkSync(outside.filePath, target);
    };
    const realpath = fs.promises.realpath.bind(fs.promises);
    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async targetPath => {
      replaceWithSymlink();
      return realpath(targetPath);
    });
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      replaceWithSymlink();
      return readFile(...args);
    });

    await expect(store.readDoc(docsDir, 'race')).rejects.toThrow();
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
  });

  it('写入打开前最终文件被替换为 symlink 时不覆盖越界目标', async () => {
    const outside = outsideFile();
    const target = path.join(docsDir, 'race.md');
    fs.writeFileSync(target, 'original');
    const replaceWithSymlink = () => {
      if (fs.existsSync(path.join(docsDir, 'original.md'))) return;
      fs.renameSync(target, path.join(docsDir, 'original.md'));
      fs.symlinkSync(outside.filePath, target);
    };
    const realpath = fs.promises.realpath.bind(fs.promises);
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async targetPath => {
      replaceWithSymlink();
      return realpath(targetPath);
    });
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      replaceWithSymlink();
      return writeFile(...args);
    });

    await expect(store.writeDoc(docsDir, 'race', {}, 'must not escape')).rejects.toThrow();
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
  });

  it('父目录在检查后替换为 symlink 时 fail-closed 且不越界写入', async () => {
    const outside = outsideFile();
    const replaceParent = () => {
      if (fs.existsSync(path.join(tmpDir, 'docs-original'))) return;
      fs.renameSync(docsDir, path.join(tmpDir, 'docs-original'));
      fs.symlinkSync(outsideDir, docsDir);
    };
    const realpath = fs.promises.realpath.bind(fs.promises);
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async targetPath => {
      replaceParent();
      return realpath(targetPath);
    });
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      replaceParent();
      return writeFile(...args);
    });

    await expect(store.writeDoc(docsDir, 'race', {}, 'safe body')).rejects.toThrow();
    expect(fs.existsSync(path.join(outsideDir, 'race.md'))).toBe(false);
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
    expect(fs.existsSync(path.join(tmpDir, 'docs-original', 'race.md'))).toBe(false);
  });

  it('合法文档读写删除与自动建目录不回归', async () => {
    const nested = path.join(tmpDir, 'nested', 'docs');
    await store.writeDoc(nested, '2026-Q4', { title: 'valid' }, 'body');
    expect((await store.readDoc(nested, '2026-Q4'))?.meta.title).toBe('valid');
    await store.deleteDoc(nested, '2026-Q4');
    expect(await store.readDoc(nested, '2026-Q4')).toBeNull();
  });

  it('writeDoc 原子替换：rename 失败保留原文并清理临时文件', async () => {
    const target = path.join(docsDir, 'atomic.md');
    await store.writeDoc(docsDir, 'atomic', { title: 'old' }, 'original body');
    const openSpy = vi.spyOn(fs.promises, 'open');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));

    await expect(store.writeDoc(docsDir, 'atomic', { title: 'new' }, 'must not truncate')).rejects.toThrow('injected rename failure');
    expect(fs.readFileSync(target, 'utf8')).toContain('original body');
    expect(fs.readFileSync(target, 'utf8')).not.toContain('must not truncate');
    expect(fs.readdirSync(docsDir).filter(name => name.includes('.tmp-'))).toEqual([]);
    expect(openSpy.mock.calls.some(call => (Number(call[1]) & fs.constants.O_EXCL) !== 0)).toBe(true);
  });

  it('deleteDoc 安全打开后被替换为 symlink 时只移除链接，不读取或删除外部目标', async () => {
    const target = path.join(docsDir, 'race.md');
    const original = path.join(docsDir, 'race-original.md');
    const outside = outsideFile('delete-source.md', 'must survive');
    fs.writeFileSync(target, 'original');
    const open = fs.promises.open.bind(fs.promises);
    let replaced = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!replaced && String(args[0]).endsWith('/race.md')) {
        replaced = true;
        fs.renameSync(target, original);
        fs.symlinkSync(outside.filePath, target);
      }
      return handle;
    });

    await expect(store.deleteDoc(docsDir, 'race')).resolves.toBeUndefined();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(outside.filePath, 'utf8')).toBe(outside.content);
    expect(fs.readFileSync(original, 'utf8')).toBe('original');
  });
});
