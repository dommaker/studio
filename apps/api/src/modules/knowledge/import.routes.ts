/**
 * Knowledge Import API - 冷启动导入
 *
 * POST /knowledge/import/scan     — 扫描目录，返回可导入的文件列表
 * POST /knowledge/import/execute  — 导入选中的文件为知识条目
 * GET  /knowledge/import/status   — 获取导入状态（进行中的导入任务）
 */

import { Router, Request, Response } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from "path";
import * as os from "os";

export const knowledgeImportRoutes = Router();

// 允许扫描的目录
const ALLOWED_SCAN_DIRS = [
  '~/projects',
  process.env.KNOWLEDGE_BASE_PATH || path.join(os.homedir(), 'knowledge-base'),
];

// 文件类型 → 文档类型映射
const FILE_TYPE_MAP: Record<string, string> = {
  '需求': 'requirement',
  'requirement': 'requirement',
  'spec': 'spec',
  'prd': 'requirement',
  'design': 'design',
  'architecture': 'design',
  'api': 'spec',
  'readme': 'spec',
  'changelog': 'execution',
  'meeting': 'meeting',
  '会议': 'meeting',
};

// 根据文件名推断文档类型
function inferDocType(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const [keyword, type] of Object.entries(FILE_TYPE_MAP)) {
    if (lower.includes(keyword)) return type;
  }
  return 'spec'; // 默认为规范文档
}

// 根据文件名推断标签
function inferTags(fileName: string, relativePath: string): string[] {
  const tags: string[] = [];
  const lower = fileName.toLowerCase();

  if (lower.includes('api') || lower.includes('endpoint')) tags.push('api');
  if (lower.includes('test') || lower.includes('spec')) tags.push('testing');
  if (lower.includes('design') || lower.includes('architecture')) tags.push('architecture');
  if (lower.includes('deploy') || lower.includes('ci') || lower.includes('cd')) tags.push('devops');
  if (lower.includes('security') || lower.includes('auth')) tags.push('security');
  if (lower.includes('database') || lower.includes('schema') || lower.includes('migration')) tags.push('database');

  // 从目录结构推断
  const parts = relativePath.split('/');
  if (parts.length > 1) {
    tags.push(parts[0]); // 顶层目录作为标签
  }

  return [...new Set(tags)];
}

/**
 * POST /api/v1/knowledge/import/scan
 * 扫描目录，返回可导入的文件列表
 *
 * Body: { projectId: string, scanPath?: string, maxDepth?: number }
 */
knowledgeImportRoutes.post('/scan', async (req: Request, res: Response) => {
  try {
    const { projectId, scanPath, maxDepth = 3 } = req.body;

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    // 验证项目存在
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, companyId: true, title: true, gitRepo: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // 确定扫描路径
    let basePath = scanPath;
    if (!basePath) {
      // 尝试从 git repo 推断
      if (project.gitRepo) {
        basePath = project.gitRepo;
      } else {
        basePath = process.env.KNOWLEDGE_BASE_PATH || path.join(os.homedir(), 'knowledge-base');
      }
    }

    // 安全检查（使用 resolved path，防止路径穿越）
    const resolvedBase = path.resolve(basePath);
    const isAllowed = ALLOWED_SCAN_DIRS.some(dir => resolvedBase.startsWith(path.resolve(dir)));
    if (!isAllowed) {
      return res.status(403).json({ error: 'Scan path not allowed' });
    }

    // 扫描文件
    const files: Array<{
      path: string;
      name: string;
      relativePath: string;
      size: number;
      ext: string;
      inferredType: string;
      tags: string[];
      modifiedAt: string;
    }> = [];

    function scanDir(dir: string, depth: number, relativePrefix: string) {
      if (depth > maxDepth) return;
      if (!fs.existsSync(dir)) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          // 跳过隐藏目录、node_modules、dist、.git
          if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', '__pycache__', '.git'].includes(entry.name)) {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1, relativePath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            // 只扫描文本文件
            if (['.md', '.txt', '.json', '.yaml', '.yml', '.toml'].includes(ext)) {
              try {
                const stats = fs.statSync(fullPath);
                // 跳过大于 500KB 的文件
                if (stats.size > 500 * 1024) continue;

                files.push({
                  path: fullPath,
                  name: entry.name,
                  relativePath,
                  size: stats.size,
                  ext,
                  inferredType: inferDocType(entry.name),
                  tags: inferTags(entry.name, relativePath),
                  modifiedAt: stats.mtime.toISOString(),
                });
              } catch {
                // 跳过无法读取的文件
              }
            }
          }
        }
      } catch {
        // 跳过无权限的目录
      }
    }

    scanDir(resolvedBase, 0, '');

    // 按类型分组
    const byType: Record<string, typeof files> = {};
    for (const f of files) {
      if (!byType[f.inferredType]) byType[f.inferredType] = [];
      byType[f.inferredType].push(f);
    }

    // 排序：需求 > 设计 > 规范 > 执行 > 会议
    const typeOrder = ['requirement', 'design', 'spec', 'execution', 'meeting'];
    const sortedFiles = files.sort((a, b) => {
      const aIdx = typeOrder.indexOf(a.inferredType);
      const bIdx = typeOrder.indexOf(b.inferredType);
      if (aIdx !== bIdx) return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      return b.modifiedAt.localeCompare(a.modifiedAt);
    });

    return res.json({
      projectId: project.id,
      projectTitle: project.title,
      scanPath: resolvedBase,
      totalFiles: files.length,
      byType: Object.fromEntries(
        Object.entries(byType).map(([type, typeFiles]) => [type, typeFiles.length])
      ),
      files: sortedFiles,
    });
  } catch (error) {
    logger.error({ error }, 'Knowledge import scan failed');
    return res.status(500).json({ error: 'Scan failed' });
  }
});

/**
 * POST /api/v1/knowledge/import/execute
 * 导入选中的文件为知识条目
 *
 * Body: {
 *   projectId: string,
 *   files: Array<{ path: string, type?: string, title?: string, tags?: string[] }>
 * }
 */
knowledgeImportRoutes.post('/execute', async (req: Request, res: Response) => {
  try {
    const { projectId, files: filesToImport } = req.body;

    if (!projectId || !filesToImport?.length) {
      return res.status(400).json({ error: 'projectId and files are required' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, companyId: true },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const results: Array<{ path: string; status: string; documentId?: string; error?: string }> = [];

    for (const file of filesToImport) {
      try {
        // 安全检查（使用 resolved path，防止路径穿越）
        const resolvedPath = path.resolve(file.path);
        const isAllowed = ALLOWED_SCAN_DIRS.some(dir => resolvedPath.startsWith(path.resolve(dir)));
        if (!isAllowed) {
          results.push({ path: file.path, status: 'skipped', error: 'Path not allowed' });
          continue;
        }

        if (!fs.existsSync(resolvedPath)) {
          results.push({ path: file.path, status: 'skipped', error: 'File not found' });
          continue;
        }

        // 文件大小检查 (500KB)
        const stats = fs.statSync(resolvedPath);
        if (stats.size > 500 * 1024) {
          results.push({ path: file.path, status: 'skipped', error: 'File too large (>500KB)' });
          continue;
        }

        // 文件类型检查
        const ext = path.extname(resolvedPath).toLowerCase();
        if (!['.md', '.txt', '.json', '.yaml', '.yml', '.toml'].includes(ext)) {
          results.push({ path: file.path, status: 'skipped', error: 'Unsupported file type' });
          continue;
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const fileName = path.basename(resolvedPath);
        const docType = file.type || inferDocType(fileName);
        const title = file.title || fileName.replace(/\.[^.]+$/, '');
        const tags = file.tags || inferTags(fileName, resolvedPath);

        const document = await prisma.document.create({
          data: {
            projectId,
            companyId: project.companyId,
            type: docType,
            title,
            content,
            filePath: resolvedPath,
            tags,
            status: 'active',
          },
        });

        results.push({ path: file.path, status: 'imported', documentId: document.id });
      } catch (err) {
        results.push({ path: file.path, status: 'error', error: String(err) });
      }
    }

    const imported = results.filter(r => r.status === 'imported').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    logger.info({ projectId, imported, skipped, errors }, 'Knowledge import completed');

    return res.json({
      imported,
      skipped,
      errors,
      results,
    });
  } catch (error) {
    logger.error({ error }, 'Knowledge import execution failed');
    return res.status(500).json({ error: 'Import failed' });
  }
});

export default knowledgeImportRoutes;
