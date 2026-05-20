// B2-008: LLM Wiki — RequirementsDoc 档案馆
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

export const wikiRoutes = Router();

/**
 * GET /api/v1/wiki
 * 列表搜索：?search= 全文匹配 title/content，?status=confirmed,done
 */
wikiRoutes.get('/', async (req, res) => {
  try {
    const { search, status } = req.query;

    const where: any = {};

    if (status && typeof status === 'string') {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        where.status = { in: statuses };
      }
    }

    if (search && typeof search === 'string') {
      where.OR = [
        { title: { contains: search } },
        { content: { contains: search } },
      ];
    }

    const docs = await prisma.requirementsDoc.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        tags: true,
        status: true,
        goalId: true,
        projectId: true,
        sourceChannelId: true,
        updatedAt: true,
        createdAt: true,
      },
    });

    res.json({ success: true, data: docs });
  } catch (error) {
    logger.error('[Wiki] List failed', { error });
    res.status(500).json({ success: false, error: 'Failed to list wiki documents' });
  }
});

/**
 * GET /api/v1/wiki/graph
 * 图谱数据：所有 doc 节点 + linkedDocIds 边
 */
wikiRoutes.get('/graph', async (req, res) => {
  try {
    const docs = await prisma.requirementsDoc.findMany({
      select: {
        id: true,
        title: true,
        status: true,
        linkedDocIds: true,
      },
    });

    const nodes = docs.map(doc => ({
      id: doc.id,
      name: doc.title,
      status: doc.status,
    }));

    const edges: { source: string; target: string }[] = [];
    const docIdSet = new Set(docs.map(d => d.id));

    for (const doc of docs) {
      let linkedIds: string[] = [];
      try {
        linkedIds = JSON.parse(doc.linkedDocIds);
      } catch {
        linkedIds = [];
      }
      if (!Array.isArray(linkedIds)) linkedIds = [];

      for (const targetId of linkedIds) {
        if (docIdSet.has(targetId)) {
          edges.push({ source: doc.id, target: targetId });
        }
      }
    }

    res.json({ success: true, data: { nodes, edges } });
  } catch (error) {
    logger.error('[Wiki] Graph failed', { error });
    res.status(500).json({ success: false, error: 'Failed to build graph' });
  }
});

/**
 * GET /api/v1/wiki/:id
 * 文档详情：内容 + 解析的 [[链接]] + 反向链接列表
 */
wikiRoutes.get('/:id', async (req, res) => {
  try {
    const doc = await prisma.requirementsDoc.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    // 解析 [[链接]] 引用
    const linkPattern = /\[\[([^\]]+)\]\]/g;
    const referencedTitles: string[] = [];
    let match;
    while ((match = linkPattern.exec(doc.content)) !== null) {
      referencedTitles.push(match[1].trim());
    }

    // 查找被引用的文档（按 title 或 id 匹配）
    let linkedDocs: { id: string; title: string }[] = [];
    if (referencedTitles.length > 0) {
      linkedDocs = await prisma.requirementsDoc.findMany({
        where: {
          OR: [
            { id: { in: referencedTitles } },
            { title: { in: referencedTitles } },
          ],
        },
        select: { id: true, title: true },
      });
    }

    // 解析 linkedDocIds
    let linkedIds: string[] = [];
    try {
      linkedIds = JSON.parse(doc.linkedDocIds);
    } catch {
      linkedIds = [];
    }
    if (!Array.isArray(linkedIds)) linkedIds = [];

    // 获取 linkedDocIds 对应的文档
    let linkedDocsByIds: { id: string; title: string }[] = [];
    if (linkedIds.length > 0) {
      linkedDocsByIds = await prisma.requirementsDoc.findMany({
        where: { id: { in: linkedIds } },
        select: { id: true, title: true },
      });
    }

    // 反向链接：哪些文档的 linkedDocIds 包含当前 doc.id
    const allDocs = await prisma.requirementsDoc.findMany({
      where: { id: { not: doc.id } },
      select: { id: true, title: true, linkedDocIds: true },
    });

    const backlinks: { id: string; title: string }[] = [];
    for (const other of allDocs) {
      let otherLinkedIds: string[] = [];
      try {
        otherLinkedIds = JSON.parse(other.linkedDocIds);
      } catch {
        otherLinkedIds = [];
      }
      if (Array.isArray(otherLinkedIds) && otherLinkedIds.includes(doc.id)) {
        backlinks.push({ id: other.id, title: other.title });
      }
    }

    res.json({
      success: true,
      data: {
        ...doc,
        linkedDocs: linkedDocsByIds,
        wikiLinks: linkedDocs,
        backlinks,
      },
    });
  } catch (error) {
    logger.error('[Wiki] Get doc failed', { error, id: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to get document' });
  }
});

/**
 * PUT /api/v1/wiki/:id
 * 更新：content / linkedDocIds / title
 */
wikiRoutes.put('/:id', async (req, res) => {
  try {
    const { content, title, linkedDocIds } = req.body;

    const doc = await prisma.requirementsDoc.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const updateData: any = {};

    if (content !== undefined) {
      if (typeof content !== 'string') {
        return res.status(400).json({ success: false, error: 'content must be a string' });
      }
      updateData.content = content;
    }

    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, error: 'title must be a non-empty string' });
      }
      updateData.title = title.trim();
    }

    if (linkedDocIds !== undefined) {
      if (!Array.isArray(linkedDocIds)) {
        return res.status(400).json({ success: false, error: 'linkedDocIds must be an array' });
      }
      updateData.linkedDocIds = JSON.stringify(linkedDocIds);
    }

    const updated = await prisma.requirementsDoc.update({
      where: { id: req.params.id },
      data: updateData,
    });

    logger.info('[Wiki] Updated', { id: req.params.id });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('[Wiki] Update failed', { error, id: req.params.id });
    res.status(500).json({ success: false, error: 'Failed to update document' });
  }
});
