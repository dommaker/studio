// agent-configs/routes.ts — Agent Manager + Version Control (HZ-024, HZ-025)
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/** Helper: create a version snapshot before updating */
async function createVersionSnapshot(configId: string, changedBy?: string, reason?: string) {
  const config = await prisma.agentConfig.findUnique({ where: { id: configId } });
  if (!config) return;

  const lastVersion = await prisma.agentConfigVersion.findFirst({
    where: { agentConfigId: configId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const snapshot = {
    name: config.name,
    description: config.description,
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    environmentId: config.environmentId,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    status: config.status,
  };

  await prisma.agentConfigVersion.create({
    data: {
      agentConfigId: configId,
      version: (lastVersion?.version ?? 0) + 1,
      snapshot: JSON.stringify(snapshot),
      changedBy: changedBy || 'system',
      changeReason: reason,
    },
  });
}

// GET /api/v1/agent-configs — 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const where = status ? { status } : {};

    const configs = await prisma.agentConfig.findMany({
      where,
      include: { environment: { select: { id: true, name: true, dockerImage: true } } },
      orderBy: { name: 'asc' },
    });

    res.json({ data: configs, total: configs.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list agent configs');
    res.status(500).json({ error: 'Failed to list agent configs' });
  }
});

// GET /api/v1/agent-configs/:id — 详情
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const config = await prisma.agentConfig.findUnique({
      where: { id: req.params.id },
      include: { environment: true },
    });
    if (!config) return res.status(404).json({ error: 'Agent config not found' });
    res.json(config);
  } catch (error) {
    logger.error({ error }, 'Failed to get agent config');
    res.status(500).json({ error: 'Failed to get agent config' });
  }
});

// POST /api/v1/agent-configs — 创建
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, model, systemPrompt, tools, environmentId, maxTokens, temperature } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });

    if (environmentId) {
      const env = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!env) return res.status(400).json({ error: 'Environment not found' });
    }

    const config = await prisma.agentConfig.create({
      data: {
        name,
        description,
        model: model || 'claude-sonnet-4-6',
        systemPrompt: systemPrompt || '',
        tools: tools || [],
        environmentId: environmentId || null,
        maxTokens: maxTokens || 4096,
        temperature: temperature ?? 0.7,
      },
      include: { environment: { select: { id: true, name: true } } },
    });

    // Create initial version
    await createVersionSnapshot(config.id, 'system', 'Initial creation');

    logger.info({ configId: config.id, name }, 'Agent config created');
    res.status(201).json(config);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: `Agent config "${req.body.name}" already exists` });
    }
    logger.error({ error }, 'Failed to create agent config');
    res.status(500).json({ error: 'Failed to create agent config' });
  }
});

// PATCH /api/v1/agent-configs/:id — 更新 (auto-snapshot before change)
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, model, systemPrompt, tools, environmentId, maxTokens, temperature, status, changedBy, changeReason } = req.body;

    if (environmentId) {
      const env = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!env) return res.status(400).json({ error: 'Environment not found' });
    }

    // Snapshot before update
    await createVersionSnapshot(req.params.id, changedBy, changeReason);

    const config = await prisma.agentConfig.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(model !== undefined && { model }),
        ...(systemPrompt !== undefined && { systemPrompt }),
        ...(tools !== undefined && { tools }),
        ...(environmentId !== undefined && { environmentId }),
        ...(maxTokens !== undefined && { maxTokens }),
        ...(temperature !== undefined && { temperature }),
        ...(status !== undefined && { status }),
      },
      include: { environment: { select: { id: true, name: true } } },
    });

    logger.info({ configId: config.id }, 'Agent config updated');
    res.json(config);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'Agent config not found' });
    }
    logger.error({ error }, 'Failed to update agent config');
    res.status(500).json({ error: 'Failed to update agent config' });
  }
});

// DELETE /api/v1/agent-configs/:id — 删除
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.agentConfig.delete({ where: { id: req.params.id } });
    logger.info({ configId: req.params.id }, 'Agent config deleted');
    res.status(204).end();
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'Agent config not found' });
    }
    logger.error({ error }, 'Failed to delete agent config');
    res.status(500).json({ error: 'Failed to delete agent config' });
  }
});

// GET /api/v1/agent-configs/:id/versions — 版本历史
router.get('/:id/versions', async (req: Request, res: Response) => {
  try {
    const versions = await prisma.agentConfigVersion.findMany({
      where: { agentConfigId: req.params.id },
      orderBy: { version: 'desc' },
    });

    res.json({ data: versions, total: versions.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list versions');
    res.status(500).json({ error: 'Failed to list versions' });
  }
});

// POST /api/v1/agent-configs/:id/rollback/:versionId — 回滚
router.post('/:id/rollback/:versionId', async (req: Request, res: Response) => {
  try {
    const { id, versionId } = req.params;

    const version = await prisma.agentConfigVersion.findFirst({
      where: { id: versionId, agentConfigId: id },
    });
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const snapshot = JSON.parse(version.snapshot || '{}') as Record<string, any>;

    // Snapshot current state before rollback
    await createVersionSnapshot(id, 'system', `Rollback to version ${version.version}`);

    // Apply snapshot
    const config = await prisma.agentConfig.update({
      where: { id },
      data: {
        name: snapshot.name,
        description: snapshot.description,
        model: snapshot.model,
        systemPrompt: snapshot.systemPrompt,
        tools: snapshot.tools,
        environmentId: snapshot.environmentId,
        maxTokens: snapshot.maxTokens,
        temperature: snapshot.temperature,
        status: snapshot.status,
      },
      include: { environment: { select: { id: true, name: true } } },
    });

    logger.info({ configId: id, rolledBackTo: version.version }, 'Agent config rolled back');
    res.json(config);
  } catch (error) {
    logger.error({ error }, 'Failed to rollback agent config');
    res.status(500).json({ error: 'Failed to rollback' });
  }
});

export default router;
