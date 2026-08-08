/**
 * internal.routes — 知识库内部子路由（无 auth，本地服务间调用）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移。
 * 挂载于 /api/knowledge（route-registry.ts，无 auth 中间件）：
 * - GET  /sync-status        知识同步状态（新鲜度检测 + 自动 heal）
 * - POST /upsert             设计时知识沉淀入口（KnowledgeStore + FileStore Document 投影）
 *
 * 2026-07-28: POST /extract-text-sync 已删除——直连 DeepSeek HTTP API 时代的 debug
 * 路由（绕过 CLI、零调用方）；知识提取统一走 SystemExecutor（studio 角色绑定的 CLI）。
 */

import { Router } from 'express';
import { generateId, logger } from '@dommaker/studio-shared';
import { upsertKnowledge } from './knowledge-bus.service.js';
import type { KnowledgeSource } from './knowledge-bus.service.js';
import { knowledgeSync } from './knowledge-sync.service.js';
import { listDocs, saveDoc, type DocRecord } from './document-store.js';

export const internalRoutes = Router();

/**
 * GET /api/knowledge/sync-status — 知识同步状态（新鲜度检测）
 */
internalRoutes.get('/sync-status', async (_req, res) => {
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
internalRoutes.post('/upsert', async (req, res) => {
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

    // 2. Sync to FileStore Document (Studio UI projection)
    let docResult: { action: string; docId: string } = { action: 'skipped', docId: '' };
    try {
      let projectId = reqProjectId;
      let companyId = reqCompanyId;
      if (!projectId || !companyId) {
        const allDocs = await listDocs();
        const firstDoc = allDocs[0];
        if (firstDoc) {
          projectId = projectId || firstDoc.projectId;
          companyId = companyId || firstDoc.companyId;
        }
      }
      if (!projectId || !companyId) {
        logger.warn( '[KnowledgeRoute] No project/company found, skipping Document sync');
      } else {
        const allDocs2 = await listDocs();
        const existing = allDocs2.find(d => d.title === title && d.type === 'design' && d.projectId === projectId);
        if (existing) {
          existing.content = content;
          existing.version = (existing.version || 0) + 1;
          existing.updatedAt = new Date().toISOString();
          await saveDoc(existing);
          docResult = { action: 'updated', docId: existing.id };
        } else {
          const docId = generateId('doc');
          const now = new Date().toISOString();
          const doc: DocRecord = {
            id: docId, projectId, companyId, type: 'design', title, content,
            tags: [scope, 'design-doc'], status: 'active', version: 1,
            createdAt: now, updatedAt: now,
          };
          await saveDoc(doc);
          docResult = { action: 'created', docId: doc.id };
        }
      }
    } catch (e: any) {
      logger.warn( '[KnowledgeRoute] Document sync failed (non-blocking)');
    }

    res.json({
      knowledgeStore: ksResult,
      prismaDocument: docResult,
    });
  } catch (e: any) {
    logger.error( '[KnowledgeRoute] Upsert failed');
    res.status(500).json({ error: String(e) });
  }
});
