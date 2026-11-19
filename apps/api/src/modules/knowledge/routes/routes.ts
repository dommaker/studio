/**
 * 知识库 API - 公司数字资产管理（挂载门面）
 *
 * 本文件为路由门面：创建两个 Router、按等价顺序挂载子路由、导出不变。
 * 处理器实现已按资源拆分为子路由（T3 大文件拆分序列 4/N，零行为变更）：
 *
 * - entries.routes.ts    知识条目：GET /gaps/:type、GET|POST /unified
 * - search.routes.ts     检索：GET /resolutions、GET /search
 * - internal.routes.ts   内部端点（挂载于 /api/knowledge，无 auth）：
 *                        GET /sync-status、POST /upsert
 * - maintenance.routes.ts 维护：POST /maintenance/run
 *
 * P4.2（2026-10-17）：files.routes.ts（GET /requirements、POST /read-file、
 * GET /file 文件浏览三端点）整体为孤儿（web/cli/mcp/studio-config 均无消费方）
 * 已删，子路由与门面挂载一并摘除（见 CONTEXT.md）。
 *
 * #149（2026-08-15）：document-store 退役，documents.routes（文档 CRUD/审核）与
 * evolution.routes（知识进化引擎，持久化只落在 document-store）一并摘除；
 * 原 /:projectId 通配路由随之消失。
 */

import { Router } from 'express';
import { entriesRoutes } from './entries.routes.js';
import { searchRoutes } from './search.routes.js';
import { internalRoutes } from './internal.routes.js';
import { maintenanceRoutes } from './maintenance.routes.js';

// Public routes (mounted at /api/v1/knowledge with auth — see route-registry.ts)
export const knowledgeRoutes = Router();

// Internal routes (no auth, for local service-to-service calls)
export const knowledgeInternalRoutes = Router();

knowledgeRoutes.use(entriesRoutes);
knowledgeRoutes.use(searchRoutes);
knowledgeRoutes.use(maintenanceRoutes);

knowledgeInternalRoutes.use(internalRoutes);
