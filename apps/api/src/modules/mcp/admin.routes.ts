/**
 * MCP Admin Routes — tool management, permissions, audit
 */

import { Router, Request, Response } from 'express';
import { toolRegistry } from './tool-registry.js';
import { mcpPermissionService } from './permission.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

/**
 * GET /api/v1/mcp/admin/tools
 * List all tools with status and stats
 */
router.get('/tools', async (_req: Request, res: Response) => {
  try {
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

    res.json({ data, total: data.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list MCP tools');
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

/**
 * PATCH /api/v1/mcp/admin/tools/:name
 * Enable/disable a tool
 */
router.patch('/tools/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const success = toolRegistry.setEnabled(name, enabled);
    if (!success) {
      return res.status(404).json({ error: `Tool not found: ${name}` });
    }

    res.json({ name, enabled });
  } catch (error) {
    logger.error({ error }, 'Failed to update tool');
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

/**
 * GET /api/v1/mcp/admin/stats
 * Aggregate call stats
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = toolRegistry.getStats();
    const tools = toolRegistry.list(true);

    let totalCalls = 0;
    let totalSuccess = 0;
    let totalError = 0;

    for (const s of Object.values(stats)) {
      totalCalls += s.totalCalls;
      totalSuccess += s.successCalls;
      totalError += s.errorCalls;
    }

    res.json({
      totalTools: tools.length,
      enabledTools: tools.filter(t => t.enabled).length,
      totalCalls,
      successRate: totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) : 0,
      byTool: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get MCP stats');
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/v1/mcp/admin/permissions
 * Query permissions for a role
 */
router.get('/permissions', async (req: Request, res: Response) => {
  try {
    const { roleId } = req.query;
    if (!roleId) {
      return res.status(400).json({ error: 'roleId is required' });
    }

    const permissions = await mcpPermissionService.getRolePermissions(roleId as string);
    res.json({ roleId, permissions });
  } catch (error) {
    logger.error({ error }, 'Failed to get permissions');
    res.status(500).json({ error: 'Failed to get permissions' });
  }
});

/**
 * PUT /api/v1/mcp/admin/permissions
 * Set permission for role×tool
 */
router.put('/permissions', async (req: Request, res: Response) => {
  try {
    const { roleId, toolName, allowed } = req.body;

    if (!roleId || !toolName || typeof allowed !== 'boolean') {
      return res.status(400).json({ error: 'roleId, toolName, and allowed (boolean) are required' });
    }

    await mcpPermissionService.setPermission(roleId, toolName, allowed);
    res.json({ roleId, toolName, allowed });
  } catch (error) {
    logger.error({ error }, 'Failed to set permission');
    res.status(500).json({ error: 'Failed to set permission' });
  }
});

/**
 * GET /api/v1/mcp/admin/audit
 * Query audit logs
 */
router.get('/audit', async (req: Request, res: Response) => {
  try {
    const { toolName, roleId, success, limit, offset } = req.query;

    const result = await mcpPermissionService.queryAudit({
      toolName: toolName as string,
      roleId: roleId as string,
      success: success !== undefined ? success === 'true' : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to query audit logs');
    res.status(500).json({ error: 'Failed to query audit logs' });
  }
});

export default router;
