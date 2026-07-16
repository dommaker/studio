/**
 * MCP Permission Service — role×tool access control + audit logging
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '@dommaker/studio-shared';

const prisma = new PrismaClient();

export class MCPPermissionService {
  // In-memory cache: `roleId:toolName` → allowed
  private cache = new Map<string, { allowed: boolean; expiresAt: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 min

  /**
   * Check if a role is allowed to call a tool
   * Default: denied (secure-by-default, only explicit grants allow)
   */
  async isAllowed(roleId: string | undefined, toolName: string): Promise<boolean> {
    if (!roleId) return false; // no role = no access

    const cacheKey = `${roleId}:${toolName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.allowed;
    }

    const perm = await (prisma as any).mCPPermission.findUnique({
      where: { roleId_toolName: { roleId, toolName } },
    });

    const allowed = perm ? perm.allowed : false; // default: denied
    this.cache.set(cacheKey, { allowed, expiresAt: Date.now() + this.CACHE_TTL });
    return allowed;
  }

  /**
   * Set permission for a role×tool
   */
  async setPermission(roleId: string, toolName: string, allowed: boolean): Promise<void> {
    await (prisma as any).mCPPermission.upsert({
      where: { roleId_toolName: { roleId, toolName } },
      create: { roleId, toolName, allowed },
      update: { allowed },
    });

    // Invalidate cache
    this.cache.delete(`${roleId}:${toolName}`);
    logger.info(`[MCP Permission] ${roleId} → ${toolName}: ${allowed ? 'allowed' : 'denied'}`);
  }

  /**
   * Get all permissions for a role
   */
  async getRolePermissions(roleId: string): Promise<Array<{ toolName: string; allowed: boolean }>> {
    const perms = await (prisma as any).mCPPermission.findMany({
      where: { roleId },
      select: { toolName: true, allowed: true },
    });
    return perms;
  }

  /**
   * Log a tool call to audit
   */
  async logAudit(params: {
    toolName: string;
    roleId?: string;
    input?: Record<string, any>;
    output?: any;
    duration: number;
    success: boolean;
    error?: string;
  }): Promise<void> {
    try {
      // Sanitize: remove potential secrets from input
      const sanitizedInput = params.input ? this.sanitizeInput(params.input) : undefined;
      const outputSummary = params.output ? this.summarizeOutput(params.output) : undefined;

      await (prisma as any).mCPAuditLog.create({
        data: {
          toolName: params.toolName,
          roleId: params.roleId,
          input: sanitizedInput as any,
          output: outputSummary as any,
          duration: params.duration,
          success: params.success,
          error: params.error,
        },
      });
    } catch (error) {
      logger.error('[MCP Audit] Failed to log', { error: String(error) });
    }
  }

  /**
   * Query audit logs
   */
  async queryAudit(params: {
    toolName?: string;
    roleId?: string;
    success?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ logs: any[]; total: number }> {
    const where: any = {};
    if (params.toolName) where.toolName = params.toolName;
    if (params.roleId) where.roleId = params.roleId;
    if (params.success !== undefined) where.success = params.success;

    const [logs, total] = await Promise.all([
      (prisma as any).mCPAuditLog.findMany({
        where,
        take: params.limit || 50,
        skip: params.offset || 0,
        orderBy: { createdAt: 'desc' },
      }),
      (prisma as any).mCPAuditLog.count({ where }),
    ]);

    return { logs, total };
  }

  /**
   * Cleanup audit logs older than N days
   */
  async cleanupAudit(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000);
    const result = await (prisma as any).mCPAuditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      logger.info(`[MCP Audit] Cleaned up ${result.count} old logs`);
    }
    return result.count;
  }

  private sanitizeInput(input: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    const secretKeys = ['password', 'secret', 'token', 'apiKey', 'api_key', 'authorization'];
    for (const [key, value] of Object.entries(input)) {
      if (secretKeys.some(s => key.toLowerCase().includes(s))) {
        sanitized[key] = '***';
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.slice(0, 500) + '...';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private summarizeOutput(output: any): any {
    const str = JSON.stringify(output);
    if (str.length > 1000) {
      return { _truncated: true, preview: str.slice(0, 1000) };
    }
    return output;
  }
}

export const mcpPermissionService = new MCPPermissionService();

/**
 * 种子默认权限：系统角色 + admin 默认允许所有工具
 */
export async function seedDefaultPermissions(toolNames: string[]): Promise<void> {
  const systemRoles = ['admin', 'analyst', 'executor', 'reviewer', 'auditor', 'monitor', 'deploy', 'triage'];
  let seeded = 0;

  for (const roleId of systemRoles) {
    for (const toolName of toolNames) {
      const existing = await (prisma as any).mCPPermission.findUnique({
        where: { roleId_toolName: { roleId, toolName } },
      });
      if (!existing) {
        await (prisma as any).mCPPermission.create({
          data: { roleId, toolName, allowed: true },
        });
        seeded++;
      }
    }
  }

  if (seeded > 0) {
    logger.info(`[MCP Permission] Seeded ${seeded} default permissions for ${systemRoles.length} roles`);
  }
}
