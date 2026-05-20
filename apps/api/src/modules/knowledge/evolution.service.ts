/**
 * Knowledge Evolution Engine (§12.12)
 *
 * 三层进化闭环：
 * - 微观：每次执行后提取/更新知识条目
 * - 中观：项目级别知识整合和模式识别
 * - 宏观：跨项目知识迁移和最佳实践提炼
 *
 * 知识成熟度：draft → candidate → validated → canonical → archived
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';

// ─── 类型 ───

export type MaturityLevel = 'draft' | 'candidate' | 'validated' | 'canonical' | 'archived';

export interface MaturityConfig {
  level: MaturityLevel;
  confidence: number;       // 0-1
  accessThreshold: number;  // 最少被引用次数
  decayDays: number;        // 未使用多少天后降级
}

export interface EvolutionResult {
  documentId: string;
  previousMaturity: MaturityLevel;
  newMaturity: MaturityLevel;
  reason: string;
}

// ─── 成熟度配置 ───

const MATURITY_LADDER: MaturityConfig[] = [
  { level: 'draft', confidence: 0.3, accessThreshold: 0, decayDays: 30 },
  { level: 'candidate', confidence: 0.5, accessThreshold: 2, decayDays: 60 },
  { level: 'validated', confidence: 0.7, accessThreshold: 5, decayDays: 90 },
  { level: 'canonical', confidence: 0.9, accessThreshold: 10, decayDays: 180 },
  { level: 'archived', confidence: 0, accessThreshold: 0, decayDays: 0 },
];

// ─── Knowledge Evolution Service ───

export class KnowledgeEvolutionService {

  /**
   * 微观进化：执行完成后提取知识
   * 从执行结果中提取关键发现，创建或更新知识条目
   */
  async microEvolution(executionId: string, projectId: string, companyId: string): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = [];

    // 获取执行记录
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
    });

    if (!execution || !execution.error) return results;

    // 使用 LLM 从执行结果中提取知识
    try {
      const extractionPrompt = `从以下执行结果中提取知识条目。返回 JSON 数组，每个条目包含 title, content, type(requirement/design/spec/execution/meeting), tags[]。

执行状态: ${execution.status}
执行结果: ${JSON.stringify(execution.error || execution.nodeExecutions).slice(0, 2000)}`;

      const extraction = await modelGateway.promptJson(extractionPrompt);

      const entries = Array.isArray(extraction) ? extraction : [];

      for (const entry of entries.slice(0, 3)) { // 最多 3 条
        // 验证 LLM 返回的条目
        if (!entry.title || typeof entry.title !== 'string') continue;
        if (!entry.content || typeof entry.content !== 'string' || entry.content.trim().length === 0) continue;
        const validTypes = ['requirement', 'design', 'spec', 'execution', 'meeting'];
        if (!validTypes.includes(entry.type)) entry.type = 'execution';
        if (!Array.isArray(entry.tags)) entry.tags = [];
        // 检查是否已存在相似文档
        const existing = await prisma.document.findFirst({
          where: {
            projectId,
            title: { contains: entry.title?.slice(0, 20), mode: 'insensitive' },
            status: 'active',
          },
        });

        if (existing) {
          // 更新现有条目：增加引用计数
          await prisma.document.update({
            where: { id: existing.id },
            data: {
              updatedAt: new Date(),
              version: { increment: 1 },
            },
          });
          results.push({
            documentId: existing.id,
            previousMaturity: 'candidate', // 简化
            newMaturity: 'validated',
            reason: 'Referenced by new execution',
          });
        } else {
          // 创建新条目
          const doc = await prisma.document.create({
            data: {
              projectId,
              companyId,
              type: entry.type || 'execution',
              title: entry.title || 'Extracted knowledge',
              content: entry.content || '',
              tags: entry.tags || [],
              status: 'active',
            },
          });
          results.push({
            documentId: doc.id,
            previousMaturity: 'draft',
            newMaturity: 'draft',
            reason: 'New knowledge extracted from execution',
          });
        }
      }
    } catch (error) {
      logger.error({ executionId, error: String(error) }, 'Micro evolution failed');
    }

    return results;
  }

  /**
   * 中观进化：项目级别知识整合
   * 合并相似文档，识别模式，提升成熟度
   */
  async mesoEvolution(projectId: string): Promise<EvolutionResult[]> {
    const results: EvolutionResult[] = [];

    // 获取项目的所有活跃文档
    const docs = await prisma.document.findMany({
      where: { projectId, status: 'active' },
      orderBy: { updatedAt: 'desc' },
    });

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
          const analysis = await modelGateway.promptJson(
            'agent_default',
            `分析以下同类型文档标题，识别共同模式和最佳实践。返回 JSON: {pattern: string, recommendation: string}

类型: ${type}
文档: ${titles}`,
          );

          if (analysis?.pattern) {
            logger.info({ projectId, type, pattern: analysis.pattern }, 'Pattern identified in meso evolution');
            // Gap 2: 写入结果
            const project = await prisma.project.findUnique({ where: { id: projectId }, select: { companyId: true } });
            if (project?.companyId) {
              const doc = await prisma.document.create({
                data: {
                  projectId, companyId: project.companyId,
                  type: type as any,
                  title: `[Pattern] ${analysis.pattern}`,
                  content: analysis.recommendation || `跨 ${typeDocs.length} 个文档的公共模式`,
                  status: 'active', version: 1,
                  tags: ['meso-evolution', type],
                },
              });
              results.push({ documentId: doc.id, previousMaturity: 'draft', newMaturity: 'candidate', reason: 'meso pattern identified' });
            }
          }
        } catch (error) {
          logger.error({ projectId, type, error: String(error) }, 'Meso evolution analysis failed');
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
    const projects = await prisma.project.findMany({
      where: { companyId },
      select: { id: true, title: true },
    });

    if (projects.length < 2) {
      return { insights: ['Need at least 2 projects for macro evolution'] };
    }

    // 统计各项目的知识分布
    const projectStats = await Promise.all(
      projects.map(async (p) => {
        const docs = await prisma.document.groupBy({
          by: ['type'],
          where: { projectId: p.id, status: 'active' },
          _count: true,
        });
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
              const sourceDoc = await prisma.document.findFirst({
                where: { projectId: sourceProject.project.id, type: missingType as any, status: 'active' },
                orderBy: { updatedAt: 'desc' },
              });
              if (sourceDoc) {
                await prisma.document.create({
                  data: {
                    projectId: ps.project.id,
                    companyId,
                    type: missingType as any,
                    title: `[Shared] ${sourceDoc.title}`,
                    content: `跨项目知识迁移，源自项目 ${sourceProject.project.title}:\n\n${sourceDoc.content?.slice(0, 2000) || ''}`,
                    status: 'active', version: 1,
                    tags: ['macro-evolution', 'cross-project', missingType],
                  },
                });
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
    while (true) {
      const docs = await prisma.document.findMany({
        where: { status: 'active' },
        select: { id: true, type: true, updatedAt: true },
        skip,
        take: BATCH_SIZE,
        orderBy: { updatedAt: 'asc' },
      });

      if (docs.length === 0) break;

      for (const doc of docs) {
        const daysSinceUpdate = (now.getTime() - doc.updatedAt.getTime()) / (1000 * 60 * 60 * 24);

        // 根据类型确定衰减天数
        const decayDays = doc.type === 'execution' ? 30 : doc.type === 'meeting' ? 60 : 90;

        if (daysSinceUpdate > decayDays) {
          await prisma.document.update({
            where: { id: doc.id },
            data: { status: 'archived', archivedAt: now },
          });
          results.push({
            documentId: doc.id,
            previousMaturity: 'validated',
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
    const [total, active, archived, byType] = await Promise.all([
      prisma.document.count({ where: { companyId } }),
      prisma.document.count({ where: { companyId, status: 'active' } }),
      prisma.document.count({ where: { companyId, status: 'archived' } }),
      prisma.document.groupBy({
        by: ['type'],
        where: { companyId, status: 'active' },
        _count: true,
      }),
    ]);

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
