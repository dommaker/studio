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
import { isErrnoError } from './file-store-base';
import type { FileStoreCore } from './file-store-core';
import { mdCache, cacheSet, statMtimeMs, cloneCached, collectNonNull, invalidateFileKey } from './cache-primitives';
import { parseFrontmatter, serializeFrontmatter } from '../frontmatter';

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
   * 与缓存校验共用同一次 stat，不引入第二次。mtimeMs 即缓存校验戳——命中时等于文件当前 mtime。
   */
  async readDocWithMtime(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    return this.readDocCached(dir, key);
  }

  /** readDoc 的读穿缓存实现（mdCache，与 readJson 同一 mtime 校验模式） */
  private async readDocCached(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string; mtimeMs: number } | null> {
    const filePath = path.join(dir, `${key}.md`);
    const mtimeMs = await statMtimeMs(filePath);
    if (mtimeMs === null) {
      mdCache.delete(filePath);
      return null;
    }
    const hit = mdCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      return hit.value ? { ...cloneCached(hit.value), mtimeMs } : null;
    }
    let doc: { meta: Record<string, unknown>; body: string } | null = null;
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);
      // 无 frontmatter fence → 整文件视为 body，meta 为空
      doc = parsed ?? { meta: {}, body: content.trim() };
    } catch (err: unknown) {
      if (!isErrnoError(err) || err.code !== 'ENOENT') throw err;
      doc = null; // stat 与 readFile 之间被删 → 按缺失处理
    }
    cacheSet(mdCache, filePath, { value: doc, mtimeMs });
    return doc ? { ...cloneCached(doc), mtimeMs } : null;
  }

  /**
   * 写入 markdown 文件（含 YAML frontmatter）。
   * 目录不存在时自动创建。写后失效缓存。
   */
  async writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void> {
    const filePath = path.join(dir, `${key}.md`);
    await this.ctx.base.ensureDir(path.dirname(filePath));
    const content = serializeFrontmatter(meta, body);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    invalidateFileKey(filePath);
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
