/**
 * 知识库 API - 公司数字资产管理（挂载门面）
 *
 * 本文件为路由门面：创建两个 Router、按等价顺序挂载子路由、导出不变。
 * 处理器实现已按资源拆分为子路由（T3 大文件拆分序列 4/N，零行为变更）：
 *
 * - files.routes.ts      文件浏览：GET /requirements、POST /read-file、GET /file
 * - entries.routes.ts    知识条目：GET /export、POST /ask、GET /gaps[/:type]、
 *                        GET|POST /unified
 * - search.routes.ts     检索/指标：GET /resolutions、GET /search、
 *                        GET /resolution/density、GET /resolution/cross-session
 * - internal.routes.ts   内部端点（挂载于 /api/knowledge，无 auth）：
 *                        GET /sync-status、POST /upsert
 *
 * #149（2026-08-15）：document-store 退役，documents.routes（文档 CRUD/审核）与
 * evolution.routes（知识进化引擎，持久化只落在 document-store）一并摘除；
 * 原 /:projectId 通配路由随之消失，/export /ask 等字面路径不再被遮蔽。
 */

import { Router } from 'express';
import { filesRoutes } from './files.routes.js';
import { entriesRoutes } from './entries.routes.js';
import { searchRoutes } from './search.routes.js';
import { internalRoutes } from './internal.routes.js';
import { maintenanceRoutes } from './maintenance.routes.js';

// Public routes (mounted at /api/v1/knowledge with auth — see route-registry.ts)
export const knowledgeRoutes = Router();

// Internal routes (no auth, for local service-to-service calls)
export const knowledgeInternalRoutes = Router();

knowledgeRoutes.use(filesRoutes);
knowledgeRoutes.use(entriesRoutes);
knowledgeRoutes.use(searchRoutes);
knowledgeRoutes.use(maintenanceRoutes);

knowledgeInternalRoutes.use(internalRoutes);
