/**
 * Knowledge Evolution Engine (§12.12)
 *
 * 三层进化闭环：
 * - 微观：每次执行后提取/更新知识条目
 * - 中观：项目级别知识整合和模式识别
 * - 宏观：跨项目知识迁移和最佳实践提炼
 *
 * 知识成熟度：draft → verified → proven → archived (与 harness 对齐)
 */

import { logger, FileStore, generateId } from '@dommaker/studio-shared';
import { getSystemExecutor } from '../agents/system-executor.js';
import * as path from 'path';
import * as fs from 'node:fs';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import type { MaturityLevel } from '@dommaker/harness';
import { knowledgeBus } from './knowledge-bus.service.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

const DOCUMENTS_DIR = studioPath('data', 'documents');
const PROJECTS_DIR = studioPath('projects');

interface DocRecord {
  id: string; projectId: string; companyId: string; type: string;
  title: string; content: string; tags: string[]; status: string;
  version: number; updatedAt: string; createdAt: string;
}

async function listDocs(): Promise<DocRecord[]> {
  try {
    const entries = await fs.promises.readdir(DOCUMENTS_DIR, { withFileTypes: true });
    const docs: DocRecord[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const d = await fileStore.readJson<DocRecord>(path.join(DOCUMENTS_DIR, e.name));
      if (d) docs.push(d);
    }
    return docs;
  } catch { return []; }
}

async function getDoc(id: string): Promise<DocRecord | null> {
  return fileStore.readJson<DocRecord>(path.join(DOCUMENTS_DIR, `${id}.json`));
}

async function saveDoc(doc: DocRecord): Promise<void> {
  await fs.promises.mkdir(DOCUMENTS_DIR, { recursive: true });
  await fileStore.writeJson(path.join(DOCUMENTS_DIR, `${doc.id}.json`), doc);
}

async function listProjects(): Promise<any[]> {
  try {
    const entries = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects: any[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const p = await fileStore.readJson<any>(path.join(PROJECTS_DIR, e.name));
      if (p) projects.push(p);
    }
    return projects;
  } catch { return []; }
}

// ─── 类型 ───

export interface EvolutionResult {
  documentId: string;
  previousMaturity: MaturityLevel;
  newMaturity: MaturityLevel;
  reason: string;
}

const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');
const fileStore = new FileStore();

// ─── Knowledge Evolution Service ───

export class KnowledgeEvolutionService {

  /**
   * 微观进化：执行完成后提取知识
   * 从执行结果中提取关键发现，创建或更新知识条目
   */
  async microEvolution(executionId: string, projectId: string, companyId: string): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = [];

    // 获取执行记录
    const allExecs = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    const execution = allExecs.find((e: any) => e.id === executionId) || null;

    if (!execution || !execution.error) return results;

    // 使用 LLM 从执行结果中提取知识
    try {
      const extractionPrompt = `从以下执行结果中提取知识条目。返回 JSON 数组，每个条目包含 title, content, type(requirement/design/spec/execution/meeting), tags[]。

执行状态: ${execution.status}
执行结果: ${JSON.stringify(execution.error || execution.nodeExecutions).slice(0, 2000)}`;

      const extraction = await getSystemExecutor().runJson<Array<{ title?: string; content?: string; type?: string; tags?: string[] }>>(extractionPrompt);

      const entries = Array.isArray(extraction) ? extraction : [];

      for (const entry of entries.slice(0, 3)) { // 最多 3 条
        // 验证 LLM 返回的条目
        if (!entry.title || typeof entry.title !== 'string') continue;
        if (!entry.content || typeof entry.content !== 'string' || entry.content.trim().length === 0) continue;
        const validTypes = ['requirement', 'design', 'spec', 'execution', 'meeting'];
        if (!validTypes.includes(entry.type)) entry.type = 'execution';
        if (!Array.isArray(entry.tags)) entry.tags = [];
        // 检查是否已存在相似文档
        const allDocs = await listDocs();
        const existing = allDocs.find(d =>
          d.projectId === projectId && d.status === 'active' && d.title.includes(entry.title?.slice(0, 20) || '')
        );

        if (existing) {
          // 更新现有条目：增加引用计数
          existing.updatedAt = new Date().toISOString();
          existing.version = (existing.version || 0) + 1;
          await saveDoc(existing);
          results.push({
            documentId: existing.id,
            previousMaturity: 'verified',
            newMaturity: 'proven',
            reason: 'Referenced by new execution',
          });
        } else {
          // 创建新条目
          const docId = generateId('doc');
          const now = new Date().toISOString();
          const doc: DocRecord = {
            id: docId, projectId, companyId,
            type: entry.type || 'execution',
            title: entry.title || 'Extracted knowledge',
            content: entry.content || '',
            tags: entry.tags || [],
            status: 'active',
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          await saveDoc(doc);
          results.push({
            documentId: doc.id,
            previousMaturity: 'draft',
            newMaturity: 'draft',
            reason: 'New knowledge extracted from execution',
          });

          // B13-008: 飞轮接桥 — microEvolution 产出写入 KnowledgeBus
          knowledgeBus.recordPattern({
            source: 'evolution',
            type: 'pattern',
            title: `[Evolution] ${entry.title}`,
            content: entry.content,
            severity: 'info',
            timestamp: Date.now(),
          }).catch(() => { /* non-blocking */ });
        }
      }
    } catch (error) {
      logger.error('Micro evolution failed', { executionId, error: String(error) });
    }

    return results;
  }

  /**
   * 中观进化：项目级别知识整合
   * 合并相似文档，识别模式，提升成熟度
   */
  async mesoEvolution(projectId: string): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = [];

    // 获取项目的所有活跃文档 (FileStore)
    const allDocs2 = await listDocs();
    const docs = allDocs2.filter(d => d.projectId === projectId && d.status === 'active')
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    // 按类型分组
    const byType: Record<string, typeof docs> = {};
    for (const doc of docs) {
      if (!byType[doc.type]) byType[doc.type] = [];
      byType[doc.type].push(doc);
    }

    // 对每种类型检查是否可以提升成熟度
    for (const [type, typeDocs] of Object.entries(byType)) {
      if (typeDocs.length < 2) continue;

      // 检查是否有足够多的文档可以合并为 canonical
      if (typeDocs.length >= 5) {
        // 使用 LLM 识别模式
        try {
          const titles = typeDocs.map(d => d.title).join(', ');
          const analysis = await getSystemExecutor().runJson<{ pattern?: string; recommendation?: string }>(
            'agent_default',
            { systemPrompt: `分析以下同类型文档标题，识别共同模式和最佳实践。返回 JSON: {pattern: string, recommendation: string}

类型: ${type}
文档: ${titles}` },
          );

          if (analysis?.pattern) {
            logger.info('Pattern identified in meso evolution', { projectId, type, pattern: analysis.pattern });
            // Gap 2: 写入结果
            const proj = await fileStore.readJson<any>(path.join(PROJECTS_DIR, `${projectId}.json`));
            if (proj?.companyId) {
              const docId2 = generateId('doc');
              const now2 = new Date().toISOString();
              const doc2: DocRecord = {
                id: docId2, projectId, companyId: proj.companyId,
                type: type as any,
                title: `[Pattern] ${analysis.pattern}`,
                content: analysis.recommendation || `跨 ${typeDocs.length} 个文档的公共模式`,
                status: 'active', version: 1,
                tags: ['meso-evolution', type],
                createdAt: now2,
                updatedAt: now2,
              };
              await saveDoc(doc2);
              results.push({ documentId: doc2.id, previousMaturity: 'draft', newMaturity: 'verified', reason: 'meso pattern identified' });

              // B13-008: 飞轮接桥 — mesoEvolution 模式写入 KnowledgeBus
              knowledgeBus.recordPattern({
                source: 'evolution',
                type: 'pattern',
                title: `[Meso Pattern] ${analysis.pattern}`,
                content: analysis.recommendation || `跨 ${typeDocs.length} 个 ${type} 文档的公共模式`,
                severity: 'info',
                timestamp: Date.now(),
              }).catch(() => { /* non-blocking */ });
            }
          }
        } catch (error) {
          logger.error('Meso evolution analysis failed', { projectId, type, error: String(error) });
        }
      }
    }

    return results;
  }

  /**
   * 宏观进化：跨项目知识迁移
   * 识别跨项目的最佳实践
   */
  async macroEvolution(companyId: string): Promise<{ insights: string[] }> {
    const insights: string[] = [];

    // 获取公司所有项目
    const allProjects = await listProjects();
    const projects = allProjects.filter(p => p.companyId === companyId).map(p => ({ id: p.id, title: p.title }));

    if (projects.length < 2) {
      return { insights: ['Need at least 2 projects for macro evolution'] };
    }

    // 统计各项目的知识分布
    const projectStats = await Promise.all(
      projects.map(async (p) => {
        const projDocs = await listDocs();
        const projActive = projDocs.filter(d => d.projectId === p.id && d.status === 'active');
        const typeGroups: Record<string, number> = {};
        for (const d of projActive) {
          typeGroups[d.type] = (typeGroups[d.type] || 0) + 1;
        }
        const docs = Object.entries(typeGroups).map(([type, _count]) => ({ type, _count }));
        return { project: p, stats: docs };
      })
    );

    // 识别知识空白
    const allTypes = new Set<string>();
    for (const ps of projectStats) {
      for (const s of ps.stats) {
        allTypes.add(s.type);
      }
    }

    for (const ps of projectStats) {
      const existingTypes = new Set(ps.stats.map(s => s.type));
      const missingTypes = [...allTypes].filter(t => !existingTypes.has(t));
      if (missingTypes.length > 0) {
        insights.push(`Project "${ps.project.title}" is missing knowledge types: ${missingTypes.join(', ')}`);
        // Gap 2: 跨项目知识迁移 — 从有该类型的项目复制一份共享文档
        for (const missingType of missingTypes) {
          const sourceProject = projectStats.find(s => s.stats.some(st => st.type === missingType));
          if (sourceProject) {
            try {
              const allDocsM = await listDocs();
              const sourceDoc = allDocsM
                .filter(d => d.projectId === sourceProject.project.id && d.type === (missingType as any) && d.status === 'active')
                .sort((a: DocRecord, b: DocRecord) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null;
              if (sourceDoc) {
                const did = generateId('doc');
                const dn = new Date().toISOString();
                const md: DocRecord = {
                  id: did, projectId: ps.project.id, companyId,
                  type: missingType as any,
                  title: `[Shared] ${sourceDoc.title}`,
                  content: `跨项目知识迁移，源自项目 ${sourceProject.project.title}:\n\n${(sourceDoc as any).content?.slice(0, 2000) || ''}`,
                  status: 'active', version: 1,
                  tags: ['macro-evolution', 'cross-project', missingType],
                  createdAt: dn, updatedAt: dn,
                };
                await saveDoc(md);
                insights.push(`  → 已为 "${ps.project.title}" 创建 ${missingType} 文档`);
              }
            } catch (e) {
              logger.warn('[KnowledgeEvolution] Single migration failed, continuing', { error: String(e) });
            }
          }
        }
      }
    }

    return { insights };
  }

  /**
   * 衰减检查：降级长期未使用的知识（分批处理避免 OOM）
   */
  async decayCheck(): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = [];
    const now = new Date();
    const BATCH_SIZE = 100;
    let skip = 0;

    // eslint-disable-next-line no-constant-condition
    const allActive = (await listDocs()).filter(d => d.status === 'active')
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    while (skip < allActive.length) {
      const docs = allActive.slice(skip, skip + BATCH_SIZE).map(d => ({ id: d.id, type: d.type, updatedAt: d.updatedAt }));

      if (docs.length === 0) break;

      for (const doc of docs) {
        const daysSinceUpdate = (now.getTime() - new Date(doc.updatedAt).getTime()) / (1000 * 60 * 60 * 24);

        // 根据类型确定衰减天数
        const decayDays = doc.type === 'execution' ? 30 : doc.type === 'meeting' ? 60 : 90;

        if (daysSinceUpdate > decayDays) {
          const decayDoc = await getDoc(doc.id);
          if (decayDoc) { decayDoc.status = 'archived'; (decayDoc as any).archivedAt = now.toISOString(); decayDoc.updatedAt = now.toISOString(); await saveDoc(decayDoc); }
          results.push({
            documentId: doc.id,
            previousMaturity: 'proven',
            newMaturity: 'archived',
            reason: `Decayed after ${Math.floor(daysSinceUpdate)} days of inactivity`,
          });
        }
      }

      if (docs.length < BATCH_SIZE) break;
      skip += BATCH_SIZE;
    }

    return results;
  }

  /**
   * 获取知识库健康指标
   */
  async getHealthMetrics(companyId: string): Promise<Record<string, any>> {
    const allDocs = await listDocs();
    const coDocs = allDocs.filter(d => d.companyId === companyId);
    const total = coDocs.length;
    const active = coDocs.filter(d => d.status === 'active').length;
    const archived = coDocs.filter(d => d.status === 'archived').length;
    const typeMap: Record<string, number> = {};
    for (const d of coDocs) {
      if (d.status === 'active') typeMap[d.type] = (typeMap[d.type] || 0) + 1;
    }
    const byType = Object.entries(typeMap).map(([type, _count]) => ({ type, _count }));

    const typeDistribution: Record<string, number> = {};
    for (const item of byType) {
      typeDistribution[item.type] = item._count;
    }

    return {
      total,
      active,
      archived,
      archiveRate: total > 0 ? (archived / total * 100).toFixed(1) + '%' : '0%',
      typeDistribution,
      healthScore: active > 0 ? Math.min(100, active * 10) : 0,
    };
  }
}

export const knowledgeEvolution = new KnowledgeEvolutionService();
