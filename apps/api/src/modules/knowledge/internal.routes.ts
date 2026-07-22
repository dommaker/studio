/**
 * internal.routes — 知识库内部子路由（无 auth，本地服务间调用）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移。
 * 挂载于 /api/knowledge（route-registry.ts，无 auth 中间件）：
 * - GET  /sync-status        知识同步状态（新鲜度检测 + 自动 heal）
 * - POST /upsert             设计时知识沉淀入口（KnowledgeStore + FileStore Document 投影）
 * - POST /extract-text-sync  Debug: 同步提取（端到端测试管线用）
 */

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { getModelForTier } from '@dommaker/studio-shared';
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
          const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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

// Debug: synchronous extraction for testing pipeline end-to-end

internalRoutes.post('/extract-text-sync', async (req, res) => {
  try {
    const { content, source, layer } = req.body;
    if (!content || !source) {
      return res.status(400).json({ error: 'content and source are required' });
    }

    // Direct API call for knowledge extraction
    const apiKey = process.env.DEEPSEEK_API_KEY || '';
    const knowledgeBaseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    const rawResponse = await fetch(`${knowledgeBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: getModelForTier('standard'),
        messages: [
          { role: 'system', content: `你是知识提取专家。从文本中提取结构化知识。输出格式：{ "entries": [{ "type": "pitfall|guideline|decision|architecture|process", "title": "根因概括", "content": "根因+责任+预防", "tags": ["标签"] }] }。只提取有价值的可复用知识，最多5条。` },
          { role: 'user', content: content.slice(0, 50_000) },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });
    const data = await rawResponse.json() as any;
    const llmContent = data.choices?.[0]?.message?.content || '';

    // Parse JSON from LLM response
    let result: any;
    try {
      result = JSON.parse(llmContent);
    } catch {
      const codeMatch = llmContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeMatch?.[1]) {
        try { result = JSON.parse(codeMatch[1].trim()); } catch {}
      }
      if (!result) {
        return res.json({ success: false, error: 'JSON parse failed', llmContent: llmContent.slice(0, 1000) });
      }
    }

    let ingestErrors: string[] = [];
    if (result.entries?.length) {
      try {
        const { sharedStore } = await import('../knowledge/knowledge-bus.service.js');
        for (const entry of result.entries) {
          try {
            const now = new Date().toISOString();
            const genId = `${entry.type.slice(0, 3).toUpperCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            sharedStore.save({
              id: genId,
              type: entry.type,
              title: entry.title,
              content: entry.content,
              maturity: 'draft' as any,
              layer: (layer || 'system') as any,
              created: now,
              lastReferenced: now,
              contributors: [],
              projects: [],
              tags: entry.tags || [],
              applicablePhases: [],
              sourceReferences: [{ commit: source, timestamp: now }],
              referencedBy: [],
              executionResults: [],
              consumptionMode: 'reference',
              origin: 'agent',
            });
          } catch (e: any) {
            ingestErrors.push(e.message);
          }
        }
      } catch (e: any) {
        ingestErrors.push('import failed: ' + e.message);
      }
    }

    res.json({
      success: true,
      extracted: result.entries || [],
      entryCount: result.entries?.length || 0,
      ingestErrors: ingestErrors.length > 0 ? ingestErrors : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: 'Extraction failed', detail: String(error) });
  }
});
