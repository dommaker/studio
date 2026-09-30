// T5 #155: library 阅览室——跨项目 .studio/ 聚合只读层
import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { listLibraryDocs, getLibraryDoc } from './library.service.js';

export const libraryRoutes = Router();

/**
 * GET /api/v1/library
 * 聚合列表：?project=<projectId> 收窄单项目，?search= 匹配 title/正文
 */
libraryRoutes.get('/', async (req, res) => {
  try {
    const { project, search } = req.query;
    const docs = await listLibraryDocs({
      projectId: typeof project === 'string' ? project : undefined,
      search: typeof search === 'string' ? search : undefined,
    });
    res.json({ success: true, data: docs });
  } catch (error) {
    logger.error('[Library] List failed', { error });
    res.status(500).json({ success: false, error: 'Failed to list library documents' });
  }
});

/**
 * GET /api/v1/library/:id
 * 文档详情；id = `${projectId}:${relPath}`（前端 encodeURIComponent 整段传入）。
 * 通配 `/*splat`（Express 5 / path-to-regexp v8：通配必须命名）：nginx proxy_pass
 * 带 URI（/api/）会先解码 %2F→/ 再转发，id 以多段路径原形到达（/proj:specs/a.md），
 * 单段 /:id 匹配不到恒 404（2026-09-10 修复）。
 * req.params.splat 是已解码的段数组（v8 行为），join('/') 还原多段 id；
 * 禁止再手动 decodeURIComponent（双重解码）。
 */
libraryRoutes.get('/*splat', async (req, res) => {
  const id = (req.params.splat as unknown as string[]).join('/');
  try {
    const doc = await getLibraryDoc(id);
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    res.json({ success: true, data: doc });
  } catch (error) {
    logger.error('[Library] Get doc failed', { error, id });
    res.status(500).json({ success: false, error: 'Failed to get document' });
  }
});
