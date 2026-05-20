/**
 * Wiki Service — 公司知识库的 Markdown 页面读写
 *
 * 文件结构:
 *   ~/knowledge-base/companies/{companyId}/wiki/
 *     projects/PMO-xxx.md
 *     skills/
 *     pitfalls/
 *     concepts/
 *     decisions/
 *     audit/
 *     INDEX.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BASE_DIR = path.join(os.homedir(), 'knowledge-base', 'companies');

export interface WikiPage {
  path: string;        // relative to company wiki root, e.g. "projects/PMO-2026-001.md"
  title: string;       // page title
  content: string;     // markdown body
  frontmatter?: Record<string, unknown>;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function wikiRoot(companyId: string): string {
  return path.join(BASE_DIR, companyId, 'wiki');
}

/**
 * 写入 Wiki 页面
 */
export function writeWikiPage(companyId: string, page: WikiPage): void {
  const root = wikiRoot(companyId);
  const fullPath = path.join(root, page.path);
  const dir = path.dirname(fullPath);
  ensureDir(dir);

  let fileContent = '';
  if (page.frontmatter && Object.keys(page.frontmatter).length > 0) {
    fileContent += '---\n';
    for (const [key, value] of Object.entries(page.frontmatter)) {
      fileContent += `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`;
    }
    fileContent += '---\n\n';
  }
  fileContent += `# ${page.title}\n\n${page.content}`;

  fs.writeFileSync(fullPath, fileContent, 'utf-8');
}

/**
 * 读取 Wiki 页面
 */
export function readWikiPage(companyId: string, relativePath: string): string | null {
  const fullPath = path.join(wikiRoot(companyId), relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf-8');
}

/**
 * 创建项目页初稿（从 RequirementsDoc）
 */
export function createProjectPage(
  companyId: string,
  pmoNumber: string,
  data: {
    title: string;
    summary: string;
    acGroups: { id: string; acs: string[]; files: string[]; dependencies: string[] }[];
    constraints: string[];
    meetingId?: string;
    goalId?: string;
  },
): void {
  const acSection = data.acGroups.map(g => {
    const deps = g.dependencies.length > 0 ? ` (依赖: ${g.dependencies.join(', ')})` : '';
    return `### ${g.id}${deps}\n- ${g.acs.map(ac => `**AC**: ${ac}`).join('\n- ')}\n- 改动范围: ${g.files.length > 0 ? g.files.join(', ') : '待定'}`;
  }).join('\n\n');

  const constraintsSection = data.constraints.length > 0
    ? `\n## 技术约束\n${data.constraints.map(c => `- ${c}`).join('\n')}`
    : '';

  const content = `## 需求摘要
${data.summary}

## 验收标准
${acSection}
${constraintsSection}

## 关联
- Meeting: ${data.meetingId || '—'}
- Goal: ${data.goalId || '—'}

## 执行结果
*待执行*

## 踩过的坑
*暂无*`;

  writeWikiPage(companyId, {
    path: `projects/${pmoNumber}.md`,
    title: `${pmoNumber} · ${data.title}`,
    content,
    frontmatter: {
      maturity: 'draft',
      createdAt: new Date().toISOString(),
      pmoNumber,
    },
  });

  // 更新 INDEX
  appendToIndex(companyId, pmoNumber, data.title);
}

/**
 * 追加到 INDEX.md
 */
function appendToIndex(companyId: string, pmoNumber: string, title: string): void {
  const indexPath = path.join(wikiRoot(companyId), 'INDEX.md');
  ensureDir(path.dirname(indexPath));

  const entry = `- [[projects/${pmoNumber}]] — ${title}`;
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `# 公司知识库索引\n\n## 项目\n${entry}\n\n## 技能\n\n## 概念\n\n## 坑位\n\n## 决策\n`, 'utf-8');
  } else {
    let content = fs.readFileSync(indexPath, 'utf-8');
    if (!content.includes(`[[projects/${pmoNumber}]]`)) {
      const projectsHeader = '## 项目\n';
      const idx = content.indexOf(projectsHeader);
      if (idx >= 0) {
        const insertPos = idx + projectsHeader.length;
        content = content.slice(0, insertPos) + entry + '\n' + content.slice(insertPos);
      } else {
        content += `\n${entry}`;
      }
      fs.writeFileSync(indexPath, content, 'utf-8');
    }
  }
}

/**
 * 列出公司所有 Wiki 页面
 */
export function listWikiPages(companyId: string): string[] {
  const root = wikiRoot(companyId);
  if (!fs.existsSync(root)) return [];

  const result: string[] = [];
  function walk(dir: string, rel: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel + entry.name + '/');
      else if (entry.name.endsWith('.md')) result.push(rel + entry.name);
    }
  }
  walk(root, '');
  return result;
}

/**
 * 更新项目页的执行结果部分（Executor 完成后调用）
 */
export function updateProjectPageExecutionResult(
  companyId: string,
  pmoNumber: string,
  result: {
    acGroupId?: string;
    status: 'succeeded' | 'failed';
    summary: string;
    changedFiles?: string[];
    error?: string;
  },
): void {
  const page = readWikiPage(companyId, `projects/${pmoNumber}.md`);
  if (!page) return;

  let updated = page;

  // 替换"待执行"或追加新结果
  if (result.status === 'succeeded') {
    const resultLine = `- ✅ **${result.acGroupId || '执行'}**: ${result.summary}${result.changedFiles?.length ? ` (改动: ${result.changedFiles.join(', ')})` : ''}`;
    if (updated.includes('*待执行*')) {
      updated = updated.replace('*待执行*', resultLine);
    } else {
      updated = updated.replace('## 执行结果\n', `## 执行结果\n${resultLine}\n`);
    }
  } else {
    const errorLine = `- ❌ **${result.acGroupId || '执行'}**: ${result.summary}${result.error ? ` — ${result.error}` : ''}`;
    updated = updated.replace('*待执行*', errorLine);
  }

  // 更新 frontmatter 时间
  updated = updated.replace(/updatedAt:.*/, `updatedAt: ${new Date().toISOString()}`);

  writeWikiPage(companyId, {
    path: `projects/${pmoNumber}.md`,
    title: '', // 从原内容保持
    content: updated.replace(/^---\n[\s\S]*?\n---\n\n/, '').replace(/^#\s+.+\n/, '').trim(),
    frontmatter: { updatedAt: new Date().toISOString() },
  });
}
