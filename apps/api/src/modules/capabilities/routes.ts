// capabilities/routes.ts - 能力注册表 API
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getRegistryPath, getToolsDir } from '@dommaker/harness';
import { CapabilityService } from '@dommaker/studio-capability';
import { requireNotGuest, requireRole } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002
import { FileStore, logger } from '@dommaker/studio-shared';
import { createLazyService } from '../../utils/services.js';

const router = Router();

const REGISTRY_PATH = process.env.AGENT_REGISTRY_PATH || getRegistryPath();
const DEFINITIONS_DIR = getToolsDir();

// 能力类型定义
interface Capability {
  name: string;
  type: 'tool' | 'skill';
  category: string;
  description: string;
  path: string;
}

interface Registry {
  tools: Capability[];
}

// 缓存能力列表
let cachedRegistry: Registry | null = null;
let lastLoadTime = 0;
const CACHE_TTL = 60000; // 1 分钟缓存

// 能力服务实例
const getCapabilityService = createLazyService(() => new CapabilityService(new FileStore(), REGISTRY_PATH));

// 加载能力注册表
function loadRegistry(): Registry {
  const now = Date.now();
  
  // 使用缓存
  if (cachedRegistry && (now - lastLoadTime) < CACHE_TTL) {
    return cachedRegistry;
  }
  
  try {
    logger.info('[Registry] Loading from: ' + REGISTRY_PATH);
    const content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    cachedRegistry = JSON.parse(content);
    lastLoadTime = now;
    logger.info('[Registry] Loaded', { tools: cachedRegistry.tools?.length });
    return cachedRegistry!;
  } catch (error) {
    logger.error('Failed to load registry', { error: String(error) });
    return { tools: [] };
  }
}

// ==================== Registry API（文件系统）====================

// Stage 定义（责任链模型）
type Stage = 'plan' | 'develop' | 'verify' | 'deploy' | 'fix' | 'govern';

const STAGE_NAMES: Record<Stage, string> = {
  plan: '规划',
  develop: '开发',
  verify: '验证',
  deploy: '部署',
  fix: '修复',
  govern: '治理',
};

/**
 * 从 YAML 文件读取 stage 字段
 */
function getStageFromYaml(relativePath: string): Stage | undefined {
  try {
    const filePath = path.resolve(DEFINITIONS_DIR, relativePath);
    if (!fs.existsSync(filePath)) return undefined;

    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/stage:\s*(\w+)/);
    return match ? match[1] as Stage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 构建 Stage 分类数据
 */
function buildStageCategories(): { id: Stage; name: string; tools: Capability[] }[] {
  const registry = loadRegistry();
  const stages: Stage[] = ['plan', 'develop', 'verify', 'deploy', 'fix', 'govern'];

  return stages.map(stage => ({
    id: stage,
    name: STAGE_NAMES[stage],
    tools: registry.tools.filter(t => {
      const yamlStage = getStageFromYaml(t.path);
      return yamlStage === stage || (!yamlStage && stage === 'develop');
    }),
  }));
}

// 获取 Stage 分类数据
router.get('/stages', (req, res) => {
  const categories = buildStageCategories();
  res.json({
    data: categories,
    total: categories.length,
  });
});

// 获取所有能力（Registry）
router.get('/registry', (req, res) => {
  const registry = loadRegistry();

  const capabilities = registry.tools.map(c => ({ ...c, type: 'tool' as const }));

  res.json({
    total: capabilities.length,
    tools: registry.tools.length,
    capabilities,
  });
});

// 刷新 Registry 缓存
router.post('/registry/refresh', (req, res) => {
  cachedRegistry = null;
  lastLoadTime = 0;
  const registry = loadRegistry();
  
  res.json({
    message: 'Registry refreshed',
    tools: registry.tools.length,
  });
});

// 从 Registry 同步到数据库
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const result = await service.syncFromRegistry();
    res.json({
      message: 'Sync completed',
      ...result,
    });
  } catch (error) {
    logger.error('Failed to sync capabilities', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to sync capabilities' },
    });
  }
});

// ==================== 数据库 API ====================

// 获取能力列表（数据库）
router.get('/', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const { type, status, page = 1, limit = 50 } = req.query;

    const result = await service.list({
      type: type as string,
      status: status as string,
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
    logger.error('Failed to list capabilities', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list capabilities' },
    });
  }
});

// 获取能力统计
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const stats = await service.getStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get capability stats', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get capability stats' },
    });
  }
});

// 获取消耗配置
router.get('/cost-config', (req: Request, res: Response) => {
  const service = getCapabilityService();
  const config = service.getCostConfig();
  res.json({ data: config });
});

// 创建能力
router.post('/', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const capability = await service.create(req.body);
    res.status(201).json(capability);
  } catch (error: any) {
    logger.error('Failed to create capability', { error: String(error) });
    if (error.message?.includes('unique')) {
      res.status(409).json({
        error: { code: 'ALREADY_EXISTS', message: 'Capability already exists' },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create capability' },
      });
    }
  }
});

// 批量创建能力
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const { capabilities } = req.body;

    if (!Array.isArray(capabilities)) {
      return res.status(400).json({
        error: { code: 'INVALID_INPUT', message: 'capabilities must be an array' },
      });
    }

    const count = await service.createMany(capabilities);
    res.status(201).json({ created: count });
  } catch (error) {
    logger.error('Failed to batch create capabilities', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to batch create capabilities' },
    });
  }
});

// 获取单个能力详情
router.get('/:capabilityId', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const { capabilityId } = req.params;

    const capability = await service.getById(capabilityId);

    if (!capability) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Capability ${capabilityId} not found` },
      });
    }

    res.json(capability);
  } catch (error) {
    logger.error('Failed to get capability', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get capability' },
    });
  }
});

// 按名称获取能力
router.get('/name/:name', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const { name } = req.params;
    const { type } = req.query;

    const capability = await service.getByName(name, type as string);

    if (!capability) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Capability ${name} not found` },
      });
    }

    res.json(capability);
  } catch (error) {
    logger.error('Failed to get capability by name', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get capability by name' },
    });
  }
});

// 更新能力
router.put('/:capabilityId', async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const { capabilityId } = req.params;

    const capability = await service.update(capabilityId, req.body);
    res.json(capability);
  } catch (error: any) {
    logger.error('Failed to update capability', { error: String(error) });
    if (error.message?.includes('not found')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: error.message },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to update capability' },
      });
    }
  }
});

// 删除能力
// 🆕 SEC-002: Admin only
router.delete('/:capabilityId', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const service = getCapabilityService();
    const { capabilityId } = req.params;

    await service.delete(capabilityId);
    res.status(204).send();
  } catch (error: any) {
    logger.error('Failed to delete capability', { error: String(error) });
    if (error.message?.includes('not found')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: error.message },
      });
    } else {
      res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to delete capability' },
      });
    }
  }
});

export { loadRegistry };
export default router;
