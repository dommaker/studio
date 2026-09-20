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

import { FileStore, logger, generateId } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

// ========== 常量 ==========

const AUDIT_JSONL_PATH = studioPath('logs', 'audit.jsonl');

// ========== 类型定义 ==========

/** JSONL 行类型（替换 Prisma AuditLog 类型） */
interface AuditLogRow {
  id: string;
  userId?: string;
  roleId?: string;
  companyId?: string;
  ipAddress?: string;
  userAgent?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: string | null;
  changes?: string | null;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  sessionId?: string;
  requestId?: string;
  /** 决策主体类型（#591）：存量行无此字段，读取侧按 'human' 归一 */
  actorType?: 'human' | 'agent';
  createdAt: string; // ISO 8601
}

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

  /** 决策主体类型（#591）：agent 自主决策埋点置 'agent'；人的操作缺省不写 */
  actorType?: 'human' | 'agent';
}

export interface AuditLogQuery {
  userId?: string;
  roleId?: string;
  companyId?: string;
  action?: string;
  resource?: string;
  resourceId?: string;
  status?: string;
  anonymousId?: string;  // SEC-009
  /** #591：'agent' 精确匹配；'human' 匹配存量无字段行 + 显式 human 行 */
  actorType?: 'human' | 'agent';
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
  // #591 agent 决策词表（增删走治理变更流程，见 audit-logs/CONTEXT.md）
  CLAIM: 'claim',
  TRANSITION: 'transition',
  DISPATCH: 'dispatch',
  AUTO_APPLY: 'auto_apply',
  PROPOSE: 'propose',
} as const;

// ========== 常用资源类型 ==========

export const AuditResources = {
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
  // #591 决策对象
  WORKUNIT: 'workunit',
  CHANNEL: 'channel',
  TRIGGER: 'trigger',
} as const;

// ========== 工具函数 ==========

function generateAuditId(): string {
  return generateId('audit');
}

function buildRow(input: AuditLogInput): AuditLogRow {
  return {
    id: generateAuditId(),
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
    actorType: input.actorType,
    createdAt: new Date().toISOString(),
  };
}

// ========== 审计服务 ==========

export class AuditService {
  constructor(private fileStore: FileStore) {}

  /**
   * 记录审计日志
   */
  async log(input: AuditLogInput): Promise<void> {
    try {
      const entry = buildRow(input);
      await this.fileStore.appendJsonl(AUDIT_JSONL_PATH, entry);
      logger.info(`Audit log created: ${entry.id}`, { action: input.action, resource: input.resource });
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
      for (const input of inputs) {
        const entry = buildRow(input);
        await this.fileStore.appendJsonl(AUDIT_JSONL_PATH, entry);
      }
      logger.info(`Batch audit logs created: ${inputs.length}`);
      return inputs.length;
    } catch (error) {
      logger.error('Failed to create batch audit logs', { count: inputs.length });
      throw error;
    }
  }

  /**
   * 查询审计日志
   */
  async query(query: AuditLogQuery): Promise<{
    data: AuditLogRow[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;

    const rows = await this.fileStore.readJsonl<AuditLogRow>(AUDIT_JSONL_PATH);

    let filtered = rows;

    if (query.userId) filtered = filtered.filter(r => r.userId === query.userId);
    if (query.roleId) filtered = filtered.filter(r => r.roleId === query.roleId);
    if (query.companyId) filtered = filtered.filter(r => r.companyId === query.companyId);
    if (query.action) filtered = filtered.filter(r => r.action === query.action);
    if (query.resource) filtered = filtered.filter(r => r.resource === query.resource);
    if (query.resourceId) filtered = filtered.filter(r => r.resourceId === query.resourceId);
    if (query.status) filtered = filtered.filter(r => r.status === query.status);

    // SEC-009: 按 anonymousId 搜索（details 存储为 JSON string）
    if (query.anonymousId) {
      filtered = filtered.filter(r => JSON.stringify(r.details).includes(query.anonymousId!));
    }

    // #591: actorType 过滤——'human' 归一匹配存量无字段行
    if (query.actorType) {
      filtered = filtered.filter(r =>
        query.actorType === 'human' ? (r.actorType ?? 'human') === 'human' : r.actorType === 'agent');
    }

    if (query.startTime || query.endTime) {
      filtered = filtered.filter(r => {
        const t = new Date(r.createdAt).getTime();
        if (query.startTime && t < query.startTime.getTime()) return false;
        if (query.endTime && t > query.endTime.getTime()) return false;
        return true;
      });
    }

    // 按 createdAt 降序
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = filtered.length;
    const data = filtered.slice(skip, skip + limit);

    return { data, total, page, limit };
  }

  /**
   * 获取单条审计日志
   */
  async getById(id: string): Promise<AuditLogRow | null> {
    const rows = await this.fileStore.readJsonl<AuditLogRow>(AUDIT_JSONL_PATH);
    return rows.find(r => r.id === id) || null;
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
    const rows = await this.fileStore.readJsonl<AuditLogRow>(AUDIT_JSONL_PATH);

    let filtered = rows;

    if (query.startTime || query.endTime) {
      filtered = filtered.filter(r => {
        const t = new Date(r.createdAt).getTime();
        if (query.startTime && t < query.startTime.getTime()) return false;
        if (query.endTime && t > query.endTime.getTime()) return false;
        return true;
      });
    }
    if (query.userId) filtered = filtered.filter(r => r.userId === query.userId);
    if (query.companyId) filtered = filtered.filter(r => r.companyId === query.companyId);

    const totalLogs = filtered.length;
    const successCount = filtered.filter(r => r.status === 'success').length;
    const failureCount = filtered.filter(r => r.status === 'failure').length;

    // Top 操作类型
    const actionCount = new Map<string, number>();
    for (const r of filtered) {
      actionCount.set(r.action, (actionCount.get(r.action) || 0) + 1);
    }
    const topActions = [...actionCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }));

    // Top 资源类型
    const resourceCount = new Map<string, number>();
    for (const r of filtered) {
      resourceCount.set(r.resource, (resourceCount.get(r.resource) || 0) + 1);
    }
    const topResources = [...resourceCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([resource, count]) => ({ resource, count }));

    // Top 用户
    const userCount = new Map<string, number>();
    for (const r of filtered) {
      if (r.userId) {
        userCount.set(r.userId, (userCount.get(r.userId) || 0) + 1);
      }
    }
    const topUsers = [...userCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userId, count]) => ({ userId, count }));

    // 每日统计（最近 30 天）
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoTime = thirtyDaysAgo.getTime();

    const dayCount = new Map<string, number>();
    for (const r of filtered) {
      const t = new Date(r.createdAt).getTime();
      if (t >= thirtyDaysAgoTime) {
        const date = r.createdAt.split('T')[0];
        dayCount.set(date, (dayCount.get(date) || 0) + 1);
      }
    }
    const dailyStats = [...dayCount.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, count]) => ({ date, count }));

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
   * 导出审计日志
   */
  async export(query: AuditLogQuery): Promise<AuditLogRow[]> {
    const { data } = await this.query({ ...query, limit: 10000 });
    return data;
  }
}
