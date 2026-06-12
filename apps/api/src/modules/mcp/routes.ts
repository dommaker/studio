/**
 * MCP HTTP Routes
 *
 * FL-026: Added health check, admin routes integration.
 *
 * POST /api/v1/mcp          — JSON-RPC 请求（完整 MCP 协议）
 * GET  /api/v1/mcp/sse      — SSE transport endpoint
 * POST /api/v1/mcp/messages — SSE message endpoint
 * GET  /api/v1/mcp/tools    — 列出所有可用 tools
 * POST /api/v1/mcp/tools/:name — 直接调用 tool（简化接口）
 * GET  /api/v1/mcp/health   — 健康检查
 */

import { Router, Request, Response } from 'express';
import { mcpServer } from './server.js';
import { getToolSchemas, executeTool } from './tools.js';
import { toolRegistry } from './tool-registry.js';
import { logger } from '@dommaker/studio-shared';
import adminRoutes from './admin.routes.js';

const router = Router();

// ─── SSE Transport ───

const sseClients = new Map<string, Response>();

/**
 * GET /api/v1/mcp/sse
 * SSE transport endpoint — Claude CLI connects here
 */
router.get('/sse', (req: Request, res: Response) => {
  const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send endpoint event with the message URL
  const messageUrl = `/api/v1/mcp/messages?clientId=${clientId}`;
  res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);

  sseClients.set(clientId, res);
  logger.info('[MCP SSE] Client connected', { clientId });

  req.on('close', () => {
    sseClients.delete(clientId);
    logger.info('[MCP SSE] Client disconnected', { clientId });
  });
});

/**
 * POST /api/v1/mcp/messages
 * SSE message endpoint — Claude CLI sends requests here
 */
router.post('/messages', async (req: Request, res: Response) => {
  const clientId = req.query.clientId as string;
  const client = clientId ? sseClients.get(clientId) : null;

  try {
    const response = await mcpServer.handleRequest(req.body);

    // Send response via SSE if client connected
    if (client) {
      client.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }

    // Also return in HTTP response
    res.json(response);
  } catch (error) {
    logger.error('MCP SSE message failed', { error: String(error) });
    const errorResponse = {
      jsonrpc: '2.0',
      id: req.body?.id || 0,
      error: { code: -32603, message: String(error) },
    };

    if (client) {
      client.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
    }

    res.status(500).json(errorResponse);
  }
});

/**
 * POST /api/v1/mcp
 * JSON-RPC 2.0 端点（完整 MCP 协议）
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const response = await mcpServer.handleRequest(req.body);
    res.json(response);
  } catch (error) {
    logger.error('MCP request failed', { error: String(error) });
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id || 0,
      error: { code: -32603, message: String(error) },
    });
  }
});

/**
 * GET /api/v1/mcp/tools
 * 列出所有可用 tools（简化接口）
 */
router.get('/tools', async (_req: Request, res: Response) => {
  try {
    const tools = getToolSchemas();
    res.json({ tools, total: tools.length });
  } catch (error) {
    logger.error('Failed to list MCP tools', { error: String(error) });
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

/**
 * POST /api/v1/mcp/tools/:name
 * 直接调用 tool（简化接口，不需要 JSON-RPC 封装）
 */
router.post('/tools/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const roleId = req.body?.roleId || req.headers['x-role-id'] as string;
    const result = await executeTool(name, req.body, roleId);

    if (!result.success) {
      return res.status(400).json({
        error: (result as any).error,
        duration: result.duration,
      });
    }

    return res.json({
      result: result.result,
      duration: result.duration,
    });
  } catch (error) {
    logger.error('MCP tool call failed', { error: String(error) });
    return res.status(500).json({ error: String(error) });
  }
});

/**
 * GET /api/v1/mcp/health
 * Health check — returns tool availability status
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const health = toolRegistry.getHealth();
    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error('MCP health check failed', { error: String(error) });
    res.status(500).json({ status: 'unhealthy', error: String(error) });
  }
});

// Admin routes (requireAuth middleware applied in route-registry)
router.use('/admin', adminRoutes);

export default router;
