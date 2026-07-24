/**
 * files.routes — 知识库文件浏览子路由（文件系统扫描/读取）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET  /requirements  需求文档列表（扫描 knowledge-base 目录）
 * - POST /read-file     读取指定路径的文件（ALLOWED_DIRS 安全限制）
 * - GET  /file          读取需求文档内容（KNOWLEDGE_BASE_PATH 限制）
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import * as os from 'os';
import { requireAuth, requireNotGuest } from '../../middleware/auth.js';

export const filesRoutes = Router();

/**
 * 需求文档列表（基于文件系统）
 * GET /api/v1/knowledge/requirements
 * 
 * 扫描整个 knowledge-base 目录，识别需求相关文档：
 * - 文件名包含：需求、requirement、spec、prd、design
 * - 或任意 .md 文件（限制深度避免扫描过多）
 */
filesRoutes.get('/requirements', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH || path.join(os.homedir(), 'knowledge-base');
    const docs: Array<{ path: string; name: string; project?: string; updatedAt?: string; isRequirement?: boolean }> = [];
    
    // 需求文档关键词
    const requirementKeywords = ['需求', 'requirement', 'spec', 'prd', 'design', 'roadmap', 'feature'];
    
    // 递归扫描目录
    function scanDirectory(dir: string, depth: number = 0, maxDepth: number = 3) {
      if (depth > maxDepth) return;
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        // 跳过隐藏目录和 node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        
        if (entry.isDirectory()) {
          scanDirectory(fullPath, depth + 1, maxDepth);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // 判断是否为需求文档
          const fileName = entry.name.toLowerCase();
          const isRequirement = requirementKeywords.some(kw => fileName.includes(kw));
          
          // 提取项目/分类名称（父目录名）
          const parentDir = path.basename(path.dirname(fullPath));
          const grandParentDir = path.basename(path.dirname(path.dirname(fullPath)));
          
          // 构建项目标签
          let projectLabel = parentDir;
          if (grandParentDir !== path.basename(KNOWLEDGE_BASE_PATH) && grandParentDir !== parentDir) {
            projectLabel = grandParentDir !== 'knowledge-base' ? `${grandParentDir}/${parentDir}` : parentDir;
          }
          
          docs.push({
            path: fullPath,
            name: entry.name,
            project: projectLabel,
            updatedAt: fs.statSync(fullPath).mtime.toISOString(),
            // 标记匹配类型（用于前端排序/过滤）
            isRequirement,
          });
        }
      }
    }
    
    scanDirectory(KNOWLEDGE_BASE_PATH);
    
    // 排序：需求文档优先，然后按更新时间倒序
    docs.sort((a, b) => {
      // @ts-ignore
      if ((a.isRequirement) !== (b.isRequirement)) {
        // @ts-ignore
        return (b.isRequirement ? 1 : 0) - (a.isRequirement ? 1 : 0);
      }
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });

    res.json({ docs, total: docs.length });
  } catch (error) {
    logger.error('Failed to list requirements');
    res.status(500).json({ error: 'Failed to list requirements' });
  }
});

/**
 * 读取指定路径的文件（安全访问）
 * POST /api/v1/knowledge/read-file
 * 
 * 安全检查：
 * - 路径必须在允许的目录范围内（ALLOWED_DIRS 配置）
 * - 文件必须是 .md/.txt/.json 格式
 */
filesRoutes.post('/read-file', requireAuth(), requireNotGuest(), async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing filePath' });
    }

    // 允许访问的目录（环境变量配置，默认为 common 工作目录）
    const ALLOWED_DIRS = process.env.ALLOWED_DIRS 
      ? process.env.ALLOWED_DIRS.split(',').map(d => d.trim())
      : [
        path.join(os.homedir(), 'projects'),
        path.join(os.homedir(), 'knowledge-base'),
      ];

    // 处理路径（支持 ~ 和相对路径）
    let resolvedPath = filePath;
    if (filePath.startsWith('~')) {
      resolvedPath = path.join(os.homedir(), filePath.slice(1));
    } else if (!path.isAbsolute(filePath)) {
      // 相对路径相对于第一个允许目录
      resolvedPath = path.join(ALLOWED_DIRS[0], filePath);
    }
    
    resolvedPath = path.resolve(resolvedPath);

    // 安全检查：路径必须在允许的目录范围内
    const isAllowed = ALLOWED_DIRS.some(allowedDir => {
      const resolvedAllowed = path.resolve(allowedDir);
      return resolvedPath.startsWith(resolvedAllowed);
    });
    
    if (!isAllowed) {
      return res.status(403).json({ error: '路径不在允许访问的目录范围内' });
    }

    // 文件格式检查
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!['.md', '.txt', '.json'].includes(ext)) {
      return res.status(400).json({ error: '只支持 .md, .txt, .json 文件格式' });
    }

    // 检查文件是否存在
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // 检查是否为文件（不是目录）
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: '路径不是文件' });
    }

    // 读取文件内容
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    
    logger.info( 'File read via API');
    
    res.json({ 
      content, 
      path: resolvedPath,
      size: stats.size,
      ext,
    });
  } catch (error) {
    logger.error('Failed to read file');
    res.status(500).json({ error: 'Failed to read file' });
  }
});

/**
 * 读取需求文档内容
 * GET /api/v1/knowledge/file
 */
filesRoutes.get('/file', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }

    const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH || path.join(os.homedir(), 'knowledge-base');
    const resolvedPath = path.resolve(filePath);
    
    if (!resolvedPath.startsWith(KNOWLEDGE_BASE_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    res.json({ content, path: resolvedPath });
  } catch (error) {
    logger.error('Failed to read file');
    res.status(500).json({ error: 'Failed to read file' });
  }
});
