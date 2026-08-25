/**
 * SDD 遗产读取区 — 只服务 legacy-sdd 归档的只读访问，不再扩展
 *
 * 背景（#155 T5）：SDD 三层文档体系（docs/sdd/<slug>/{requirement,design,task}.md）已退役，
 * 存量归档至 <repoRoot>/.studio/legacy-sdd/（目录结构不变，每 slug 一个子目录）。
 * 本模块是遗产档案的只读入口：baseDir 全部由调用方显式传入
 * （不再有 env、不再有默认值），只为后续 library 遗产读取服务。
 * 写侧已死——本模块不提供任何写入能力，也不接受新功能。
 */

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

export type LegacySddLayer = 'requirement' | 'design' | 'task';

// ── baseDir 校验（必填，归属链断裂该暴露不兜底） ──

function requireBaseDir(baseDir: string): void {
  if (!baseDir || typeof baseDir !== 'string') {
    throw new Error('sdd-legacy: baseDir is required (non-empty string)');
  }
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

// ── 遗产读取（async，底层委托 FileStore.readDoc；baseDir 显式必填） ──

/**
 * 列出遗产区所有 SDD 文档目录（扫描子目录，非 flat .md 文件）。
 * 目录不存在时返回 []（归档尚未迁入不视为错误）。
 * #321：经 FileStore 读穿缓存 readdir（目录 mtime 校验）。
 */
export async function listLegacySddDocs(baseDir: string): Promise<string[]> {
  requireBaseDir(baseDir);
  try {
    const entries = await store.readdir(baseDir);
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * 读取遗产 SDD 文档（requirement/design/task）。
 */
export async function readLegacySddDoc(baseDir: string, slug: string, layer: LegacySddLayer): Promise<{ meta: Partial<SddFrontmatter>; body: string } | null> {
  requireBaseDir(baseDir);
  const doc = await store.readDoc(baseDir, `${slug}/${layer}`);
  if (!doc) return null;
  return { meta: doc.meta as Partial<SddFrontmatter>, body: doc.body };
}

/**
 * 按文档 ID 查找 slug（扫描所有 slug，读 requirement.md 匹配 frontmatter）。
 */
export async function findLegacySddDocById(baseDir: string, id: string): Promise<string | null> {
  requireBaseDir(baseDir);
  const slugs = await listLegacySddDocs(baseDir);
  for (const slug of slugs) {
    const doc = await readLegacySddDoc(baseDir, slug, 'requirement');
    if (doc?.meta.id === id) return slug;
  }
  return null;
}

/**
 * 遗产 SDD 查询（读 requirement 层 frontmatter，按 status/workUnitId 过滤）。
 */
export async function findLegacySddDocs(baseDir: string, filter?: { status?: string; workUnitId?: string }): Promise<Array<Partial<SddFrontmatter>>> {
  requireBaseDir(baseDir);
  const slugs = await listLegacySddDocs(baseDir);
  const results: Array<Partial<SddFrontmatter>> = [];

  for (const slug of slugs) {
    const doc = await readLegacySddDoc(baseDir, slug, 'requirement');
    if (!doc) continue;
    if (filter?.status && doc.meta.status !== filter.status) continue;
    if (filter?.workUnitId && doc.meta.workUnitId !== filter.workUnitId) continue;
    results.push(doc.meta);
  }

  return results;
}
