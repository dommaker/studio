/**
 * Roadmap 解析器
 *
 * 从 roadmap.md 或其他文档提取任务列表
 */

import { readFile } from 'fs/promises';
import { extname } from 'path';

export interface Topic {
  id: string;
  title: string;
  priority: string;
  status: string;
  description: string;
  filePath?: string;  // 🆕 文件路径导入时携带
}

/**
 * 解析 roadmap 表格格式的任务列表
 *
 * 格式：| MR-024 | 会议导入文档功能 | P1 | ⬜ | 说明 |
 */
export function parseRoadmapTasks(content: string): Topic[] {
  // 匹配表格行：| ID | 任务 | 优先级 | 状态 | 说明 |
  const regex = /\| ([A-Z]+-\d+) \| ([^|]+) \| (P\d) \| ([✅⬜🔶]) \| ([^|]+) \|/g;

  const topics: Topic[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    topics.push({
      id: match[1],
      title: match[2].trim(),
      priority: match[3],
      status: match[4],
      description: match[5].trim(),
    });
  }

  return topics;
}

/**
 * 解析任意文本，尝试提取任务信息
 *
 * 支持格式：
 * - roadmap 表格
 * - Markdown 标题 + 描述
 * - 纯文本行
 */
export function parseTextTopics(text: string): Topic[] {
  // 先尝试 roadmap 格式
  const roadmapTopics = parseRoadmapTasks(text);
  if (roadmapTopics.length > 0) {
    return roadmapTopics;
  }

  // 尝试匹配 Markdown 标题格式：## MR-024: 标题
  const headingRegex = /## ([A-Z]+-\d+): (.+)/g;
  const headingTopics: Topic[] = [];
  let headingMatch;
  while ((headingMatch = headingRegex.exec(text)) !== null) {
    headingTopics.push({
      id: headingMatch[1],
      title: headingMatch[2].trim(),
      priority: 'P2',
      status: '⬜',
      description: '',
    });
  }

  if (headingTopics.length > 0) {
    return headingTopics;
  }

  // 尝试匹配纯文本格式：MR-024 标题
  const simpleRegex = /([A-Z]+-\d+)\s+(.+)/g;
  const simpleTopics: Topic[] = [];
  let simpleMatch;
  while ((simpleMatch = simpleRegex.exec(text)) !== null) {
    simpleTopics.push({
      id: simpleMatch[1],
      title: simpleMatch[2].trim(),
      priority: 'P2',
      status: '⬜',
      description: '',
    });
  }

  return simpleTopics;
}

/**
 * 从 URL 获取内容并解析
 *
 * 支持的 URL：
 * - GitHub raw 文件
 * - 本地文件路径
 * - 任意 URL
 */
export async function fetchAndParse(url: string): Promise<Topic[]> {
  // 验证 URL 格式
  try {
    new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  // fetch 内容
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const content = await response.text();
  return parseTextTopics(content);
}

/**
 * 🆕 MR-024 扩展：从本地文件导入
 *
 * 限制：
 * - 只支持 .md 文件
 * - 允许任意路径（用户自己负责）
 * - 后续可加配置白名单路径
 */
export async function readFileAndParse(filePath: string): Promise<Topic[]> {
  // 1. 检查扩展名（只允许 .md）
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.md') {
    throw new Error('只支持 .md 文件导入');
  }

  // 2. 读取文件
  const content = await readFile(filePath, 'utf-8');

  // 3. 解析内容
  const topics = parseTextTopics(content);

  // 4. 添加文件路径标记
  return topics.map(t => ({ ...t, filePath }));
}