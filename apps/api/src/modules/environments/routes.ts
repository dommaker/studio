// environments/routes.ts — Environment Manager CRUD (HZ-023)
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// GET /api/v1/environments — 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where = status ? { status } : {};

    const environments = await prisma.environment.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    res.json({ data: environments, total: environments.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list environments');
    res.status(500).json({ error: 'Failed to list environments' });
  }
});

// GET /api/v1/environments/:id — 详情
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const env = await prisma.environment.findUnique({ where: { id: req.params.id } });
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    res.json(env);
  } catch (error) {
    logger.error({ error }, 'Failed to get environment');
    res.status(500).json({ error: 'Failed to get environment' });
  }
});

// POST /api/v1/environments — 创建
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, dockerImage, dependencies, envVars, networkMode, mounts, resourceLimits } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    const env = await prisma.environment.create({
      data: {
        name,
        description,
        dockerImage: dockerImage || 'node:20-slim',
        dependencies: dependencies || [],
        envVars: envVars || {},
        networkMode: networkMode || 'bridge',
        mounts: mounts || [],
        resourceLimits: resourceLimits || {},
      },
    });

    logger.info({ envId: env.id, name }, 'Environment created');
    res.status(201).json(env);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: `Environment "${req.body.name}" already exists` });
    }
    logger.error({ error }, 'Failed to create environment');
    res.status(500).json({ error: 'Failed to create environment' });
  }
});

// PATCH /api/v1/environments/:id — 更新
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, dockerImage, dependencies, envVars, networkMode, mounts, resourceLimits, status } = req.body;

    const env = await prisma.environment.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(dockerImage !== undefined && { dockerImage }),
        ...(dependencies !== undefined && { dependencies }),
        ...(envVars !== undefined && { envVars }),
        ...(networkMode !== undefined && { networkMode }),
        ...(mounts !== undefined && { mounts }),
        ...(resourceLimits !== undefined && { resourceLimits }),
        ...(status !== undefined && { status }),
      },
    });

    logger.info({ envId: env.id }, 'Environment updated');
    res.json(env);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'Environment not found' });
    }
    logger.error({ error }, 'Failed to update environment');
    res.status(500).json({ error: 'Failed to update environment' });
  }
});

// DELETE /api/v1/environments/:id — 删除
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.environment.delete({ where: { id: req.params.id } });
    logger.info({ envId: req.params.id }, 'Environment deleted');
    res.status(204).end();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'Environment not found' });
    }
    logger.error({ error }, 'Failed to delete environment');
    res.status(500).json({ error: 'Failed to delete environment' });
  }
});

// POST /api/v1/environments/seed-defaults — 创建默认环境
router.post('/seed-defaults', async (_req: Request, res: Response) => {
  try {
    const defaults = [
      {
        name: 'node-default',
        description: 'Node.js 20 默认环境',
        dockerImage: 'node:20-slim',
        dependencies: [],
        envVars: { NODE_ENV: 'production' },
        networkMode: 'bridge',
        mounts: [],
        resourceLimits: { memoryMb: 512, cpuPercent: 50 },
      },
      {
        name: 'python-default',
        description: 'Python 3.12 默认环境',
        dockerImage: 'python:3.12-slim',
        dependencies: [],
        envVars: { PYTHONUNBUFFERED: '1' },
        networkMode: 'bridge',
        mounts: [],
        resourceLimits: { memoryMb: 512, cpuPercent: 50 },
      },
    ];

    const created = [];
    for (const def of defaults) {
      const existing = await prisma.environment.findUnique({ where: { name: def.name } });
      if (!existing) {
        const env = await prisma.environment.create({ data: def as any });
        created.push(env);
      }
    }

    logger.info({ count: created.length }, 'Default environments seeded');
    res.json({ created: created.length, environments: created });
  } catch (error) {
    logger.error({ error }, 'Failed to seed default environments');
    res.status(500).json({ error: 'Failed to seed defaults' });
  }
});

export default router;
