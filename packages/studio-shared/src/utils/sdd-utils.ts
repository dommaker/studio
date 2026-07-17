/**
 * SDD 工具函数 — frontmatter 解析 + slug 生成
 *
 * SP-004: SDD 知识架构 Step 1
 * Phase 4 (spec-2a): 底层 I/O 下沉到 FileStore，函数改为 async。
 *
 * SDD 文档结构：docs/sdd/<slug>/{requirement,design,task}.md
 * 每个文件头部有 YAML frontmatter，包含文档元数据。
 */

import { join } from 'path';
import { FileStore, parseFrontmatter } from '../file-store';

const store = new FileStore();

// ── Types ──

export interface SddFrontmatter {
  id: string;                // SDD 文档 ID（cuid）
  workUnitId?: string;       // 关联的 WorkUnit ID
  slug: string;              // 目录名（title 的 kebab-case）
  title: string;
  status: 'draft' | 'confirmed' | 'done' | 'stale';
  tier: 'fast' | 'standard' | 'premium';
  version: number;           // 全局版本号
  requirementVersion: number;
  designVersion: number;
  taskVersion: number;
  parentId?: string;         // 上一版本 ID
  changeType?: 'L1' | 'L2' | 'L3' | 'L4';
  changeDesc?: string;
  sourceChannelId?: string;
  tags: string[];
  linkedDocIds?: string[];
  createdAt: string;         // ISO 8601
  updatedAt: string;         // ISO 8601
}

// ── toKebab ──

/**
 * 将标题转为 kebab-case slug。
 * 支持中文（常见字拼音映射）、英文、数字。
 *
 * @example
 * toKebab("添加 JWT 验证") // "add-jwt-auth"
 * toKebab("SDD 知识架构") // "sdd-knowledge-architecture"
 */
export function toKebab(text: string): string {
  if (!text || typeof text !== 'string') return `doc-${Date.now()}`;

  // 简化拼音映射（覆盖 SDD 常见词汇）
  const pinyinMap: Record<string, string> = {
    '添加': 'add', '删除': 'delete', '修改': 'update', '修复': 'fix',
    '验证': 'auth', '认证': 'auth', '授权': 'authorize',
    '知识': 'knowledge', '架构': 'architecture', '设计': 'design',
    '需求': 'requirement', '任务': 'task', '执行': 'execute',
    '审查': 'review', '分析': 'analysis', '优化': 'optimize',
    '技能': 'skill', '配置': 'config', '管理': 'manage',
    '文档': 'doc', '模块': 'module', '系统': 'system',
    '接口': 'api', '数据': 'data', '模型': 'model',
    '测试': 'test', '部署': 'deploy', '监控': 'monitor',
    '蒸馏': 'distill', '进化': 'evolution', '飞轮': 'flywheel',
    '管线': 'pipeline', '约束': 'constraint', '质量': 'quality',
    '统一': 'unified', '发现': 'discovery', '刷新': 'refresh',
    '版本': 'version', '变更': 'change', '会话': 'session',
    '行为': 'behavior', '模式': 'pattern', '提取': 'extract',
    '自动': 'auto', '手动': 'manual', '生成': 'generate',
    '创建': 'create', '更新': 'update', '加载': 'load',
    '存储': 'store', '缓存': 'cache', '同步': 'sync',
    '角色': 'role', '触发': 'trigger', '消费': 'consume',
  };

  let result = text.toLowerCase().trim();

  // 先替换多字拼音词组（加空格分隔）
  for (const [cn, en] of Object.entries(pinyinMap)) {
    result = result.replace(new RegExp(cn, 'g'), ` ${en} `);
  }

  // 替换剩余中文字符为单个空格（保留分词边界）
  result = result.replace(/[\u4e00-\u9fa5]+/g, ' ');

  // 非字母数字连字符 → 连字符
  result = result.replace(/[^a-z0-9-]/g, '-');

  // 合并连字符
  result = result.replace(/-+/g, '-');

  // 去首尾连字符
  result = result.replace(/^-+|-+$/g, '');

  // 限长 50
  result = result.substring(0, 50);

  return result || `doc-${Date.now()}`;
}

// ── Frontmatter 解析（包装 FileStore 纯函数） ──

/**
 * 解析 SDD markdown 文件的 YAML frontmatter。
 * 底层调用 FileStore.parseFrontmatter，上层做 SddFrontmatter 类型断言。
 */
export function parseSddFrontmatter(content: string): { meta: Partial<SddFrontmatter>; body: string } | null {
  const result = parseFrontmatter(content);
  if (!result) return null;
  return { meta: result.meta as Partial<SddFrontmatter>, body: result.body };
}

/**
 * 将 SddFrontmatter 序列化为 YAML 字符串。
 */
export function stringifySddFrontmatter(fm: Partial<SddFrontmatter>): string {
  const lines: string[] = [];

  const writeStr = (key: string, val: string | undefined) => {
    if (val !== undefined) lines.push(`${key}: "${val}"`);
  };
  const writeNum = (key: string, val: number | undefined) => {
    if (val !== undefined) lines.push(`${key}: ${val}`);
  };
  const writeArr = (key: string, val: string[] | undefined) => {
    if (val !== undefined && val.length > 0) lines.push(`${key}: [${val.map(v => `"${v}"`).join(', ')}]`);
  };

  writeStr('id', fm.id);
  writeStr('workUnitId', fm.workUnitId);
  writeStr('slug', fm.slug);
  writeStr('title', fm.title);
  writeStr('status', fm.status);
  writeStr('tier', fm.tier);
  writeNum('version', fm.version);
  writeNum('requirementVersion', fm.requirementVersion);
  writeNum('designVersion', fm.designVersion);
  writeNum('taskVersion', fm.taskVersion);
  writeStr('parentId', fm.parentId);
  writeStr('changeType', fm.changeType);
  writeStr('changeDesc', fm.changeDesc);
  writeStr('sourceChannelId', fm.sourceChannelId);
  writeArr('tags', fm.tags);
  writeArr('linkedDocIds', fm.linkedDocIds);
  writeStr('createdAt', fm.createdAt);
  writeStr('updatedAt', fm.updatedAt);

  return `---\n${lines.join('\n')}\n---`;
}

// ── 文件读写（async，底层委托 FileStore.readDoc/writeDoc） ──

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
 * 写入 SDD 文档。
 */
export async function writeSddDoc(slug: string, layer: 'requirement' | 'design' | 'task', frontmatter: Partial<SddFrontmatter>, body: string): Promise<void> {
  await store.writeDoc(getSddBaseDir(), `${slug}/${layer}`, frontmatter as Record<string, unknown>, body);
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

// ── Task.md 内容解析（SP-004 Step 5，纯函数，不变） ──

export function parseTaskDocContractTests(body: string): Array<{ file: string; content: string }> {
  const results: Array<{ file: string; content: string }> = [];
  const lines = body.split('\n');

  let inContractSection = false;
  let currentFile: string | null = null;
  let currentContent: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (currentFile && currentContent.length > 0) {
        results.push({ file: currentFile, content: currentContent.join('\n') });
      }
      currentFile = null;
      currentContent = [];
      inCodeBlock = false;
      inContractSection = h2[1].trim().includes('Contract Tests') || h2[1].trim().includes('契约测试');
      continue;
    }

    if (!inContractSection) continue;

    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      if (currentFile && currentContent.length > 0) {
        results.push({ file: currentFile, content: currentContent.join('\n') });
      }
      currentFile = h3[1].trim();
      currentContent = [];
      inCodeBlock = false;
      continue;
    }

    if (/^```/.test(line)) {
      if (inCodeBlock) {
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (currentFile && inCodeBlock) {
      currentContent.push(line);
    }
  }

  if (currentFile && currentContent.length > 0) {
    results.push({ file: currentFile, content: currentContent.join('\n') });
  }

  return results;
}

export function parseTaskDocTestFiles(body: string): string[] {
  const lines = body.split('\n');
  const results: string[] = [];

  let inTestFilesSection = false;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (inTestFilesSection) inTestFilesSection = false;
      inTestFilesSection = h2[1].trim().includes('Test Files') || h2[1].trim().includes('测试文件');
      continue;
    }

    if (!inTestFilesSection) continue;

    const item = line.match(/^-\s+(.+)/);
    if (item) {
      const path = item[1].trim();
      const cleanPath = path.replace(/^`|`$/g, '');
      if (cleanPath) results.push(cleanPath);
    }
  }

  return results;
}

// ── CHANGELOG（委托 FileStore） ──

export async function appendChangelog(slug: string, entry: string): Promise<void> {
  await store.appendChangelog(getSddBaseDir(), slug, entry);
}

// ── SddRepository 查询/更新 ──

export async function findSddDocs(filter?: { status?: string; workUnitId?: string }): Promise<Array<Partial<SddFrontmatter>>> {
  const slugs = await listSddDocs();
  const results: Array<Partial<SddFrontmatter>> = [];

  for (const slug of slugs) {
    const doc = await readSddDoc(slug, 'requirement');
    if (!doc) continue;
    if (filter?.status && doc.meta.status !== filter.status) continue;
    if (filter?.workUnitId && doc.meta.workUnitId !== filter.workUnitId) continue;
    results.push(doc.meta);
  }

  return results;
}

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
