/**
 * MCP Admin Routes — tool management, permissions, audit
 */

import { Router } from 'express';
import { toolRegistry } from './tool-registry.js';
import { mcpPermissionService } from './permission.service.js';
import {
  mcpToolNameParamsSchema,
  mcpToolToggleBodySchema,
  mcpPermissionsQuerySchema,
  mcpPermissionSetBodySchema,
  mcpAuditQuerySchema,
} from '@dommaker/studio-contract';
import { defineRoute, HttpError } from '../../core/http.js';

const router = Router();

/**
 * GET /api/v1/mcp/admin/tools
 * List all tools with status and stats
 */
router.get('/tools', defineRoute({}, async () => {
  const tools = toolRegistry.list(true); // include disabled
  const stats = toolRegistry.getStats();

  const data = tools.map(t => ({
    name: t.name,
    description: t.description,
    category: t.category,
    version: t.version,
    enabled: t.enabled,
    requiredPermissions: t.requiredPermissions,
    stats: stats[t.name] || null,
  }));

  return { tools: data, total: data.length };
}));

/**
 * PATCH /api/v1/mcp/admin/tools/:name
 * Enable/disable a tool
 */
router.patch('/tools/:name', defineRoute(
  { params: mcpToolNameParamsSchema, body: mcpToolToggleBodySchema },
  async (_req, _res, { params, body }) => {
    const success = toolRegistry.setEnabled(params.name, body.enabled);
    if (!success) {
      throw new HttpError(404, 'NOT_FOUND', `Tool not found: ${params.name}`);
    }
    return { name: params.name, enabled: body.enabled };
  },
));

/**
 * GET /api/v1/mcp/admin/stats
 * Aggregate call stats
 */
router.get('/stats', defineRoute({}, async () => {
  const stats = toolRegistry.getStats();
  const tools = toolRegistry.list(true);

  let totalCalls = 0;
  let totalSuccess = 0;

  for (const s of Object.values(stats)) {
    totalCalls += s.totalCalls;
    totalSuccess += s.successCalls;
  }

  return {
    totalTools: tools.length,
    enabledTools: tools.filter(t => t.enabled).length,
    totalCalls,
    successRate: totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) : 0,
    byTool: stats,
  };
}));

/**
 * GET /api/v1/mcp/admin/permissions
 * Query permissions for a role
 */
router.get('/permissions', defineRoute(
  { query: mcpPermissionsQuerySchema },
  async (_req, _res, { query }) => {
    const permissions = await mcpPermissionService.getRolePermissions(query.roleId);
    return { roleId: query.roleId, permissions };
  },
));

/**
 * PUT /api/v1/mcp/admin/permissions
 * Set permission for role×tool
 */
router.put('/permissions', defineRoute(
  { body: mcpPermissionSetBodySchema },
  async (_req, _res, { body }) => {
    await mcpPermissionService.setPermission(body.roleId, body.toolName, body.allowed);
    return { roleId: body.roleId, toolName: body.toolName, allowed: body.allowed };
  },
));

/**
 * GET /api/v1/mcp/admin/audit
 * Query audit logs
 */
router.get('/audit', defineRoute(
  { query: mcpAuditQuerySchema },
  async (_req, _res, { query }) => {
    const result = await mcpPermissionService.queryAudit({
      toolName: query.toolName,
      roleId: query.roleId,
      success: query.success !== undefined ? query.success === 'true' : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
    return result;
  },
));

export default router;
