/**
 * MemoryService - 角色记忆管理
 *
 * 三层存储：
 * 1. 内存热缓存（getTopMemories 结果，TTL 5min）
 * 2. RoleMemoryEntry 表（SQLite，主要存储）
 * 3. Role.memory JSON 列（降级兼容，只读）
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, llmClient } from '@dommaker/studio-shared';
import type { RoleMemory, RoleMemoryEntry } from './role.types.js';

const DEFAULT_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// 内存热缓存
interface CacheEntry {
  data: RoleMemoryEntry[];
  expiresAt: number;
}
const memoryCache = new Map<string, CacheEntry>();

export class MemoryService {
  /**
   * 添加记忆条目
   */
  async addEntry(
    roleId: string,
    entry: Omit<RoleMemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt'> & { relatedTo?: string[] },
    options?: { relatedTo?: string[] }
  ): Promise<RoleMemoryEntry> {
    // 容量检查 + 淘汰
    const count = await prisma.roleMemoryEntry.count({ where: { roleId } });
    if (count >= DEFAULT_MAX_ENTRIES) {
      await this.evict(roleId, count - DEFAULT_MAX_ENTRIES + 1);
    }

    // 生成 embedding（非阻塞，失败不影响写入）
    const embedding = await this.generateEmbedding(entry.content);

    // 高重要性 experience/learning 自动提升为 global
    const scope = entry.scope || (
      entry.importance > 4 && ['experience', 'learning'].includes(entry.type)
        ? 'global'
        : 'project'
    );

    const created = await prisma.roleMemoryEntry.create({
      data: {
        roleId,
        type: entry.type,
        content: entry.content,
        taskId: entry.taskId,
        importance: entry.importance,
        scope,
        embedding: JSON.stringify(embedding),
      },
    });

    // 自动建立相似记忆关联
    if (embedding.length > 0) {
      await this.autoCreateRelations(roleId, created.id, embedding, options?.relatedTo);
    }

    this.invalidateCache(roleId);
    logger.info(`[Memory] Added entry to role ${roleId}`, { type: entry.type, importance: entry.importance, scope, hasEmbedding: embedding.length > 0 });

    return this.toMemoryEntry(created);
  }

  /**
   * 更新记忆条目
   */
  async updateEntry(
    roleId: string,
    entryId: string,
    updates: Partial<Pick<RoleMemoryEntry, 'content' | 'importance'>>
  ): Promise<RoleMemoryEntry | null> {
    const existing = await prisma.roleMemoryEntry.findFirst({
      where: { id: entryId, roleId },
    });
    if (!existing) return null;

    // 内容变化时重新生成 embedding
    let embedding: number[] | undefined;
    if (updates.content && updates.content !== existing.content) {
      embedding = await this.generateEmbedding(updates.content);
    }

    const updated = await prisma.roleMemoryEntry.update({
      where: { id: entryId },
      data: {
        ...updates,
        ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
        lastAccessedAt: new Date(),
      },
    });

    this.invalidateCache(roleId);
    return this.toMemoryEntry(updated);
  }

  /**
   * 删除记忆条目
   */
  async deleteEntry(roleId: string, entryId: string): Promise<boolean> {
    const result = await prisma.roleMemoryEntry.deleteMany({
      where: { id: entryId, roleId },
    });

    if (result.count === 0) return false;

    this.invalidateCache(roleId);
    return true;
  }

  /**
   * 按类型查询记忆
   */
  async getByType(roleId: string, type: RoleMemoryEntry['type']): Promise<RoleMemoryEntry[]> {
    const rows = await prisma.roleMemoryEntry.findMany({
      where: { roleId, type },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(r => this.toMemoryEntry(r));
  }

  /**
   * 搜索记忆（混合检索：关键词 + 向量相似度）
   */
  async search(roleId: string, query: string, limit = 10, scope?: 'project' | 'global'): Promise<RoleMemoryEntry[]> {
    const scopeFilter = scope ? { scope } : {};

    // 1. 关键词匹配
    const keywordRows = await prisma.roleMemoryEntry.findMany({
      where: { roleId, ...scopeFilter, content: { contains: query } },
      orderBy: { importance: 'desc' },
      take: limit,
    });

    // 2. 向量相似度检索（Decision #3: pgvector 原生 → JS 降级）
    const queryEmbedding = await this.generateEmbedding(query);
    let vectorResults: Array<{ id: string; score: number }> = [];

    if (queryEmbedding.length > 0) {
      vectorResults = await this.vectorSearch(roleId, queryEmbedding, scopeFilter, limit);
    }

    // 3. 合并结果
    const keywordIds = new Set(keywordRows.map(r => r.id));
    const vectorIds = vectorResults.filter(v => !keywordIds.has(v.id)).map(v => v.id);

    let vectorExtraRows: typeof keywordRows = [];
    if (vectorIds.length > 0) {
      vectorExtraRows = await prisma.roleMemoryEntry.findMany({ where: { id: { in: vectorIds } } });
    }

    const allRows = [...keywordRows, ...vectorExtraRows].slice(0, limit);

    // 更新 lastAccessedAt
    if (allRows.length > 0) {
      await prisma.roleMemoryEntry.updateMany({
        where: { id: { in: allRows.map(r => r.id) } },
        data: { lastAccessedAt: new Date() },
      });
    }

    return allRows.map(r => this.toMemoryEntry(r));
  }

  /**
   * 获取高重要性记忆（带内存缓存，TTL 5min）
   */
  async getTopMemories(roleId: string, limit = 10): Promise<RoleMemoryEntry[]> {
    // 尝试从内存缓存读取
    const cacheKey = `${roleId}:top`;
    const cached = memoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data.slice(0, limit);
    }

    // 从 DB 读取
    const rows = await prisma.roleMemoryEntry.findMany({
      where: { roleId },
      orderBy: [{ importance: 'desc' }, { lastAccessedAt: 'desc' }],
      take: limit,
    });

    const entries = rows.map(r => this.toMemoryEntry(r));

    // 写入缓存
    memoryCache.set(cacheKey, { data: entries, expiresAt: Date.now() + CACHE_TTL_MS });

    return entries;
  }

  /**
   * 格式化记忆为 prompt 文本（用于 agent 上下文注入）
   * global 记忆优先，附带关联上下文
   */
  async formatForPrompt(roleId: string, limit = 10): Promise<string> {
    // global 记忆优先注入
    const globalEntries = await prisma.roleMemoryEntry.findMany({
      where: { roleId, scope: 'global' },
      orderBy: [{ importance: 'desc' }, { lastAccessedAt: 'desc' }],
      take: limit,
    });

    const projectEntries = await prisma.roleMemoryEntry.findMany({
      where: { roleId, scope: 'project' },
      orderBy: [{ importance: 'desc' }, { lastAccessedAt: 'desc' }],
      take: limit,
    });

    // 合并：global 在前，project 在后
    const allRows = [...globalEntries, ...projectEntries].slice(0, limit);
    if (allRows.length === 0) return '';

    const entries = allRows.map(r => this.toMemoryEntry(r));

    const typeLabels: Record<string, string> = {
      experience: '经验',
      decision: '决策',
      feedback: '反馈',
      learning: '学习',
    };

    const lines: string[] = [];
    for (const e of entries) {
      let line = `[${typeLabels[e.type] || e.type}] ${e.content}`;
      if (e.scope === 'global') line = `[全局] ${line}`;

      // 附带关联上下文
      const related = await this.getRelatedMemories(e.id, 1);
      if (related.length > 0) {
        const relSummary = related.slice(0, 2).map(r => r.entry.content.slice(0, 50)).join('; ');
        line += ` (相关: ${relSummary})`;
      }

      lines.push(line);
    }

    return lines.join('\n');
  }

  /**
   * 获取角色记忆（兼容旧接口，从新表读取 + 降级到 JSON 列）
   */
  async getMemory(roleId: string): Promise<RoleMemory> {
    const rows = await prisma.roleMemoryEntry.findMany({
      where: { roleId },
      orderBy: [{ importance: 'desc' }, { lastAccessedAt: 'desc' }],
    });

    // 如果新表有数据，直接返回
    if (rows.length > 0) {
      return {
        entries: rows.map(r => this.toMemoryEntry(r)),
        lastUpdatedAt: rows[0].lastAccessedAt,
        maxEntries: DEFAULT_MAX_ENTRIES,
      };
    }

    // 降级：从 Role.memory JSON 列读取
    const role = await prisma.role.findUnique({
      where: { id: roleId },
      select: { memory: true },
    });

    if (role?.memory) {
      const legacy = role.memory as unknown as RoleMemory;
      if (legacy.entries?.length > 0) {
        // 迁移到新表
        await this.migrateFromJson(roleId, legacy);
        return legacy;
      }
    }

    return { entries: [], lastUpdatedAt: new Date(), maxEntries: DEFAULT_MAX_ENTRIES };
  }

  /**
   * 清空角色记忆
   */
  async clearMemory(roleId: string): Promise<void> {
    await prisma.roleMemoryEntry.deleteMany({ where: { roleId } });
    this.invalidateCache(roleId);
  }

  /**
   * 获取记忆统计
   */
  async getStats(roleId: string): Promise<{
    total: number;
    byType: Record<string, number>;
    avgImportance: number;
    capacity: number;
    usage: number;
  }> {
    const [count, typeGroups] = await Promise.all([
      prisma.roleMemoryEntry.count({ where: { roleId } }),
      prisma.roleMemoryEntry.groupBy({
        by: ['type'],
        where: { roleId },
        _count: true,
        _avg: { importance: true },
      }),
    ]);

    const byType: Record<string, number> = {};
    let totalImportance = 0;
    let totalCount = 0;

    for (const g of typeGroups) {
      byType[g.type] = g._count;
      if (g._avg.importance) {
        totalImportance += g._avg.importance * g._count;
        totalCount += g._count;
      }
    }

    return {
      total: count,
      byType,
      avgImportance: totalCount > 0 ? Math.round((totalImportance / totalCount) * 10) / 10 : 0,
      capacity: DEFAULT_MAX_ENTRIES,
      usage: Math.round((count / DEFAULT_MAX_ENTRIES) * 100),
    };
  }

  // ─── 内部方法 ───

  private toMemoryEntry(row: any): RoleMemoryEntry {
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      taskId: row.taskId || undefined,
      importance: row.importance,
      scope: row.scope || 'project',
      createdAt: row.createdAt,
      lastAccessedAt: row.lastAccessedAt,
    };
  }

  private async evict(roleId: string, count: number): Promise<void> {
    // 删除最不重要的 + 最久未访问的记录
    const toDelete = await prisma.roleMemoryEntry.findMany({
      where: { roleId },
      orderBy: [{ importance: 'asc' }, { lastAccessedAt: 'asc' }],
      take: count,
      select: { id: true },
    });

    if (toDelete.length > 0) {
      await prisma.roleMemoryEntry.deleteMany({
        where: { id: { in: toDelete.map(r => r.id) } },
      });
    }
  }

  private async migrateFromJson(roleId: string, memory: RoleMemory): Promise<void> {
    try {
      const entries = memory.entries.map(e => ({
        roleId,
        type: e.type,
        content: e.content,
        taskId: e.taskId,
        importance: e.importance,
        createdAt: new Date(e.createdAt),
        lastAccessedAt: new Date(e.lastAccessedAt),
      }));

      await prisma.roleMemoryEntry.createMany({ data: entries });
      logger.info(`[Memory] Migrated ${entries.length} entries from JSON to table for role ${roleId}`);
    } catch (err) {
      logger.error('[Memory] Failed to migrate from JSON', { err: String(err), roleId });
    }
  }

  // ─── 知识图谱 ───

  /**
   * 获取关联记忆（BFS 图谱遍历）
   */
  async getRelatedMemories(entryId: string, depth = 1): Promise<Array<{
    entry: RoleMemoryEntry;
    relationType: string;
    weight: number;
  }>> {
    const visited = new Set<string>([entryId]);
    const result: Array<{ entry: RoleMemoryEntry; relationType: string; weight: number }> = [];
    let currentIds = [entryId];

    for (let d = 0; d < depth; d++) {
      const relations = await prisma.memoryRelation.findMany({
        where: {
          OR: [
            { fromId: { in: currentIds } },
            { toId: { in: currentIds } },
          ],
        },
        include: { from: true, to: true },
      });

      const nextIds: string[] = [];
      for (const rel of relations) {
        const neighbor = rel.fromId === entryId || currentIds.includes(rel.fromId) ? rel.to : rel.from;
        if (!visited.has(neighbor.id)) {
          visited.add(neighbor.id);
          nextIds.push(neighbor.id);
          result.push({
            entry: this.toMemoryEntry(neighbor),
            relationType: rel.relationType,
            weight: rel.weight,
          });
        }
      }

      currentIds = nextIds;
      if (currentIds.length === 0) break;
    }

    return result;
  }

  /**
   * 手动创建记忆关联
   */
  async createRelation(fromId: string, toId: string, relationType: string, weight = 1.0): Promise<void> {
    await prisma.memoryRelation.create({
      data: { fromId, toId, relationType, weight },
    });
  }

  /**
   * 自动建立相似记忆关联
   */
  private async autoCreateRelations(
    roleId: string,
    newId: string,
    newEmbedding: number[],
    manualRelatedTo?: string[]
  ): Promise<void> {
    try {
      // 手动指定的关联
      if (manualRelatedTo?.length) {
        for (const toId of manualRelatedTo) {
          await prisma.memoryRelation.create({
            data: { fromId: newId, toId, relationType: 'related_to', weight: 1.0 },
          }).catch(() => {}); // ignore if target doesn't exist
        }
      }

      // 自动发现相似记忆（相似度 > 0.8）
      const existing = await prisma.roleMemoryEntry.findMany({
        where: { roleId, id: { not: newId }, embedding: { not: '[]' } },
        select: { id: true, embedding: true },
      });

      for (const e of existing) {
        const sim = this.cosineSimilarity(newEmbedding, JSON.parse(e.embedding) as number[]);
        if (sim > 0.8) {
          await prisma.memoryRelation.create({
            data: { fromId: newId, toId: e.id, relationType: 'related_to', weight: sim },
          }).catch(() => {}); // ignore duplicates
        }
      }
    } catch (err) {
      logger.debug('[Memory] Auto-create relations failed (non-blocking)', { err: String(err) });
    }
  }

  // ─── Embedding ───

  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      return await llmClient.embedding(text);
    } catch (err) {
      logger.debug('[Memory] Embedding generation failed (non-blocking)', { err: String(err) });
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** pgvector 原生向量检索，不可用时降级为 JS 余弦相似度 */
  private async vectorSearch(
    roleId: string,
    embedding: number[],
    scopeFilter: Record<string, string>,
    limit: number,
  ): Promise<Array<{ id: string; score: number }>> {
    // 尝试 pgvector 原生查询
    try {
      const vecStr = `[${embedding.join(',')}]`;
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; score: number }>>(
        `SELECT id, 1 - ("embeddingVec" <=> $1::vector) AS score
         FROM "RoleMemoryEntry"
         WHERE "roleId" = $2 AND "embeddingVec" IS NOT NULL
         ORDER BY "embeddingVec" <=> $1::vector
         LIMIT $3`,
        vecStr, roleId, limit,
      );
      if (rows.length > 0) return rows;
    } catch {
      // pgvector 不可用，降级为 JS 计算
    }

    // JS 降级：全量加载 + 余弦相似度
    const allEntries = await prisma.roleMemoryEntry.findMany({
      where: { roleId, ...scopeFilter, embedding: { not: '[]' } },
      select: { id: true, embedding: true },
    });
    return allEntries
      .map(e => ({ id: e.id, score: this.cosineSimilarity(embedding, JSON.parse(e.embedding) as unknown as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ─── 内存缓存 ───

  private invalidateCache(roleId: string): void {
    memoryCache.delete(`${roleId}:top`);
  }
}

export const memoryService = new MemoryService();
