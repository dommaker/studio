/**
 * Audit Service - 审计日志服务 (AR-012)
 * 
 * 负责记录和查询审计日志
 * 
 * 核心功能：
 * - 记录操作日志（谁在什么时候做了什么）
 * - 查询审计日志（支持多种过滤条件）
 * - 统计分析（操作频率、错误率等）
 */

import { AuditLog, Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

// ========== 类型定义 ==========

export interface AuditLogInput {
  // 谁
  userId?: string;
  roleId?: string;
  companyId?: string;
  ipAddress?: string;
  userAgent?: string;
  
  // 做了什么
  action: string;
  resource: string;
  resourceId?: string;
  
  // 详情
  details?: Record<string, any>;
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
    fields?: string[];
  };
  
  // 结果
  status?: 'success' | 'partial' | 'failure';
  errorCode?: string;
  errorMessage?: string;
  
  // 上下文
  sessionId?: string;
  requestId?: string;
}

export interface AuditLogQuery {
  userId?: string;
  roleId?: string;
  companyId?: string;
  action?: string;
  resource?: string;
  resourceId?: string;
  status?: string;
  anonymousId?: string;  // 🆕 SEC-009
  startTime?: Date;
  endTime?: Date;
  page?: number;
  limit?: number;
}

export interface AuditLogStats {
  totalLogs: number;
  successCount: number;
  failureCount: number;
  topActions: Array<{ action: string; count: number }>;
  topResources: Array<{ resource: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  dailyStats: Array<{ date: string; count: number }>;
}

// ========== 常用操作类型 ==========

export const AuditActions = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  EXECUTE: 'execute',
  LOGIN: 'login',
  LOGOUT: 'logout',
  PURCHASE: 'purchase',
  RATE: 'rate',
  PUBLISH: 'publish',
  APPROVE: 'approve',
  REJECT: 'reject',
  EXPORT: 'export',
  IMPORT: 'import',
} as const;

// ========== 常用资源类型 ==========

export const AuditResources = {
  WORKFLOW: 'workflow',
  STEP: 'step',
  TOOL: 'tool',
  ROLE: 'role',
  TASK: 'task',
  CAPABILITY: 'capability',
  COMPANY: 'company',
  USER: 'user',
  DOCUMENT: 'document',
  ASSESSMENT: 'assessment',
  ISSUE: 'issue',
  AUDIT_LOG: 'audit_log',
} as const;

// ========== 审计服务 ==========

export class AuditService {
  constructor(private prisma: ExtendedPrismaClient) {}

  /**
   * 记录审计日志
   */
  async log(input: AuditLogInput): Promise<AuditLog> {
    try {
      const log = await this.prisma.auditLog.create({
        data: {
          userId: input.userId,
          roleId: input.roleId,
          companyId: input.companyId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          action: input.action,
          resource: input.resource,
          resourceId: input.resourceId,
          details: input.details ? JSON.stringify(input.details) : null,
          changes: input.changes ? JSON.stringify(input.changes) : null,
          status: input.status || 'success',
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          sessionId: input.sessionId,
          requestId: input.requestId,
        },
      });

      logger.info(`Audit log created: ${log.id}`, { action: input.action, resource: input.resource });
      return log;
    } catch (error) {
      logger.error('Failed to create audit log', { error });
      throw error;
    }
  }

  /**
   * 批量记录审计日志
   */
  async logBatch(inputs: AuditLogInput[]): Promise<number> {
    try {
      const result = await this.prisma.auditLog.createMany({
        data: inputs.map(input => ({
          userId: input.userId,
          roleId: input.roleId,
          companyId: input.companyId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          action: input.action,
          resource: input.resource,
          resourceId: input.resourceId,
          details: input.details ? JSON.stringify(input.details) : null,
          changes: input.changes ? JSON.stringify(input.changes) : null,
          status: input.status || 'success',
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          sessionId: input.sessionId,
          requestId: input.requestId,
        })),
      });

      return result.count;
    } catch (error) {
      logger.error('Failed to create batch audit logs', { count: inputs.length });
      throw error;
    }
  }

  /**
   * 查询审计日志
   */
  async query(query: AuditLogQuery): Promise<{
    data: AuditLog[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.userId) where.userId = query.userId;
    if (query.roleId) where.roleId = query.roleId;
    if (query.companyId) where.companyId = query.companyId;
    if (query.action) where.action = query.action;
    if (query.resource) where.resource = query.resource;
    if (query.resourceId) where.resourceId = query.resourceId;
    if (query.status) where.status = query.status;
    
    // SEC-009: 按 anonymousId 搜索（details 存储为 JSON string）
    if (query.anonymousId) {
      where.details = { contains: query.anonymousId };
    }

    if (query.startTime || query.endTime) {
      where.createdAt = {};
      if (query.startTime) where.createdAt.gte = query.startTime;
      if (query.endTime) where.createdAt.lte = query.endTime;
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * 获取单条审计日志
   */
  async getById(id: string): Promise<AuditLog | null> {
    return this.prisma.auditLog.findUnique({
      where: { id },
    });
  }

  /**
   * 获取审计日志统计
   */
  async getStats(query: {
    startTime?: Date;
    endTime?: Date;
    userId?: string;
    companyId?: string;
  } = {}): Promise<AuditLogStats> {
    const where: any = {};

    if (query.startTime || query.endTime) {
      where.createdAt = {};
      if (query.startTime) where.createdAt.gte = query.startTime;
      if (query.endTime) where.createdAt.lte = query.endTime;
    }
    if (query.userId) where.userId = query.userId;
    if (query.companyId) where.companyId = query.companyId;

    // 总数和成功/失败数
    const [totalLogs, successCount, failureCount] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.count({ where: { ...where, status: 'success' } }),
      this.prisma.auditLog.count({ where: { ...where, status: 'failure' } }),
    ]);

    // Top 操作类型
    const topActions = await this.prisma.auditLog.groupBy({
      by: ['action'],
      where,
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 10,
    }).then(results => results.map(r => ({ action: r.action, count: r._count.action })));

    // Top 资源类型
    const topResources = await this.prisma.auditLog.groupBy({
      by: ['resource'],
      where,
      _count: { resource: true },
      orderBy: { _count: { resource: 'desc' } },
      take: 10,
    }).then(results => results.map(r => ({ resource: r.resource, count: r._count.resource })));

    // Top 用户
    const topUsers = await this.prisma.auditLog.groupBy({
      by: ['userId'],
      where: { ...where, userId: { not: null } },
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 10,
    }).then(results => results.filter(r => r.userId).map(r => ({ userId: r.userId!, count: r._count.userId })));

    // 每日统计（最近 30 天）
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyLogs = await this.prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
      SELECT DATE("createdAt") as date, COUNT(*) as count
      FROM "AuditLog"
      WHERE "createdAt" >= ${thirtyDaysAgo}
        ${query.userId ? Prisma.sql`AND "userId" = ${query.userId}` : Prisma.empty}
        ${query.companyId ? Prisma.sql`AND "companyId" = ${query.companyId}` : Prisma.empty}
      GROUP BY DATE("createdAt")
      ORDER BY date DESC
    `;

    const dailyStats = dailyLogs
      .filter(row => row.date != null)
      .map(row => ({
        date: new Date(row.date).toISOString().split('T')[0],
        count: Number(row.count),
      }));

    return {
      totalLogs,
      successCount,
      failureCount,
      topActions,
      topResources,
      topUsers,
      dailyStats,
    };
  }

  /**
   * 清理过期日志
   */
  async cleanup(retentionDays: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });

    logger.info('Audit logs cleaned up', { deletedCount: result.count, retentionDays });
    return result.count;
  }

  /**
   * 导出审计日志
   */
  async export(query: AuditLogQuery): Promise<AuditLog[]> {
    const { data } = await this.query({ ...query, limit: 10000 });
    return data;
  }
}