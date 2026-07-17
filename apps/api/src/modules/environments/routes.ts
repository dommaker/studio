// environments/routes.ts — Environment Manager CRUD (HZ-023)
import { Router, Request, Response } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../../utils/logger.js';

const router = Router();

const ENVIRONMENTS_JSON = path.join(os.homedir(), '.studio', 'environments.json');
const fileStore = new FileStore();

async function readEnvironments(): Promise<any[]> {
  const data = await fileStore.readJson<any[]>(ENVIRONMENTS_JSON);
  return data || [];
}

async function writeEnvironments(envs: any[]): Promise<void> {
  await fileStore.writeJson(ENVIRONMENTS_JSON, envs);
}

// GET /api/v1/environments — 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const environments = await readEnvironments();
    const filtered = status ? environments.filter(e => e.status === status) : environments;

    res.json({ data: filtered, total: filtered.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list environments');
    res.status(500).json({ error: 'Failed to list environments' });
  }
});

// GET /api/v1/environments/:id — 详情
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const environments = await readEnvironments();
    const env = environments.find(e => e.id === req.params.id);
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

    const environments = await readEnvironments();
    const existing = environments.find(e => e.name === name);
    if (existing) {
      return res.status(409).json({ error: `Environment "${name}" already exists` });
    }

    const now = new Date().toISOString();
    const env = {
      id: `env_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name,
      description: description || null,
      dockerImage: dockerImage || 'node:20-slim',
      dependencies: dependencies || [],
      envVars: envVars || {},
      networkMode: networkMode || 'bridge',
      mounts: mounts || [],
      resourceLimits: resourceLimits || {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    environments.push(env);
    await writeEnvironments(environments);

    logger.info({ envId: env.id, name }, 'Environment created');
    res.status(201).json(env);
  } catch (error) {
    logger.error({ error }, 'Failed to create environment');
    res.status(500).json({ error: 'Failed to create environment' });
  }
});

// PATCH /api/v1/environments/:id — 更新
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, dockerImage, dependencies, envVars, networkMode, mounts, resourceLimits, status } = req.body;

    const environments = await readEnvironments();
    const idx = environments.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Environment not found' });

    const updated = {
      ...environments[idx],
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(dockerImage !== undefined && { dockerImage }),
      ...(dependencies !== undefined && { dependencies }),
      ...(envVars !== undefined && { envVars }),
      ...(networkMode !== undefined && { networkMode }),
      ...(mounts !== undefined && { mounts }),
      ...(resourceLimits !== undefined && { resourceLimits }),
      ...(status !== undefined && { status }),
      updatedAt: new Date().toISOString(),
    };

    environments[idx] = updated;
    await writeEnvironments(environments);

    logger.info({ envId: updated.id }, 'Environment updated');
    res.json(updated);
  } catch (error) {
    logger.error({ error }, 'Failed to update environment');
    res.status(500).json({ error: 'Failed to update environment' });
  }
});

// DELETE /api/v1/environments/:id — 删除
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const environments = await readEnvironments();
    const idx = environments.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Environment not found' });

    environments.splice(idx, 1);
    await writeEnvironments(environments);

    logger.info({ envId: req.params.id }, 'Environment deleted');
    res.status(204).end();
  } catch (error) {
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

    const environments = await readEnvironments();
    const existingNames = new Set(environments.map(e => e.name));
    const created = [];

    for (const def of defaults) {
      if (!existingNames.has(def.name)) {
        const now = new Date().toISOString();
        created.push({
          id: `env_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          ...def,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (created.length > 0) {
      await writeEnvironments([...environments, ...created]);
    }

    logger.info({ count: created.length }, 'Default environments seeded');
    res.json({ created: created.length, environments: created });
  } catch (error) {
    logger.error({ error }, 'Failed to seed default environments');
    res.status(500).json({ error: 'Failed to seed defaults' });
  }
});

export default router;
