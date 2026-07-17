// agent-configs/routes.ts — Agent Manager + Version Control (HZ-024, HZ-025)
import { Router, Request, Response } from 'express';
import { FileStore } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../../utils/logger.js';

const router = Router();

const AGENTS_DIR = path.join(os.homedir(), '.studio', 'agents');
const ENVIRONMENTS_JSON = path.join(os.homedir(), '.studio', 'environments.json');
const fileStore = new FileStore();

/** Helper: resolve environmentId to name from environments.json */
async function getEnvironmentName(envId: string): Promise<string | null> {
  const envs = await fileStore.readJson<any[]>(ENVIRONMENTS_JSON);
  if (!envs) return null;
  const env = envs.find((e: any) => e.id === envId);
  return env?.name || null;
}

async function environmentExists(envId: string): Promise<boolean> {
  const name = await getEnvironmentName(envId);
  return name !== null;
}

/** Helper: create a version snapshot before updating */
async function createVersionSnapshot(agentId: string, changedBy?: string, reason?: string) {
  const agentPath = path.join(AGENTS_DIR, `${agentId}.json`);
  const agentData = await fileStore.readJson<any>(agentPath);
  if (!agentData) return;

  const versionsPath = path.join(AGENTS_DIR, agentId, 'versions.jsonl');
  // Read existing versions to get last version number
  let lastVersion = 0;
  try {
    const versions = await fileStore.readJsonl<any>(versionsPath);
    if (versions.length > 0) {
      lastVersion = versions[versions.length - 1].version;
    }
  } catch {}

  const snapshot = {
    name: agentData.name,
    description: agentData.description,
    model: agentData.model,
    systemPrompt: agentData.systemPrompt,
    tools: agentData.tools,
    environment: agentData.environment,
    maxTokens: agentData.maxTokens || agentData.config?.maxTokens,
    temperature: agentData.temperature || agentData.config?.temperature,
    status: agentData.status,
  };

  await fileStore.appendJsonl(versionsPath, {
    agentConfigId: agentId,
    version: lastVersion + 1,
    snapshot: JSON.stringify(snapshot),
    changedBy: changedBy || 'system',
    changeReason: reason,
    createdAt: new Date().toISOString(),
  });
}

// GET /api/v1/agent-configs — 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const results: any[] = [];

    await fs.promises.mkdir(AGENTS_DIR, { recursive: true });
    const entries = await fs.promises.readdir(AGENTS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const agentPath = path.join(AGENTS_DIR, entry.name);
      const agentData = await fileStore.readJson<any>(agentPath);
      if (agentData && (!status || agentData.status === status)) {
        results.push(agentData);
      }
    }

    results.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ data: results, total: results.length });
  } catch (error) {
    logger.error({ error }, 'Failed to list agent configs');
    res.status(500).json({ error: 'Failed to list agent configs' });
  }
});

// GET /api/v1/agent-configs/:id — 详情
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const agentPath = path.join(AGENTS_DIR, `${req.params.id}.json`);
    const config = await fileStore.readJson<any>(agentPath);
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

    // Resolve environmentId to name string
    let envName: string | null = null;
    if (environmentId) {
      envName = await getEnvironmentName(environmentId);
      if (!envName) return res.status(400).json({ error: 'Environment not found' });
    }

    const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const agentData = {
      id,
      name,
      description: description || null,
      model: model || 'claude-sonnet-4-6',
      systemPrompt: systemPrompt || '',
      tools: tools || [],
      environment: envName,
      config: {
        maxTokens: maxTokens || 4096,
        temperature: temperature ?? 0.7,
      },
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    const agentPath = path.join(AGENTS_DIR, `${id}.json`);
    await fileStore.writeJson(agentPath, agentData);

    // Create initial version
    await createVersionSnapshot(id, 'system', 'Initial creation');

    logger.info({ configId: id, name }, 'Agent config created');
    res.status(201).json(agentData);
  } catch (error) {
    logger.error({ error }, 'Failed to create agent config');
    res.status(500).json({ error: 'Failed to create agent config' });
  }
});

// PATCH /api/v1/agent-configs/:id — 更新 (auto-snapshot before change)
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, model, systemPrompt, tools, environmentId, maxTokens, temperature, status, changedBy, changeReason } = req.body;

    const agentPath = path.join(AGENTS_DIR, `${req.params.id}.json`);
    const existing = await fileStore.readJson<any>(agentPath);
    if (!existing) return res.status(404).json({ error: 'Agent config not found' });

    // Resolve environmentId to name if provided
    let envName = existing.environment;
    if (environmentId !== undefined) {
      if (environmentId) {
        envName = await getEnvironmentName(environmentId);
        if (!envName) return res.status(400).json({ error: 'Environment not found' });
      } else {
        envName = null;
      }
    }

    // Snapshot before update
    await createVersionSnapshot(req.params.id, changedBy, changeReason);

    // Merge patch
    const updatedConfig = { ...(existing.config || {}) };
    if (maxTokens !== undefined) updatedConfig.maxTokens = maxTokens;
    if (temperature !== undefined) updatedConfig.temperature = temperature;

    const config = {
      ...existing,
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(model !== undefined && { model }),
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(tools !== undefined && { tools }),
      ...(environmentId !== undefined && { environment: envName }),
      ...((maxTokens !== undefined || temperature !== undefined) && { config: updatedConfig }),
      ...(status !== undefined && { status }),
      updatedAt: new Date().toISOString(),
    };

    await fileStore.writeJson(agentPath, config);

    logger.info({ configId: config.id }, 'Agent config updated');
    res.json(config);
  } catch (error) {
    logger.error({ error }, 'Failed to update agent config');
    res.status(500).json({ error: 'Failed to update agent config' });
  }
});

// DELETE /api/v1/agent-configs/:id — 删除
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const agentPath = path.join(AGENTS_DIR, `${req.params.id}.json`);
    await fs.promises.unlink(agentPath);
    logger.info({ configId: req.params.id }, 'Agent config deleted');
    res.status(204).end();
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return res.status(404).json({ error: 'Agent config not found' });
    }
    logger.error({ error }, 'Failed to delete agent config');
    res.status(500).json({ error: 'Failed to delete agent config' });
  }
});

// GET /api/v1/agent-configs/:id/versions — 版本历史
router.get('/:id/versions', async (req: Request, res: Response) => {
  try {
    const versionsPath = path.join(AGENTS_DIR, req.params.id, 'versions.jsonl');
    const versions = await fileStore.readJsonl<any>(versionsPath);
    versions.sort((a, b) => (b.version || 0) - (a.version || 0));

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
    const versionNum = parseInt(versionId, 10);
    if (isNaN(versionNum)) return res.status(400).json({ error: 'Invalid version number' });

    const versionsPath = path.join(AGENTS_DIR, id, 'versions.jsonl');
    const versions = await fileStore.readJsonl<any>(versionsPath);
    const version = versions.find((v: any) => v.version === versionNum);
    if (!version) return res.status(404).json({ error: 'Version not found' });

    const snapshot = JSON.parse(version.snapshot || '{}') as Record<string, any>;

    // Snapshot current state before rollback
    await createVersionSnapshot(id, 'system', `Rollback to version ${version.version}`);

    // Apply snapshot
    const agentPath = path.join(AGENTS_DIR, `${id}.json`);
    const existing = await fileStore.readJson<any>(agentPath);
    if (!existing) return res.status(404).json({ error: 'Agent config not found' });

    const updated = {
      ...existing,
      name: snapshot.name,
      description: snapshot.description,
      model: snapshot.model,
      systemPrompt: snapshot.systemPrompt,
      tools: snapshot.tools,
      environment: snapshot.environment,
      config: {
        ...(snapshot.maxTokens != null && { maxTokens: snapshot.maxTokens }),
        ...(snapshot.temperature != null && { temperature: snapshot.temperature }),
      },
      status: snapshot.status,
      updatedAt: new Date().toISOString(),
    };

    await fileStore.writeJson(agentPath, updated);

    logger.info({ configId: id, rolledBackTo: version.version }, 'Agent config rolled back');
    res.json(updated);
  } catch (error) {
    logger.error({ error }, 'Failed to rollback agent config');
    res.status(500).json({ error: 'Failed to rollback' });
  }
});

export default router;
