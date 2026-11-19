/**
 * DocsStore — 扁平目录清单与 Markdown 文档域 store（#681 P1-1 组合化：自
 * FileStoreDocsBase 继承层转型为构造注入 FileStoreCore 的独立 store；
 * #670 自 file-store.ts 拆出，PURE_MOVE）
 *
 * 承载：扁平目录 JSON 清单原语 listJsonInDir（#362 收编单点）、
 * Markdown 读写（frontmatter，读穿缓存 #321）、索引管理 buildIndex/listDocs、
 * appendChangelog。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isErrnoError } from './file-store-base';
import type { FileStoreCore } from './file-store-core';
import { mdCache, cacheSet, cloneCached, collectNonNull, invalidateFileKey, invalidateRemovedPath } from './cache-primitives';
import { parseFrontmatter, serializeFrontmatter } from '../frontmatter';

const DIR_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function unsafeDocPath(message: string): Error {
  return new Error(`Unsafe document path: ${message}`);
}

/** Markdown key 必须是单文件段；调用方用 dir 表达层级，不在 key 中夹带路径。 */
function resolveDocFile(dir: string, key: string): string {
  if (!key || path.isAbsolute(key) || key.includes('/') || key.includes('\\') || key.includes('..')) {
    throw new Error(`Invalid document key: ${JSON.stringify(key)}`);
  }
  const resolvedDir = path.resolve(dir);
  const filePath = path.resolve(resolvedDir, `${key}.md`);
  if (path.dirname(filePath) !== resolvedDir) throw unsafeDocPath('resolved file escapes its document directory');
  return filePath;
}

function fdPath(fd: number, child?: string): string {
  return `/proc/${process.pid}/fd/${fd}${child ? `/${child}` : ''}`;
}

/** 打开并固定真实父目录；realpath(fd) 防止任一路径段经 symlink 改道。 */
async function openRealDir(dir: string): Promise<fs.promises.FileHandle> {
  const resolved = path.resolve(dir);
  const handle = await fs.promises.open(resolved, DIR_OPEN_FLAGS);
  try {
    if (await fs.promises.realpath(fdPath(handle.fd)) !== resolved) {
      throw unsafeDocPath('real parent differs from the expected document directory');
    }
    return handle;
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/** 逐级 no-follow 建目录，避免 recursive mkdir 在校验前经 symlink 写到界外。 */
async function createRealDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  let current = await fs.promises.open(root, DIR_OPEN_FLAGS);
  try {
    for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      let next: fs.promises.FileHandle;
      try {
        next = await fs.promises.open(fdPath(current.fd, segment), DIR_OPEN_FLAGS);
      } catch (err) {
        if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
        await fs.promises.mkdir(fdPath(current.fd, segment));
        next = await fs.promises.open(fdPath(current.fd, segment), DIR_OPEN_FLAGS);
      }
      await current.close();
      current = next;
    }
  } finally {
    await current.close();
  }
}

async function openDocParent(dir: string, create: boolean): Promise<fs.promises.FileHandle> {
  try {
    return await openRealDir(dir);
  } catch (err) {
    if (!create || !isErrnoError(err) || err.code !== 'ENOENT') throw err;
    await createRealDir(dir);
    return openRealDir(dir);
  }
}

// ─── DocsStore 类 ───

export class DocsStore {
  private readonly ctx: FileStoreCore;

  constructor(ctx: FileStoreCore) {
    this.ctx = ctx;
  }

  // ═══════════════════════
  // 扁平目录 JSON 清单原语（#362 收编单点）
  // ═══════════════════════

  /**
   * 扁平目录 JSON 实体清单：扫描 {dir}/*.json 全量读取，损坏/缺失文件跳过；
   * 目录不存在返回 []（不建目录）。与目录型实体的差异是实体直接平铺为文件、无子目录。
   * 消费方：apps/api mcp tool-store.listJsonFiles。
   */
  public async listJsonInDir<T>(dir: string): Promise<T[]> {
    let entries: fs.Dirent[];
    try {
      entries = await this.ctx.io.readdirCached(dir);
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
    const results = await Promise.all(entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => this.ctx.io.readJson<T>(path.join(dir, e.name))));
    return collectNonNull(results);
  }

  // ═══════════════════════
  // Markdown 读写（Phase 1: spec-2a filestore-unification）
  // ═══════════════════════

  /**
   * 读取 markdown 文件，解析 frontmatter + body（#321：读穿缓存，mtime 校验）。
   * 文件不存在返回 null。命中返回结构克隆。
   */
  async readDoc(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string } | null> {
    const entry = await this.readDocCached(dir, key);
    return entry ? { meta: entry.meta, body: entry.body } : null;
  }

  /**
   * readDoc + 校验用 mtimeMs（#321）：library 聚合读层的 updatedAt 兜底链需要文件 mtime，
   * 与缓存校验共用同一次 fstat，不引入第二次。mtimeMs 即缓存校验戳——命中时等于文件当前 mtime。
   */
  async readDocWithMtime(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    return this.readDocCached(dir, key);
  }

  /** readDoc 的读穿缓存实现；缓存命中前也重新安全打开并 fstat，不能把旧命中当安全证明。 */
  private async readDocCached(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    const filePath = resolveDocFile(dir, key);
    let parent: fs.promises.FileHandle;
    try {
      parent = await openDocParent(dir, false);
    } catch (err) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        mdCache.delete(filePath);
        return null;
      }
      throw err;
    }

    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(fdPath(parent.fd, `${key}.md`), READ_FLAGS);
      const stat = await handle.stat();
      if (!stat.isFile()) throw unsafeDocPath('final entry is not a regular file');
      const mtimeMs = stat.mtimeMs;
      const hit = mdCache.get(filePath);
      if (hit && hit.mtimeMs === mtimeMs) {
        return hit.value ? { ...cloneCached(hit.value), mtimeMs } : null;
      }

      // 从已固定的 fd 读取，stat/read 之间替换路径不会改道。
      const content = await fs.promises.readFile(fdPath(handle.fd), 'utf-8');
      const parsed = parseFrontmatter(content);
      const doc = parsed ?? { meta: {}, body: content.trim() };
      cacheSet(mdCache, filePath, { value: doc, mtimeMs });
      return { ...cloneCached(doc), mtimeMs };
    } catch (err) {
      mdCache.delete(filePath);
      if (isErrnoError(err) && err.code === 'ENOENT') return null;
      throw err;
    } finally {
      if (handle) await handle.close();
      await parent.close();
    }
  }

  /**
   * 写入 markdown 文件（含 YAML frontmatter）。
   * 已存在目标先 no-follow 打开验证；内容写同目录独占临时文件后原子 rename，失败不截断原文。
   */
  async writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void> {
    const filePath = resolveDocFile(dir, key);
    const content = serializeFrontmatter(meta, body);
    const parent = await openDocParent(dir, true);
    const target = fdPath(parent.fd, `${key}.md`);
    const temporary = fdPath(parent.fd, `.${key}.md.tmp-${process.pid}-${randomUUID()}`);
    let targetHandle: fs.promises.FileHandle | undefined;
    let temporaryHandle: fs.promises.FileHandle | undefined;
    let temporaryCreated = false;
    try {
      try {
        targetHandle = await fs.promises.open(target, READ_FLAGS);
        if (!(await targetHandle.stat()).isFile()) throw unsafeDocPath('final entry is not a regular file');
      } catch (err) {
        if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      }

      temporaryHandle = await fs.promises.open(temporary, WRITE_FLAGS, 0o666);
      temporaryCreated = true;
      await temporaryHandle.writeFile(content, 'utf-8');
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await fs.promises.rename(temporary, target);
      invalidateFileKey(filePath);
    } catch (err) {
      if (temporaryCreated) await fs.promises.unlink(temporary).catch(() => undefined);
      throw err;
    } finally {
      if (temporaryHandle) await temporaryHandle.close();
      if (targetHandle) await targetHandle.close();
      await parent.close();
    }
  }

  /** 固定父目录 + 最终 no-follow 核对；unlink 本身不跟随 symlink，不承诺目标身份不变。 */
  async deleteDoc(dir: string, key: string): Promise<void> {
    const filePath = resolveDocFile(dir, key);
    const parent = await openDocParent(dir, false);
    let handle: fs.promises.FileHandle | undefined;
    try {
      const target = fdPath(parent.fd, `${key}.md`);
      handle = await fs.promises.open(target, READ_FLAGS);
      if (!(await handle.stat()).isFile()) throw unsafeDocPath('final entry is not a regular file');
      await handle.close();
      handle = undefined;
      await fs.promises.unlink(target);
      invalidateRemovedPath(filePath);
    } finally {
      if (handle) await handle.close();
      await parent.close();
    }
  }

  // ═══ 索引管理 ═══

  async buildIndex(dir: string, fields: string[]): Promise<void> {
    await this.ctx.base.ensureDir(dir);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md').map(e => e.name);
    const header = `# Directory Index\n# Auto-generated\n# Total: ${mdFiles.length} entries\n#\n# filename|${fields.join('|')}`;
    const dataLines: string[] = [];
    for (const filename of mdFiles) {
      const doc = await this.readDoc(dir, filename.replace(/\.md$/, ''));
      const values = fields.map(f => {
        const v = doc?.meta[f];
        if (v === undefined || v === null) return '';
        if (Array.isArray(v)) return (v as string[]).join(';');
        return String(v);
      });
      dataLines.push(`${filename}|${values.join('|')}`);
    }
    await fs.promises.writeFile(path.join(dir, '_index.md'), header + '\n' + dataLines.join('\n') + '\n', 'utf-8');
  }

  async listDocs(dir: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(path.join(dir, '_index.md'), 'utf-8');
      return content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
        .map(l => l.split('|')[0].replace(/\.md$/, ''));
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        try {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          return entries.filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== '_index.md')
            .map(e => e.name.replace(/\.md$/, ''));
        } catch { return []; }
      }
      throw err;
    }
  }

  async appendChangelog(dir: string, key: string, entry: string): Promise<void> {
    const changelogDir = path.join(dir, key);
    await this.ctx.base.ensureDir(changelogDir);
    const filePath = path.join(changelogDir, 'CHANGELOG.md');
    const newEntry = `\n## ${new Date().toISOString()}\n\n${entry}\n`;
    try {
      const existing = await fs.promises.readFile(filePath, 'utf-8');
      await fs.promises.writeFile(filePath, existing + newEntry, 'utf-8');
    } catch (err: unknown) {
      if (isErrnoError(err) && err.code === 'ENOENT') {
        await fs.promises.writeFile(filePath, `# CHANGELOG\n${newEntry}`, 'utf-8');
      } else { throw err; }
    }
  }
}
