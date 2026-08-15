/**
 * Library service — 阅览室（#155 T5）
 *
 * 跨项目 `.studio/` 文档面的聚合只读层：
 * 缺省遍历全部有 gitRepo 的 PMO 项目，读各仓 `.studio/` 下的
 * specs/、research/、adr/、CONTEXT.md；legacy-sdd/<slug>/ 三层遗产文档
 * 打 legacy: true 标记只读展示。`?project=` 收窄到单项目。
 *
 * 写侧判死：library 无任何写路径——文档随仓演进，变更历史 = git 历史。
 * 单仓读失败（目录不存在/权限）不炸整体，跳过并 logger.warn。
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  logger,
  parseFrontmatter,
  listLegacySddDocs,
  readLegacySddDoc,
} from '@dommaker/studio-shared';
import { legacySddDir } from '@dommaker/studio-shared/studio-dir';
import { projectService, type ProjectData } from '../pmo/project.service.js';

// ── Types ──

export type LibraryKind = 'spec' | 'research' | 'adr' | 'context' | 'legacy';

export interface LibraryListItem {
  id: string;            // `${projectId}:${relPath}`（relPath 相对 .studio/；legacy 为 legacy-sdd/<slug>）
  title: string;
  kind: LibraryKind;
  legacy: boolean;
  projectId: string;     // PMO 项目真值 id
  pmoNumber: string;
  path: string;          // relPath（相对 .studio/）
  status?: string;
  tags?: string[];
  updatedAt: string;
}

export interface LibraryDocDetail extends LibraryListItem {
  content: string;             // 普通文档 = 去 frontmatter 正文；legacy = requirement body
  requirement?: string | null; // legacy 三段
  design?: string | null;
  task?: string | null;
}

// ── 目录 → kind 映射（.studio/ 下的相对前缀） ──

const KIND_DIRS: Array<{ dir: string; kind: LibraryKind }> = [
  { dir: 'specs', kind: 'spec' },
  { dir: 'research', kind: 'research' },
  { dir: 'adr', kind: 'adr' },
];

const LEGACY_PREFIX = 'legacy-sdd/';

// ── Helpers ──

/** title 兜底链：frontmatter title → 首个 H1 → 文件名 */
function extractTitle(meta: Record<string, unknown>, body: string, fallback: string): string {
  if (typeof meta.title === 'string' && meta.title.trim()) return meta.title.trim();
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

interface ParsedDoc {
  meta: Record<string, unknown>;
  body: string;
  mtime: string;
}

async function readMarkdownDoc(absPath: string): Promise<ParsedDoc | null> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
  let mtime = '';
  try {
    mtime = (await fs.stat(absPath)).mtime.toISOString();
  } catch { /* 读不到 mtime 留空 */ }
  const parsed = parseFrontmatter(raw);
  return { meta: parsed?.meta ?? {}, body: parsed?.body ?? raw, mtime };
}

function metaUpdatedAt(meta: Record<string, unknown>, mtime: string): string {
  return (typeof meta.updatedAt === 'string' && meta.updatedAt) || mtime;
}

/** 项目聚合对象（带 gitRepo 收窄过的 ProjectData） */
type LibraryProject = ProjectData & { gitRepo: string };

/** 有 gitRepo 的 PMO 项目清单；projectId 收窄时只取该项目 */
async function listLibraryProjects(projectId?: string): Promise<LibraryProject[]> {
  // list 分页默认 20——聚合要全量，显式放大 limit
  const all = await projectService.list({ limit: 10000 });
  return all.filter((p): p is LibraryProject =>
    Boolean(p.gitRepo) && (!projectId || p.id === projectId),
  );
}

/** 扫单个项目仓的 .studio/，产出全部 list item（含 legacy） */
async function scanProjectDocs(project: LibraryProject): Promise<Array<{ item: LibraryListItem; body: string }>> {
  const studioRoot = path.join(project.gitRepo, '.studio');
  const results: Array<{ item: LibraryListItem; body: string }> = [];
  const base = { projectId: project.id, pmoNumber: project.pmoNumber };

  // specs/ research/ adr/ 下的 *.md
  for (const { dir, kind } of KIND_DIRS) {
    const absDir = path.join(studioRoot, dir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 = 该仓无此面，不算失败
    }
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.md'))) {
      const relPath = `${dir}/${entry.name}`;
      const doc = await readMarkdownDoc(path.join(absDir, entry.name));
      if (!doc) continue;
      results.push({
        item: {
          id: `${project.id}:${relPath}`,
          title: extractTitle(doc.meta, doc.body, entry.name),
          kind,
          legacy: false,
          ...base,
          path: relPath,
          updatedAt: metaUpdatedAt(doc.meta, doc.mtime),
        },
        body: doc.body,
      });
    }
  }

  // CONTEXT.md（单文件面）
  const ctx = await readMarkdownDoc(path.join(studioRoot, 'CONTEXT.md'));
  if (ctx) {
    results.push({
      item: {
        id: `${project.id}:CONTEXT.md`,
        title: extractTitle(ctx.meta, ctx.body, 'CONTEXT.md'),
        kind: 'context',
        legacy: false,
        ...base,
        path: 'CONTEXT.md',
        updatedAt: metaUpdatedAt(ctx.meta, ctx.mtime),
      },
      body: ctx.body,
    });
  }

  // legacy-sdd/<slug>/ 三层遗产文档（只读展示）
  const legacyBase = legacySddDir(project.gitRepo);
  for (const slug of await listLegacySddDocs(legacyBase)) {
    const req = await readLegacySddDoc(legacyBase, slug, 'requirement');
    if (!req) continue;
    const relPath = `${LEGACY_PREFIX}${slug}`;
    results.push({
      item: {
        id: `${project.id}:${relPath}`,
        title: req.meta.title ?? slug,
        kind: 'legacy',
        legacy: true,
        ...base,
        path: relPath,
        status: req.meta.status,
        tags: req.meta.tags,
        updatedAt: req.meta.updatedAt ?? req.meta.createdAt ?? '',
      },
      body: req.body,
    });
  }

  return results;
}

// ── listLibraryDocs ──

/**
 * 聚合列出全部项目仓的 .studio/ 文档。
 * search = title + 正文（legacy 正文 = requirement body）子串匹配，大小写不敏感。
 */
export async function listLibraryDocs(filters: {
  projectId?: string;
  search?: string;
}): Promise<LibraryListItem[]> {
  const projects = await listLibraryProjects(filters.projectId);
  const docs: LibraryListItem[] = [];
  const q = filters.search?.toLowerCase();

  for (const project of projects) {
    let scanned: Array<{ item: LibraryListItem; body: string }>;
    try {
      scanned = await scanProjectDocs(project);
    } catch (err) {
      // 单仓失败不炸整体
      logger.warn('[Library] Scan project failed, skipped', { projectId: project.id, gitRepo: project.gitRepo, error: String(err) });
      continue;
    }
    for (const { item, body } of scanned) {
      if (q && !item.title.toLowerCase().includes(q) && !body.toLowerCase().includes(q)) continue;
      docs.push(item);
    }
  }

  // updatedAt desc
  docs.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  return docs;
}

// ── getLibraryDoc ──

/** kind 从 relPath 前缀反解；不在已知面内返回 null（404 口径） */
function kindFromRelPath(relPath: string): LibraryKind | null {
  for (const { dir, kind } of KIND_DIRS) {
    if (relPath.startsWith(`${dir}/`) && relPath.endsWith('.md')) return kind;
  }
  if (relPath === 'CONTEXT.md') return 'context';
  return null;
}

/**
 * 按 `projectId:relPath` 取文档详情。
 * 校验项目存在且路径 resolve 后落在该仓 .studio/ 根内（防路径穿越）。
 */
export async function getLibraryDoc(id: string): Promise<LibraryDocDetail | null> {
  const sep = id.indexOf(':');
  if (sep <= 0 || sep === id.length - 1) return null;
  const projectId = id.slice(0, sep);
  const relPath = id.slice(sep + 1);

  const project = await projectService.get(projectId);
  if (!project?.gitRepo) return null;
  const studioRoot = path.resolve(project.gitRepo, '.studio');
  const base = { projectId: project.id, pmoNumber: project.pmoNumber };

  // legacy-sdd/<slug>：三段式遗产文档
  if (relPath.startsWith(LEGACY_PREFIX)) {
    const slug = relPath.slice(LEGACY_PREFIX.length);
    if (!slug || slug.includes('/') || slug === '.' || slug === '..') return null;
    const legacyBase = legacySddDir(project.gitRepo);
    const req = await readLegacySddDoc(legacyBase, slug, 'requirement');
    if (!req) return null;
    const design = await readLegacySddDoc(legacyBase, slug, 'design');
    const task = await readLegacySddDoc(legacyBase, slug, 'task');
    return {
      id,
      title: req.meta.title ?? slug,
      kind: 'legacy',
      legacy: true,
      ...base,
      path: relPath,
      content: req.body,
      requirement: req.body,
      design: design?.body ?? null,
      task: task?.body ?? null,
      status: req.meta.status,
      tags: req.meta.tags,
      updatedAt: req.meta.updatedAt ?? req.meta.createdAt ?? '',
    };
  }

  const kind = kindFromRelPath(relPath);
  if (!kind) return null;

  // 防路径穿越：resolve 后必须落在该仓 .studio/ 根内
  const abs = path.resolve(studioRoot, relPath);
  if (!abs.startsWith(studioRoot + path.sep)) return null;

  const doc = await readMarkdownDoc(abs);
  if (!doc) return null;
  return {
    id,
    title: extractTitle(doc.meta, doc.body, path.basename(relPath)),
    kind,
    legacy: false,
    ...base,
    path: relPath,
    content: doc.body,
    updatedAt: metaUpdatedAt(doc.meta, doc.mtime),
  };
}
