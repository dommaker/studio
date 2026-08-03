/**
 * 知识库 API - 公司数字资产管理（挂载门面）
 *
 * 本文件为路由门面：创建两个 Router、按等价顺序挂载子路由、导出不变。
 * 处理器实现已按资源拆分为子路由（T3 大文件拆分序列 4/N，零行为变更）：
 *
 * - files.routes.ts      文件浏览：GET /requirements、POST /read-file、GET /file
 * - documents.routes.ts  文档 CRUD/审核：GET /、GET /detail/:documentId、
 *                        GET|POST /:projectId、PUT|DELETE /:documentId、
 *                        POST /:documentId/archive|approve|reject
 * - entries.routes.ts    知识条目：GET /export、POST /ask、GET /gaps[/:type]、
 *                        GET|POST /unified
 * - evolution.routes.ts  知识进化：POST /evolution/micro|meso|macro|decay、
 *                        GET /evolution/health
 * - search.routes.ts     检索/指标：GET /resolutions、GET /search、
 *                        GET /resolution/density、GET /resolution/cross-session
 * - internal.routes.ts   内部端点（挂载于 /api/knowledge，无 auth）：
 *                        GET /sync-status、POST /upsert
 *
 * 挂载顺序等价性（Express 路由匹配顺序敏感）：
 * 原文件单 Router 注册顺序中，/requirements、/read-file、/file 三个字面路径位于
 * /:projectId 之前；其余子路由均为互不重叠的字面前缀路径，且单段字面路径
 * （/export /ask /gaps /resolutions /search /unified）在原文件中本就注册于
 * /:projectId 之后（被其遮蔽）。挂载 files → documents → 其余子路由后，
 * 任一 method+path 的第一个匹配处理器与原文件完全一致（逐对核对无交集冲突），
 * 包括原有的遮蔽行为也原样保留。
 */

import { Router } from 'express';
import { filesRoutes } from './files.routes.js';
import { documentsRoutes } from './documents.routes.js';
import { entriesRoutes } from './entries.routes.js';
import { evolutionRoutes } from './evolution.routes.js';
import { searchRoutes } from './search.routes.js';
import { internalRoutes } from './internal.routes.js';
import { maintenanceRoutes } from './maintenance.routes.js';

// Public routes (mounted at /api/v1/knowledge with auth — see route-registry.ts)
export const knowledgeRoutes = Router();

// Internal routes (no auth, for local service-to-service calls)
export const knowledgeInternalRoutes = Router();

knowledgeRoutes.use(filesRoutes);
knowledgeRoutes.use(documentsRoutes);
knowledgeRoutes.use(entriesRoutes);
knowledgeRoutes.use(evolutionRoutes);
knowledgeRoutes.use(searchRoutes);
knowledgeRoutes.use(maintenanceRoutes);

knowledgeInternalRoutes.use(internalRoutes);
