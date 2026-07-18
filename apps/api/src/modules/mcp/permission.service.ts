/**
 * MCP Permission Service — role×tool access control + audit logging (FileStore)
 */

import { randomUUID } from 'crypto';
import path from 'node:path';
import os from 'node:os';
import { FileStore, logger } from '@dommaker/studio-shared';

const fileStore = new FileStore();
const PERMS_PATH = path.join(os.homedir(), '.studio', 'mcp-permissions.json');
const AUDIT_PATH = path.join(os.homedir(), '.studio', 'mcp-audit-logs.jsonl');

interface MCPPermissionRecord {
  id: string;
  roleId: string;
  toolName: string;
  allowed: boolean;
}

interface MCPAuditLogRecord {
  id: string;
  toolName: string;
  roleId?: string;
  input?: Record<string, any>;
  output?: any;
  duration: number;
  success: boolean;
  error?: string;
  createdAt: string;
}

export class MCPPermissionService {
  // In-memory cache: `roleId:toolName` → allowed
  private cache = new Map<string, { allowed: boolean; expiresAt: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 min

  private async readPerms(): Promise<MCPPermissionRecord[]> {
    return (await fileStore.readJson<MCPPermissionRecord[]>(PERMS_PATH)) ?? [];
  }

  private async writePerms(perms: MCPPermissionRecord[]): Promise<void> {
    await fileStore.writeJson(PERMS_PATH, perms);
  }

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

    const perms = await this.readPerms();
    const perm = perms.find(p => p.roleId === roleId && p.toolName === toolName);

    const allowed = perm ? perm.allowed : false; // default: denied
    this.cache.set(cacheKey, { allowed, expiresAt: Date.now() + this.CACHE_TTL });
    return allowed;
  }

  /**
   * Set permission for a role×tool
   */
  async setPermission(roleId: string, toolName: string, allowed: boolean): Promise<void> {
    const perms = await this.readPerms();
    const idx = perms.findIndex(p => p.roleId === roleId && p.toolName === toolName);

    if (idx >= 0) {
      perms[idx].allowed = allowed;
    } else {
      perms.push({ id: randomUUID(), roleId, toolName, allowed });
    }

    await this.writePerms(perms);

    // Invalidate cache
    this.cache.delete(`${roleId}:${toolName}`);
    logger.info(`[MCP Permission] ${roleId} → ${toolName}: ${allowed ? 'allowed' : 'denied'}`);
  }

  /**
   * Get all permissions for a role
   */
  async getRolePermissions(roleId: string): Promise<Array<{ toolName: string; allowed: boolean }>> {
    const perms = await this.readPerms();
    return perms.filter(p => p.roleId === roleId).map(p => ({ toolName: p.toolName, allowed: p.allowed }));
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

      const log: MCPAuditLogRecord = {
        id: randomUUID(),
        toolName: params.toolName,
        roleId: params.roleId,
        input: sanitizedInput,
        output: outputSummary,
        duration: params.duration,
        success: params.success,
        error: params.error,
        createdAt: new Date().toISOString(),
      };
      await fileStore.appendJsonl(AUDIT_PATH, log);
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
    let logs = await fileStore.readJsonl<MCPAuditLogRecord>(AUDIT_PATH);

    if (params.toolName) logs = logs.filter(l => l.toolName === params.toolName);
    if (params.roleId) logs = logs.filter(l => l.roleId === params.roleId);
    if (params.success !== undefined) logs = logs.filter(l => l.success === params.success);

    // orderBy createdAt desc
    logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = logs.length;
    const offset = params.offset || 0;
    const limit = params.limit || 50;
    logs = logs.slice(offset, offset + limit);

    return { logs, total };
  }

  /**
   * Cleanup audit logs older than N days
   */
  async cleanupAudit(retentionDays = 30): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000);
    const all = await fileStore.readJsonl<MCPAuditLogRecord>(AUDIT_PATH);
    const filtered = all.filter(l => new Date(l.createdAt) >= cutoff);
    const removed = all.length - filtered.length;
    if (removed > 0) {
      await fileStore.writeJsonl(AUDIT_PATH, filtered);
      logger.info(`[MCP Audit] Cleaned up ${removed} old logs`);
    }
    return removed;
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

  const perms = await fileStore.readJson<MCPPermissionRecord[]>(PERMS_PATH) ?? [];

  for (const roleId of systemRoles) {
    for (const toolName of toolNames) {
      const existing = perms.find(p => p.roleId === roleId && p.toolName === toolName);
      if (!existing) {
        perms.push({ id: randomUUID(), roleId, toolName, allowed: true });
        seeded++;
      }
    }
  }

  if (seeded > 0) {
    await fileStore.writeJson(PERMS_PATH, perms);
    logger.info(`[MCP Permission] Seeded ${seeded} default permissions for ${systemRoles.length} roles`);
  }
}
