/**
 * internal.routes — 知识库内部子路由（无 auth，本地服务间调用）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移。
 * 挂载于 /api/knowledge（route-registry.ts，无 auth 中间件）：
 * - GET  /sync-status        知识同步状态（新鲜度检测 + 自动 heal）
 * - POST /upsert             设计时知识沉淀入口（KnowledgeStore）
 *
 * 2026-07-28: POST /extract-text-sync 已删除——直连 DeepSeek HTTP API 时代的 debug
 * 路由（绕过 CLI、零调用方）；知识提取统一走 SystemExecutor（studio 角色绑定的 CLI）。
 * 2026-08-15（#149）：document-store 退役，/upsert 的 FileStore Document 投影
 * （UI 已随 documents.routes 摘除）一并移除，只写 KnowledgeStore。
 *
 * 契约驱动迁移（2026-10 批次 4/7）：全端点走 core/http.ts defineRoute——
 * scope/title/content 必填 guard 收进 zod（原手写 400）；响应统一 `{ data }` 壳
 * （原平铺 `{ trackedScopes, ... }` / `{ knowledgeStore }`）；错误统一
 * `{ error: { code, message } }`。
 */

import { Router } from 'express';
import { upsertKnowledgeBodySchema } from '@dommaker/studio-contract';
import { upsertKnowledge } from './knowledge-design-doc.js';
import type { KnowledgeSource } from './knowledge-design-doc.js';
import { knowledgeSync } from './knowledge-sync.service.js';
import { defineRoute } from '../../core/http.js';

export const internalRoutes = Router();

/**
 * GET /api/knowledge/sync-status — 知识同步状态（新鲜度检测）
 */
internalRoutes.get('/sync-status', defineRoute({}, async () => {
  const { stale, unmonitored } = knowledgeSync.detectStaleness();
  const trackedScopes = knowledgeSync.getTrackedScopes();

  // Heal stale entries
  let healed: string[] = [];
  if (stale.length > 0) {
    healed = await knowledgeSync.heal(stale);
  }

  return { trackedScopes, stale, unmonitored, healed };
}));

/**
 * POST /api/knowledge/upsert — 设计时知识沉淀入口
 *
 * 写入 KnowledgeStore (单一事实源)。
 * 内部端点，无 auth。供 Claude Code / Analyst / CLI 调用。
 *
 * Body: { scope, title, content, type?, source? }
 * （必填三件套原手写 400 → zod 400）
 */
internalRoutes.post('/upsert', defineRoute({ body: upsertKnowledgeBodySchema }, async (_req, _res, { body }) => {
  const { scope, title, content, type, source } = body;

  // Write to KnowledgeStore (single source of truth)
  const ksResult = await upsertKnowledge({
    scope,
    title,
    content,
    type: type as 'architecture' | 'process' | 'guideline' | undefined,
    source: source as KnowledgeSource | undefined,
  });

  return { knowledgeStore: ksResult };
}));
