/**
 * documents.routes — 知识库文档子路由（公司数字资产管理）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET    /                      公司知识库（所有项目，companyId 必填）
 * - GET    /detail/:documentId    文档详情
 * - GET    /:projectId            项目文档列表
 * - POST   /:projectId            创建文档
 * - PUT    /:documentId           更新文档
 * - POST   /:documentId/archive   归档文档
 * - POST   /:documentId/approve   审批通过（Decision #4 知识审核闸门）
 * - POST   /:documentId/reject    驳回
 * - DELETE /:documentId           删除文档
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import {
  listDocs, getDoc, saveDoc, getProject, findProjectPmoNumber,
  type DocRecord,
} from './document-store.js';

export const documentsRoutes = Router();

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
documentsRoutes.get('/', async (req, res) => {
  try {
    const { companyId, type, status, search, page = 1, limit = 20 } = req.query;

    if (!companyId) {
      res.status(400).json({ error: 'companyId is required' });
      return;
    }

    let allDocs = await listDocs();
    const coId = String(companyId);
    allDocs = allDocs.filter(d => d.companyId === coId);
    if (type) allDocs = allDocs.filter(d => d.type === String(type));
    if (status) allDocs = allDocs.filter(d => d.status === String(status));
    if (search) {
      const q = String(search).toLowerCase();
      allDocs = allDocs.filter(d => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));
    }
    allDocs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const total = allDocs.length;
    const p = Number(page);
    const l = Number(limit);
    const documents = allDocs.slice((p - 1) * l, p * l);

    // Enrich with project PMO number
    const enriched = await Promise.all(documents.map(async d => {
      const proj = await findProjectPmoNumber(d.projectId);
      return { ...d, Project: proj };
    }));

    // 统计各类型数量
    const typeCounts: Record<string, number> = {};
    for (const d of allDocs) {
      typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
    }

    res.json({
      documents: enriched,
      total,
      page: p,
      limit: l,
      stats: typeCounts,
    });
  } catch (error) {
    logger.error('Failed to list knowledge');
    res.status(500).json({ error: 'Failed to list knowledge' });
  }
});

/**
 * 文档详情
 * GET /api/v1/knowledge/detail/:documentId
 */
documentsRoutes.get('/detail/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;

    const document = await getDoc(documentId);

    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const proj = await findProjectPmoNumber(document.projectId);
    res.json({ ...document, Project: proj });
  } catch (error) {
    logger.error('Failed to get document detail');
    res.status(500).json({ error: 'Failed to get document detail' });
  }
});

/**
 * 项目文档列表
 * GET /api/v1/knowledge/:projectId
 */
documentsRoutes.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { type } = req.query;

    let docs = await listDocs();
    docs = docs.filter(d => d.projectId === projectId);
    if (type) docs = docs.filter(d => d.type === String(type));
    docs.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    const documents = docs;

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
    logger.error('Failed to list project documents');
    res.status(500).json({ error: 'Failed to list project documents' });
  }
});

/**
 * 创建文档
 * POST /api/v1/knowledge/:projectId
 */
documentsRoutes.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { type, title, content, filePath, tags, createdBy } = req.body;

    if (!type || !title) {
      res.status(400).json({ error: 'type and title are required' });
      return;
    }

    // 获取项目信息 (FileStore)
    const project = await getProject(projectId);

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();
    const document: DocRecord = {
      id: docId, projectId, companyId: project.companyId || '', type, title,
      content: content || '', filePath, tags: tags || [], status: 'active', version: 1,
      createdBy, createdAt: now, updatedAt: now,
    };
    await saveDoc(document);

    logger.info('Document created');

    res.status(201).json(document);
  } catch (error) {
    logger.error('Failed to create document');
    res.status(500).json({ error: 'Failed to create document' });
  }
});

/**
 * 更新文档
 * PUT /api/v1/knowledge/:documentId
 */
documentsRoutes.put('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { title, content, filePath, tags, updatedBy } = req.body;

    const existing = await getDoc(documentId);
    if (!existing) { res.status(404).json({ error: 'Document not found' }); return; }
    if (title !== undefined) existing.title = title;
    if (content !== undefined) existing.content = content;
    if (filePath !== undefined) existing.filePath = filePath;
    if (tags !== undefined) existing.tags = tags;
    existing.updatedBy = updatedBy;
    existing.version = (existing.version || 0) + 1;
    existing.updatedAt = new Date().toISOString();
    await saveDoc(existing);
    const document = existing;

    logger.info( 'Document updated');

    res.json(document);
  } catch (error) {
    logger.error('Failed to update document');
    res.status(500).json({ error: 'Failed to update document' });
  }
});

/**
 * 归档文档
 * POST /api/v1/knowledge/:documentId/archive
 */
documentsRoutes.post('/:documentId/archive', async (req, res) => {
  try {
    const { documentId } = req.params;

    const existing = await getDoc(documentId);
    if (!existing) { res.status(404).json({ error: 'Document not found' }); return; }
    existing.status = 'archived';
    existing.archivedAt = new Date().toISOString();
    existing.updatedAt = new Date().toISOString();
    await saveDoc(existing);
    const document = existing;

    logger.info( 'Document archived');

    res.json(document);
  } catch (error) {
    logger.error('Failed to archive document');
    res.status(500).json({ error: 'Failed to archive document' });
  }
});

/**
 * Decision #4: 知识审核闸门
 * POST /api/v1/knowledge/:documentId/approve — 审批通过，提升 maturity 为 validated
 * POST /api/v1/knowledge/:documentId/reject  — 驳回，标记 status 为 rejected
 */
documentsRoutes.post('/:documentId/approve', async (req, res) => {
  try {
    const { documentId } = req.params;
    const doc = await getDoc(documentId);
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    doc.status = 'validated'; doc.updatedAt = new Date().toISOString();
    await saveDoc(doc);
    logger.info( 'Knowledge entry approved');
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve' });
  }
});

documentsRoutes.post('/:documentId/reject', async (req, res) => {
  try {
    const { documentId } = req.params;
    const doc = await getDoc(documentId);
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    doc.status = 'rejected'; doc.updatedAt = new Date().toISOString();
    await saveDoc(doc);
    logger.info( 'Knowledge entry rejected');
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Failed to reject' });
  }
});

/**
 * 删除文档
 * DELETE /api/v1/knowledge/:documentId
 */
documentsRoutes.delete('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;

    const doc = await getDoc(documentId);
    if (doc) { doc.status = 'deleted'; doc.updatedAt = new Date().toISOString(); await saveDoc(doc); }

    logger.info( 'Document deleted');

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete document');
    res.status(500).json({ error: 'Failed to delete document' });
  }
});
