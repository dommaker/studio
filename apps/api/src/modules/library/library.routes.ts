// T5 #155: library 阅览室——跨项目 .studio/ 聚合只读层
//
// 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
// 响应统一 `{ data }` 壳（原 `{ success: true, data }` 壳的 success 标志退役）；
// 错误统一 `{ error: { code, message } }`（原 `{ success: false, error: string }`）。
// 通配路由保持 Express 5 写法 `GET /*splat`——splat 段数组不进 zod params
// （zod params 是对象形状），query 照常校验。
import { Router } from 'express';
import { listLibraryDocsQuerySchema, ERROR_CODES } from '@dommaker/studio-contract';
import { listLibraryDocs, getLibraryDoc } from './library.service.js';
import { defineRoute, HttpError } from '../../core/http.js';

export const libraryRoutes = Router();

/**
 * GET /api/v1/library
 * 聚合列表：?project=<projectId> 收窄单项目，?search= 匹配 title/正文
 */
libraryRoutes.get('/', defineRoute({ query: listLibraryDocsQuerySchema }, async (_req, _res, { query }) => {
  return listLibraryDocs({
    projectId: query.project,
    search: query.search,
  });
}));

/**
 * GET /api/v1/library/:id
 * 文档详情；id = `${projectId}:${relPath}`（前端 encodeURIComponent 整段传入）。
 * 通配 `/*splat`（Express 5 / path-to-regexp v8：通配必须命名）：nginx proxy_pass
 * 带 URI（/api/）会先解码 %2F→/ 再转发，id 以多段路径原形到达（/proj:specs/a.md），
 * 单段 /:id 匹配不到恒 404（2026-09-10 修复）。
 * req.params.splat 是已解码的段数组（v8 行为），join('/') 还原多段 id；
 * 禁止再手动 decodeURIComponent（双重解码）。
 */
libraryRoutes.get('/*splat', defineRoute({}, async (req) => {
  const id = (req.params.splat as unknown as string[]).join('/');
  const doc = await getLibraryDoc(id);
  if (!doc) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Document not found');
  }
  return doc;
}));
