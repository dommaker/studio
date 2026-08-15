/**
 * SDD 工具函数 — 遗产残留（仅 wiki 模块仍在消费）
 *
 * #155 T5：SDD 三层文档体系已退役。写侧（writeSddDoc / updateSddFrontmatter 的
 * 新写入口）与 task.md 解析（parseTaskDocContractTests / parseTaskDocTestFiles）
 * 已删除；纯函数与显式 baseDir 的遗产读取已迁至 ./sdd-legacy.ts。
 *
 * 本文件仅保留 wiki 模块（apps/api/src/modules/wiki）仍在调用的读写函数，
 * 仍走 SDD_DIR / REPO_DIR env 口径（getSddBaseDir）——属票外耦合，
 * wiki 迁移到 legacy-sdd 显式 baseDir 后本文件整体删除。
 */

import { join } from 'path';
import { FileStore, parseFrontmatter } from '../file-store';
import type { SddFrontmatter } from './sdd-legacy';

const store = new FileStore();

function getSddBaseDir(): string {
  if (process.env.SDD_DIR) return process.env.SDD_DIR;
  const repoDir = process.env.REPO_DIR || '/root/projects/studio';
  return join(repoDir, 'docs/sdd');
}

/**
 * 读取 SDD 文档（requirement/design/task）。
 */
export async function readSddDoc(slug: string, layer: 'requirement' | 'design' | 'task'): Promise<{ meta: Partial<SddFrontmatter>; body: string } | null> {
  const doc = await store.readDoc(getSddBaseDir(), `${slug}/${layer}`);
  if (!doc) return null;
  return { meta: doc.meta as Partial<SddFrontmatter>, body: doc.body };
}

/**
 * 列出所有 SDD 文档目录（扫描子目录，非 flat .md 文件）。
 */
export async function listSddDocs(): Promise<string[]> {
  // SDD 使用嵌套目录结构（每 slug 一个目录），与 listDocs（flat .md 文件）不兼容
  // 使用 store.readDoc 的 index fallback 逻辑：无 _index.md 时用 listDocs 降级扫描目录。
  // listDocs 降级只扫描 .md 文件，不识别子目录。这里直接用 readdir。
  const fs = await import('node:fs/promises');
  const base = getSddBaseDir();
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

// ── 按 ID 查找（扫描所有 slug，读 requirement.md 匹配 frontmatter） ──

export async function findSddDocById(id: string): Promise<string | null> {
  const slugs = await listSddDocs();
  for (const slug of slugs) {
    const doc = await readSddDoc(slug, 'requirement');
    if (doc?.meta.id === id) return slug;
  }
  return null;
}

export async function findSddDocByWorkUnitId(workUnitId: string): Promise<string | null> {
  const slugs = await listSddDocs();
  for (const slug of slugs) {
    const doc = await readSddDoc(slug, 'requirement');
    if (doc?.meta.workUnitId === workUnitId) return slug;
  }
  return null;
}

export async function readSddDocByWorkUnitId(workUnitId: string, layer: 'requirement' | 'design' | 'task'): Promise<{ meta: Partial<SddFrontmatter>; body: string } | null> {
  const slug = await findSddDocByWorkUnitId(workUnitId);
  if (!slug) return null;
  return readSddDoc(slug, layer);
}

// ── CHANGELOG（委托 FileStore；wiki.routes PUT 仍在调用） ──

export async function appendChangelog(slug: string, entry: string): Promise<void> {
  await store.appendChangelog(getSddBaseDir(), slug, entry);
}

// ── frontmatter 更新（wiki.routes PUT 仍在调用） ──

export async function updateSddFrontmatter(slug: string, patch: Partial<SddFrontmatter>): Promise<void> {
  const baseDir = process.env.SDD_DIR || 'docs/sdd';
  const doc = await store.readDoc(baseDir, `${slug}/requirement`);
  if (!doc) throw new Error(`SDD doc not found: ${baseDir}/${slug}/requirement.md`);
  // 区分"空 frontmatter"和"无 frontmatter fence"：无 fence 时 meta 为 {} 且 body 不含 YAML
  if (Object.keys(doc.meta).length === 0 && !doc.body.startsWith('---')) {
    // 检查原始文件是否有 frontmatter fence
    const rawParsed = parseFrontmatter(doc.body);
    if (!rawParsed) throw new Error(`Invalid frontmatter in: ${baseDir}/${slug}/requirement.md`);
  }

  const merged = { ...doc.meta, ...patch };
  await store.writeDoc(baseDir, `${slug}/requirement`, merged, doc.body);
}
