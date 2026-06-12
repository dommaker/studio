/**
 * SDD 工具函数 — frontmatter 解析 + slug 生成
 *
 * SP-004: SDD 知识架构 Step 1
 *
 * SDD 文档结构：docs/sdd/<slug>/{requirement,design,task}.md
 * 每个文件头部有 YAML frontmatter，包含文档元数据。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

// ── Types ──

export interface SddFrontmatter {
  id: string;                // SDD 文档 ID（cuid）
  goalId?: string;           // 关联的 Goal ID
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

// ── Frontmatter 解析 ──

/**
 * 解析 SDD markdown 文件的 YAML frontmatter。
 * 简化实现：逐行解析 key: value，支持字符串、数字、数组。
 */
export function parseSddFrontmatter(content: string): { meta: Partial<SddFrontmatter>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const yaml = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;

    // 数组：[a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    // 数字
    else if (/^\d+$/.test(val)) {
      meta[key] = parseInt(val, 10);
    }
    // 字符串（去引号）
    else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { meta: meta as Partial<SddFrontmatter>, body };
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
  writeStr('goalId', fm.goalId);
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

// ── 文件读写 ──

function getSddBaseDir(): string {
  return process.env.SDD_DIR || 'docs/sdd';
}

/**
 * 读取 SDD 文档（requirement/design/task）。
 * @param slug - 目录名
 * @param layer - 'requirement' | 'design' | 'task'
 * @returns 解析后的 frontmatter + body，文件不存在返回 null
 */
export function readSddDoc(slug: string, layer: 'requirement' | 'design' | 'task'): { meta: Partial<SddFrontmatter>; body: string } | null {
  const filePath = join(getSddBaseDir(), slug, `${layer}.md`);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return parseSddFrontmatter(content);
}

/**
 * 写入 SDD 文档。
 */
export function writeSddDoc(slug: string, layer: 'requirement' | 'design' | 'task', frontmatter: Partial<SddFrontmatter>, body: string): void {
  const dir = join(getSddBaseDir(), slug);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${layer}.md`);
  const content = `${stringifySddFrontmatter(frontmatter)}\n\n${body}`;
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * 列出所有 SDD 文档目录。
 */
export function listSddDocs(): string[] {
  const base = getSddBaseDir();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// ── 按 ID 查找 ──

/**
 * 通过 doc id 查找 SDD 文档 slug。
 * 扫描所有 SDD 目录的 requirement.md frontmatter 匹配 id 字段。
 */
export function findSddDocById(id: string): string | null {
  const slugs = listSddDocs();
  for (const slug of slugs) {
    const doc = readSddDoc(slug, 'requirement');
    if (doc?.meta.id === id) return slug;
  }
  return null;
}

/**
 * 通过 goalId 查找 SDD 文档 slug。
 * 扫描所有 SDD 目录的 requirement.md frontmatter 匹配 goalId 字段。
 */
export function findSddDocByGoalId(goalId: string): string | null {
  const slugs = listSddDocs();
  for (const slug of slugs) {
    const doc = readSddDoc(slug, 'requirement');
    if (doc?.meta.goalId === goalId) return slug;
  }
  return null;
}

/**
 * 通过 goalId 读取 SDD 文档指定层。
 * 组合 findSddDocByGoalId + readSddDoc。
 */
export function readSddDocByGoalId(goalId: string, layer: 'requirement' | 'design' | 'task'): { meta: Partial<SddFrontmatter>; body: string } | null {
  const slug = findSddDocByGoalId(goalId);
  if (!slug) return null;
  return readSddDoc(slug, layer);
}

// ── Task.md 内容解析（SP-004 Step 5） ──

/**
 * 从 SDD task.md body 中解析 contractTests。
 *
 * 期望格式：
 * ```
 * ## Contract Tests
 *
 * ### <file-path-1>
 * ```typescript
 * // test code
 * ```
 *
 * ### <file-path-2>
 * ```typescript
 * // test code
 * ```
 * ```
 *
 * 解析逻辑：每个 H3 标题是文件路径，后续代码块是文件内容。
 */
export function parseTaskDocContractTests(body: string): Array<{ file: string; content: string }> {
  const results: Array<{ file: string; content: string }> = [];
  const lines = body.split('\n');

  let inContractSection = false;
  let currentFile: string | null = null;
  let currentContent: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // H2: section boundary
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      // Flush previous file
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

    // H3: file path
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      // Flush previous file
      if (currentFile && currentContent.length > 0) {
        results.push({ file: currentFile, content: currentContent.join('\n') });
      }
      currentFile = h3[1].trim();
      currentContent = [];
      inCodeBlock = false;
      continue;
    }

    // Code fence tracking
    if (/^```/.test(line)) {
      if (inCodeBlock) {
        // End of code block — content already captured
        inCodeBlock = false;
      } else {
        // Start of code block — begin capturing
        inCodeBlock = true;
      }
      continue;
    }

    // Capture code content
    if (currentFile && inCodeBlock) {
      currentContent.push(line);
    }
  }

  // Flush last file
  if (currentFile && currentContent.length > 0) {
    results.push({ file: currentFile, content: currentContent.join('\n') });
  }

  return results;
}

/**
 * 从 SDD task.md body 中解析 testFiles。
 *
 * 期望格式：
 * ```
 * ## Test Files
 *
 * - path/to/test1.test.ts
 * - path/to/test2.test.ts
 * ```
 */
export function parseTaskDocTestFiles(body: string): string[] {
  const lines = body.split('\n');
  const results: string[] = [];

  let inTestFilesSection = false;

  for (const line of lines) {
    // H2: section boundary
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (inTestFilesSection) {
        // Exiting Test Files section
        inTestFilesSection = false;
      }
      inTestFilesSection = h2[1].trim().includes('Test Files') || h2[1].trim().includes('测试文件');
      continue;
    }

    if (!inTestFilesSection) continue;

    // Parse "- path" list items
    const item = line.match(/^-\s+(.+)/);
    if (item) {
      const path = item[1].trim();
      // Strip inline code backticks
      const cleanPath = path.replace(/^`|`$/g, '');
      if (cleanPath) results.push(cleanPath);
    }
  }

  return results;
}

/**
 * 追加 CHANGELOG 条目。
 */
export function appendChangelog(slug: string, entry: string): void {
  const dir = join(getSddBaseDir(), slug);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, 'CHANGELOG.md');
  const timestamp = new Date().toISOString();
  const newEntry = `\n## ${timestamp}\n\n${entry}\n`;

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    writeFileSync(filePath, existing + newEntry, 'utf-8');
  } else {
    writeFileSync(filePath, `# CHANGELOG\n${newEntry}`, 'utf-8');
  }
}
