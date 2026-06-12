// B2-008: LLM Wiki — RequirementsDoc 档案馆
import { Router } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { listWikiDocs, buildWikiGraph, getWikiDocById } from './wiki.service.js';

export const wikiRoutes = Router();

/**
 * GET /api/v1/wiki
 * 列表搜索：?search= 全文匹配 title/content，?status=confirmed,done
 * SDD-first, DB fallback.
 */
wikiRoutes.get('/', async (req, res) => {
  try {
    const { search, status } = req.query;
    const docs = await listWikiDocs({
      search: typeof search === 'string' ? search : undefined,
      status: typeof status === 'string' ? status : undefined,
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
 * SDD-first, DB fallback.
 */
wikiRoutes.get('/graph', async (req, res) => {
  try {
    const { nodes, edges } = await buildWikiGraph();
    res.json({ success: true, data: { nodes, edges } });
  } catch (error) {
    logger.error('[Wiki] Graph failed', { error });
    res.status(500).json({ success: false, error: 'Failed to build graph' });
  }
});

/**
 * GET /api/v1/wiki/:id
 * 文档详情：内容 + 3 层（requirement/design/task）+ 链接解析
 * SDD-first, DB fallback.
 */
wikiRoutes.get('/:id', async (req, res) => {
  try {
    const doc = await getWikiDocById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    res.json({ success: true, data: doc });
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
