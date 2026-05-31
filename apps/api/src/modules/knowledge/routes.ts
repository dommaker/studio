/**
 * 知识库 API - 公司数字资产管理
 * 
 * GET /knowledge - 公司知识库（所有项目）
 * GET /knowledge/requirements - 需求文档列表（文件系统扫描）
 * GET /knowledge/file - 读取文件内容
 * GET /knowledge/detail/:documentId - 文档详情
 * GET /knowledge/:projectId - 项目文档列表
 * POST /knowledge/:projectId - 创建文档
 * PUT /knowledge/:documentId - 更新文档
 * DELETE /knowledge/:documentId - 删除文档
 */

import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../../utils/logger.js';
import { upsertKnowledge } from './knowledge-bus.service.js';
import type { KnowledgeSource } from './knowledge-bus.service.js';
import { knowledgeSync } from './knowledge-sync.service.js';
import { modelGateway } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const knowledgeRoutes = Router();

// Internal routes (no auth, for local service-to-service calls)
export const knowledgeInternalRoutes = Router();

/**
 * GET /api/knowledge/sync-status — 知识同步状态（新鲜度检测）
 */
knowledgeInternalRoutes.get('/sync-status', async (_req, res) => {
  try {
    const { stale, unmonitored } = knowledgeSync.detectStaleness();
    const trackedScopes = knowledgeSync.getTrackedScopes();

    // Heal stale entries
    let healed: string[] = [];
    if (stale.length > 0) {
      healed = await knowledgeSync.heal(stale);
    }

    res.json({ trackedScopes, stale, unmonitored, healed });
  } catch (e: any) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /api/knowledge/upsert — 设计时知识沉淀入口
 *
 * 写入 KnowledgeStore (单一事实源) + 同步 Prisma Document (Studio UI 可见)
 * 内部端点，无 auth。供 Claude Code / Analyst / CLI 调用。
 *
 * Body: { scope, title, content, type?, source?, projectId?, companyId? }
 */
knowledgeInternalRoutes.post('/upsert', async (req, res) => {
  try {
    const { scope, title, content, type, source, projectId: reqProjectId, companyId: reqCompanyId } = req.body;
    if (!scope || !title || !content) {
      res.status(400).json({ error: 'scope, title, and content are required' });
      return;
    }

    // 1. Write to KnowledgeStore (single source of truth)
    const ksResult = await upsertKnowledge({
      scope,
      title,
      content,
      type: type as 'architecture' | 'process' | 'guideline' | undefined,
      source: source as KnowledgeSource | undefined,
    });

    // 2. Sync to Prisma Document (Studio UI projection)
    let docResult: { action: string; docId: string } = { action: 'skipped', docId: '' };
    try {
      // Resolve projectId/companyId
      let projectId = reqProjectId;
      let companyId = reqCompanyId;
      if (!projectId || !companyId) {
        const project = await prisma.project.findFirst({ select: { id: true, companyId: true } });
        if (project) {
          projectId = projectId || project.id;
          companyId = companyId || project.companyId;
        }
      }
      if (!projectId || !companyId) {
        logger.warn({ scope }, '[KnowledgeRoute] No project/company found, skipping Prisma sync');
      } else {
        // Find existing Document by title+type for dedup
        const existing = await prisma.document.findFirst({
          where: { title, type: 'design', projectId },
          orderBy: { version: 'desc' },
        });
        if (existing) {
          await prisma.document.update({
            where: { id: existing.id },
            data: { content, version: existing.version + 1 },
          });
          docResult = { action: 'updated', docId: existing.id };
        } else {
          const doc = await prisma.document.create({
            data: {
              projectId, companyId, type: 'design', title, content,
              tags: JSON.stringify([scope, 'design-doc']),
              status: 'active', version: 1,
            },
          });
          docResult = { action: 'created', docId: doc.id };
        }
      }
    } catch (e: any) {
      logger.warn({ error: String(e) }, '[KnowledgeRoute] Prisma sync failed (non-blocking)');
    }

    res.json({
      knowledgeStore: ksResult,
      prismaDocument: docResult,
    });
  } catch (e: any) {
    logger.error({ error: String(e) }, '[KnowledgeRoute] Upsert failed');
    res.status(500).json({ error: String(e) });
  }
});

/**
 * 公司知识库 - 所有项目文档
 * GET /api/v1/knowledge
 * 
 * 查询参数：
 * - companyId: 公司 ID（必填）
 * - type: 文档类型过滤
 * - status: 状态过滤
 * - search: 关键词搜索
 */
knowledgeRoutes.get('/', async (req, res) => {
  try {
    const { companyId, type, status, search, page = 1, limit = 20 } = req.query;

    if (!companyId) {
      res.status(400).json({ error: 'companyId is required' });
      return;
    }

    const where: Record<string, unknown> = { companyId: String(companyId) };
    if (type) where.type = String(type);
    if (status) where.status = String(status);
    if (search) {
      where.OR = [
        { title: { contains: String(search), mode: 'insensitive' } },
        { content: { contains: String(search), mode: 'insensitive' } },
      ];
    }

    const documents = await prisma.document.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
      include: {
        Project: { select: { pmoNumber: true, title: true } },
        CreatedBy: { select: { name: true, type: true } },
      },
    });

    const total = await prisma.document.count({ where });

    // 统计各类型数量
    const stats = await prisma.document.groupBy({
      by: ['type'],
      where: { companyId: String(companyId) },
      _count: true,
    });

    res.json({
      documents,
      total,
      page: Number(page),
      limit: Number(limit),
      stats: stats.reduce((acc, s) => ({ ...acc, [s.type]: s._count }), {}),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to list knowledge');
    res.status(500).json({ error: 'Failed to list knowledge' });
  }
});

/**
 * 需求文档列表（基于文件系统）
 * GET /api/v1/knowledge/requirements
 * 
 * 扫描整个 knowledge-base 目录，识别需求相关文档：
 * - 文件名包含：需求、requirement、spec、prd、design
 * - 或任意 .md 文件（限制深度避免扫描过多）
 */
knowledgeRoutes.get('/requirements', async (req, res) => {
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
    logger.error({ error }, 'Failed to list requirements');
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
knowledgeRoutes.post('/read-file', async (req, res) => {
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
    
    logger.info({ filePath, resolvedPath }, 'File read via API');
    
    res.json({ 
      content, 
      path: resolvedPath,
      size: stats.size,
      ext,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to read file');
    res.status(500).json({ error: 'Failed to read file' });
  }
});

/**
 * 读取需求文档内容
 * GET /api/v1/knowledge/file
 */
knowledgeRoutes.get('/file', async (req, res) => {
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
    logger.error({ error }, 'Failed to read file');
    res.status(500).json({ error: 'Failed to read file' });
  }
});

/**
 * 文档详情
 * GET /api/v1/knowledge/detail/:documentId
 */
knowledgeRoutes.get('/detail/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        Project: { select: { pmoNumber: true, title: true } },
        CreatedBy: { select: { name: true, type: true } },
      },
    });

    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    res.json(document);
  } catch (error) {
    logger.error({ error }, 'Failed to get document detail');
    res.status(500).json({ error: 'Failed to get document detail' });
  }
});

/**
 * 项目文档列表
 * GET /api/v1/knowledge/:projectId
 */
knowledgeRoutes.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { type } = req.query;

    const where: Record<string, unknown> = { projectId };
    if (type) where.type = String(type);

    const documents = await prisma.document.findMany({
      where,
      orderBy: [
        { type: 'asc' },
        { updatedAt: 'desc' },
      ],
      include: {
        CreatedBy: { select: { name: true, type: true } },
      },
    });

    // 按类型分组
    const byType = documents.reduce((acc, doc) => {
      const t = doc.type;
      if (!acc[t]) acc[t] = [];
      acc[t].push(doc);
      return acc;
    }, {} as Record<string, typeof documents>);

    // 统计
    const stats = {
      total: documents.length,
      active: documents.filter(d => d.status === 'active').length,
      archived: documents.filter(d => d.status === 'archived').length,
      byType: Object.keys(byType).map(t => ({ type: t, count: byType[t].length })),
    };

    res.json({ documents, byType, stats });
  } catch (error) {
    logger.error({ error }, 'Failed to list project documents');
    res.status(500).json({ error: 'Failed to list project documents' });
  }
});

/**
 * 创建文档
 * POST /api/v1/knowledge/:projectId
 */
knowledgeRoutes.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { type, title, content, filePath, tags, createdBy } = req.body;

    if (!type || !title) {
      res.status(400).json({ error: 'type and title are required' });
      return;
    }

    // 获取项目信息
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { companyId: true },
    });

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const document = await prisma.document.create({
      data: {
        projectId,
        companyId: project.companyId,
        type,
        title,
        content,
        filePath,
        tags: tags || [],
        createdBy,
      },
    });

    logger.info({ documentId: document.id, projectId }, 'Document created');

    res.status(201).json(document);
  } catch (error) {
    logger.error({ error }, 'Failed to create document');
    res.status(500).json({ error: 'Failed to create document' });
  }
});

/**
 * 更新文档
 * PUT /api/v1/knowledge/:documentId
 */
knowledgeRoutes.put('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { title, content, filePath, tags, updatedBy } = req.body;

    const document = await prisma.document.update({
      where: { id: documentId },
      data: {
        title,
        content,
        filePath,
        tags,
        updatedBy,
        version: { increment: 1 },
      },
    });

    logger.info({ documentId }, 'Document updated');

    res.json(document);
  } catch (error) {
    logger.error({ error }, 'Failed to update document');
    res.status(500).json({ error: 'Failed to update document' });
  }
});

/**
 * 归档文档
 * POST /api/v1/knowledge/:documentId/archive
 */
knowledgeRoutes.post('/:documentId/archive', async (req, res) => {
  try {
    const { documentId } = req.params;

    const document = await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'archived',
        archivedAt: new Date(),
      },
    });

    logger.info({ documentId }, 'Document archived');

    res.json(document);
  } catch (error) {
    logger.error({ error }, 'Failed to archive document');
    res.status(500).json({ error: 'Failed to archive document' });
  }
});

/**
 * Decision #4: 知识审核闸门
 * POST /api/v1/knowledge/:documentId/approve — 审批通过，提升 maturity 为 validated
 * POST /api/v1/knowledge/:documentId/reject  — 驳回，标记 status 为 rejected
 */
knowledgeRoutes.post('/:documentId/approve', async (req, res) => {
  try {
    const { documentId } = req.params;
    const doc = await prisma.document.update({
      where: { id: documentId },
      data: { status: 'validated' },
    });
    logger.info({ documentId }, 'Knowledge entry approved');
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve' });
  }
});

knowledgeRoutes.post('/:documentId/reject', async (req, res) => {
  try {
    const { documentId } = req.params;
    const doc = await prisma.document.update({
      where: { id: documentId },
      data: { status: 'rejected' },
    });
    logger.info({ documentId }, 'Knowledge entry rejected');
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Failed to reject' });
  }
});

/**
 * 删除文档
 * DELETE /api/v1/knowledge/:documentId
 */
knowledgeRoutes.delete('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;

    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'deleted' },
    });

    logger.info({ documentId }, 'Document deleted');

    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to delete document');
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ============================================
// B9-021: Knowledge Export API
// TODO: rewrite to use KnowledgeStore instead of deleted KnowledgeService
// ============================================

/**
 * GET /api/v1/knowledge/export
 * Query: format=md|json, types=guideline,pitfall (comma-separated), limit=100
 */
knowledgeRoutes.get('/export', async (req, res) => {
  try {
    const { sharedStore } = await import('./knowledge-bus.service.js');
    const format = (req.query.format as string) === 'json' ? 'json' : 'md';
    const types = req.query.types ? (req.query.types as string).split(',').filter(Boolean) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

    const entries = sharedStore.list({ types: types as any }).slice(0, limit);
    const content = format === 'json'
      ? JSON.stringify(entries, null, 2)
      : entries.map((e: any) => `# ${e.title || e.id}\n\n${e.content}`).join('\n\n---\n\n');

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
    } else {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="knowledge-export.md"');
    }
    res.send(content);
  } catch (error) {
    logger.error({ error }, 'Failed to export knowledge');
    res.status(500).json({ error: 'Failed to export knowledge' });
  }
});

// ============================================
// §12.11b: 知识问答 API
// ============================================

import { sharedStore } from './knowledge-bus.service.js';
import { modelGateway } from '@dommaker/studio-shared';

/**
 * POST /api/v1/knowledge/ask
 * 知识问答：检索相关知识条目 → LLM 生成回答
 *
 * Body: { question: string, types?: string[], limit?: number }
 * Returns: { answer: string, sources: Array<{ id, title, type }> }
 */
knowledgeRoutes.post('/ask', async (req, res) => {
  try {
    const { question, types, limit = 10 } = req.body;
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' });
    }

    // 1. Retrieve relevant entries from KnowledgeStore
    const allEntries = sharedStore.list({ types: types as any }).slice(0, 100);
    // Simple keyword matching on title + content
    const keywords = question.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = allEntries
      .map((e: any) => {
        const text = `${e.title || ''} ${e.content}`.toLowerCase();
        const hits = keywords.filter((k: string) => text.includes(k)).length;
        return { entry: e, score: hits };
      })
      .filter((s: any) => s.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) {
      return res.json({ answer: '未找到相关知识条目。', sources: [] });
    }

    // 2. Format context for LLM
    const entries = scored.map((s: any) => s.entry);
    const contextLines = entries.map((e: any, i: number) =>
      `[${i + 1}] ${e.title || '(无标题)'} (${e.type})\n${e.content}`
    );
    const context = contextLines.join('\n\n---\n\n');

    // 3. LLM call
    const systemPrompt = '你是知识库问答助手。根据提供的知识条目回答用户问题。回答必须基于知识条目内容，不要编造。引用时标注来源编号如 [1] [2]。';
    const userPrompt = `知识条目：\n${context}\n\n---\n\n用户问题：${question}`;

    const answer = await modelGateway.prompt(userPrompt, systemPrompt);

    // 4. Return answer + source references
    const sources = entries.map((e: any) => ({
      id: e.id,
      title: e.title || e.content.slice(0, 60),
      type: e.type,
    }));

    res.json({ answer, sources });
  } catch (error) {
    logger.error({ error }, 'Knowledge ask failed');
    res.status(500).json({ error: 'Knowledge ask failed' });
  }
});

// ============================================
// §12.12: 知识进化引擎 API
// ============================================

import { knowledgeEvolution } from './evolution.service.js';

/**
 * POST /api/v1/knowledge/evolution/micro
 * 微观进化：从执行结果中提取知识
 */
knowledgeRoutes.post('/evolution/micro', async (req, res) => {
  try {
    const { executionId, projectId, companyId } = req.body;
    if (!executionId || !projectId || !companyId) {
      return res.status(400).json({ error: 'executionId, projectId, companyId are required' });
    }
    const results = await knowledgeEvolution.microEvolution(executionId, projectId, companyId);
    return res.json({ results, total: results.length });
  } catch (error) {
    logger.error({ error }, 'Micro evolution failed');
    return res.status(500).json({ error: 'Micro evolution failed' });
  }
});

/**
 * POST /api/v1/knowledge/evolution/meso
 * 中观进化：项目级别知识整合
 */
knowledgeRoutes.post('/evolution/meso', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const results = await knowledgeEvolution.mesoEvolution(projectId);
    return res.json({ results, total: results.length });
  } catch (error) {
    logger.error({ error }, 'Meso evolution failed');
    return res.status(500).json({ error: 'Meso evolution failed' });
  }
});

/**
 * POST /api/v1/knowledge/evolution/macro
 * 宏观进化：跨项目知识迁移
 */
knowledgeRoutes.post('/evolution/macro', async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }
    const result = await knowledgeEvolution.macroEvolution(companyId);
    return res.json(result);
  } catch (error) {
    logger.error({ error }, 'Macro evolution failed');
    return res.status(500).json({ error: 'Macro evolution failed' });
  }
});

/**
 * POST /api/v1/knowledge/evolution/decay
 * 衰减检查：归档过期知识
 */
knowledgeRoutes.post('/evolution/decay', async (req, res) => {
  try {
    const results = await knowledgeEvolution.decayCheck();
    return res.json({ results, total: results.length });
  } catch (error) {
    logger.error({ error }, 'Decay check failed');
    return res.status(500).json({ error: 'Decay check failed' });
  }
});

/**
 * GET /api/v1/knowledge/evolution/health
 * 知识库健康指标
 */
knowledgeRoutes.get('/evolution/health', async (req, res) => {
  try {
    const companyId = req.query.companyId as string;
    if (!companyId) {
      return res.status(400).json({ error: 'companyId is required' });
    }
    const metrics = await knowledgeEvolution.getHealthMetrics(companyId);
    return res.json(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to get health metrics');
    return res.status(500).json({ error: 'Failed to get health metrics' });
  }
});

// ============================================
// G-001~005: 五大知识缺口查询 API
// ============================================

/**
 * GET /api/v1/knowledge/gaps/:type
 * 查询五种知识类型: preference | business_rule | environment | decision_chain | interaction
 */
knowledgeRoutes.get('/gaps/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['preference', 'business_rule', 'environment', 'decision_chain', 'interaction'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    }

    const { knowledgeQuery } = await import('./knowledge-query.service.js');
    const data = await knowledgeQuery.query({
      type: type as any,
      topic: req.query.topic as string,
      category: req.query.category as string,
      limit: parseInt(req.query.limit as string) || 20,
    });
    return res.json({ type, data, total: data.length });
  } catch (error) {
    logger.error({ error }, 'Failed to query knowledge gaps');
    return res.status(500).json({ error: 'Failed to query knowledge gaps' });
  }
});

/**
 * GET /api/v1/knowledge/gaps
 * 获取所有五种知识类型的统计概览
 */
knowledgeRoutes.get('/gaps', async (req, res) => {
  try {
    const { knowledgeQuery } = await import('./knowledge-query.service.js');
    const stats = await knowledgeQuery.getStats();
    return res.json(stats);
  } catch (error) {
    logger.error({ error }, 'Failed to get knowledge gap stats');
    return res.status(500).json({ error: 'Failed to get knowledge gap stats' });
  }
});

// ============================================
// P0b: Generic text knowledge extraction (no auth, internal only)
// ============================================

/**
 * POST /api/knowledge/extract-text
 * Body: { content: string, source: string, layer?: string }
 * Returns: 202 { queued: true }
 *
 * Generic endpoint: caller provides pre-processed text content.
 * All source-specific logic (format parsing, message filtering, truncation)
 * belongs in the caller, not here.
 */
knowledgeInternalRoutes.post('/extract-text', async (req, res) => {
  try {
    const { content, source, layer } = req.body;
    if (!content || !source) {
      return res.status(400).json({ error: 'content and source are required' });
    }

    // 202 Accepted immediately — extraction happens in background
    res.status(202).json({ queued: true });

    // Fire-and-forget: spawn extraction in background
    const { knowledgeAgent } = await import('../agents/knowledge-agent.service.js');
    knowledgeAgent.extractFromText(content, source, layer).catch(err => {
      logger.error({ source, error: String(err) }, '[KnowledgeRoutes] Text extraction failed');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to queue text extraction');
    res.status(500).json({ error: 'Failed to queue text extraction' });
  }
});

// Debug: synchronous extraction for testing pipeline end-to-end

/**
 * POST /api/knowledge/extract-behavior
 * Body: { content: string, source: string, threshold?: number }
 * Returns: 202 { queued: true }
 *
 * KE-003: Extract user behavior patterns from session transcript.
 * Runs in parallel with extract-text (both triggered by session:archive).
 */
knowledgeInternalRoutes.post('/extract-behavior', async (req, res) => {
  try {
    const { content, source, threshold } = req.body;
    if (!content || !source) {
      return res.status(400).json({ error: 'content and source are required' });
    }

    res.status(202).json({ queued: true });

    const { knowledgeAgent } = await import('../agents/knowledge-agent.service.js');
    knowledgeAgent.extractUserBehavior(content, source, threshold).catch(err => {
      logger.error({ source, error: String(err) }, '[KnowledgeRoutes] Behavior extraction failed');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to queue behavior extraction');
    res.status(500).json({ error: 'Failed to queue behavior extraction' });
  }
});
knowledgeInternalRoutes.post('/extract-text-sync', async (req, res) => {
  try {
    const { content, source, layer } = req.body;
    if (!content || !source) {
      return res.status(400).json({ error: 'content and source are required' });
    }

    // LLM API call via ModelGateway (auto-select provider based on config)
    const systemPrompt = `你是知识提取专家。从文本中提取结构化知识。输出格式：{ "entries": [{ "type": "pitfall|guideline|decision|architecture|process", "title": "根因概括", "content": "根因+责任+预防", "tags": ["标签"] }] }。只提取有价值的可复用知识，最多5条。`;

    const gatewayResponse = await modelGateway.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: content.slice(0, 50_000) },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });

    const llmContent = gatewayResponse.content;

    // Parse JSON from LLM response
    let result: any;
    try {
      result = JSON.parse(llmContent);
    } catch {
      const codeMatch = llmContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeMatch?.[1]) {
        try { result = JSON.parse(codeMatch[1].trim()); } catch {}
      }
      if (!result) {
        return res.json({ success: false, error: 'JSON parse failed', llmContent: llmContent.slice(0, 1000) });
      }
    }

    let ingestErrors: string[] = [];
    if (result.entries?.length) {
      try {
        const { sharedStore } = await import('../knowledge/knowledge-bus.service.js');
        for (const entry of result.entries) {
          try {
            const now = new Date().toISOString();
            const genId = `${entry.type.slice(0, 3).toUpperCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            sharedStore.save({
              id: genId,
              type: entry.type,
              title: entry.title,
              content: entry.content,
              maturity: 'draft' as any,
              layer: (layer || 'system') as any,
              created: now,
              lastReferenced: now,
              contributors: [],
              projects: [],
              tags: entry.tags || [],
              applicablePhases: [],
              sourceReferences: [{ commit: source, timestamp: now }],
              referencedBy: [],
            });
          } catch (e: any) {
            ingestErrors.push(e.message);
          }
        }
      } catch (e: any) {
        ingestErrors.push('import failed: ' + e.message);
      }
    }

    res.json({
      success: true,
      extracted: result.entries || [],
      entryCount: result.entries?.length || 0,
      ingestErrors: ingestErrors.length > 0 ? ingestErrors : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: 'Extraction failed', detail: String(error) });
  }
});