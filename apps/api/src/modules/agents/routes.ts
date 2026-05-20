// Agent API 路由
import { Router, Request, Response } from 'express';
import { AgentRegistry } from '@dommaker/studio-agent';
import { prisma } from '../../core/database.js';
import { requireNotGuest, requireRole } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002
import { eventStore } from '../../core/event-store.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

// 延迟初始化：首次请求时创建 AgentRegistry 实例
let registry: InstanceType<typeof AgentRegistry>;

async function initRegistry() {
  if (!registry) {
    registry = new AgentRegistry(prisma, eventStore);
  }
  return registry;
}

// 获取 Agent 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { category, tags, page = 1, limit = 20 } = req.query;

    const result = await reg.list({
      category: category as string,
      tags: tags ? (tags as string).split(',') : undefined,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });

    res.json({
      data: result.data,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: result.total,
        totalPages: Math.ceil(result.total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    logger.error('Failed to list agents', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list agents' },
    });
  }
});

// 注册新 Agent
router.post('/', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const metadata = await reg.register(req.body);

    res.status(201).json(metadata);
  } catch (error: any) {
    logger.error('Failed to register agent', { error: String(error) });
    if (error.message?.includes('already exists')) {
      res.status(409).json({
        error: { code: 'AGENT_EXISTS', message: error.message },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to register agent' },
      });
    }
  }
});

// 获取 Agent 详情
router.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { agentId } = req.params;
    const { version } = req.query;

    const agent = await reg.get(agentId, version as string);

    if (!agent) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Agent ${agentId} not found` },
      });
    }

    res.json(agent);
  } catch (error) {
    logger.error('Failed to get agent', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get agent' },
    });
  }
});

// 更新 Agent
router.put('/:agentId', async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { agentId } = req.params;
    const { version } = req.query;

    if (!version) {
      return res.status(400).json({
        error: { code: 'VERSION_REQUIRED', message: 'Version is required' },
      });
    }

    const agent = await reg.update(agentId, version as string, req.body);
    res.json(agent);
  } catch (error: any) {
    logger.error('Failed to update agent', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update agent' },
    });
  }
});

// 删除 Agent
// 🆕 SEC-002: Admin only
router.delete('/:agentId', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const reg = await initRegistry();
    const { agentId } = req.params;
    const { version } = req.query;

    if (!version) {
      return res.status(400).json({
        error: { code: 'VERSION_REQUIRED', message: 'Version is required' },
      });
    }

    await reg.delete(agentId, version as string);
    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete agent', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete agent' },
    });
  }
});

export default router;
