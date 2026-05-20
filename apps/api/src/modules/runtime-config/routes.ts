// runtime-config API - TaskWorker 配置（Redis 存储）
import { Router, Request, Response } from 'express';
import { eventStore } from '../../core/event-store.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();
const redis = eventStore;
const CONFIG_KEY = 'studio:worker:config';

/**
 * GET /api/v1/runtime-config
 * 获取 TaskWorker 配置
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const configStr = await redis.get(CONFIG_KEY);
    
    if (!configStr) {
      // 返回默认配置
      return res.json({
        success: true,
        data: {
          maxConcurrent: 3,
          tokenWarningThreshold: 15000,
          showTokenUsage: true,
        },
        source: 'default',
      });
    }
    
    const config = JSON.parse(configStr);
    res.json({
      success: true,
      data: config,
      source: 'redis',
    });
  } catch (error) {
    logger.error('Failed to get runtime config', { error: String(error) });
    res.status(500).json({
      success: false,
      error: { code: 'CONFIG_GET_ERROR', message: '获取配置失败' },
    });
  }
});

/**
 * POST /api/v1/runtime-config
 * 更新 TaskWorker 配置（写入 Redis）
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { maxConcurrent, tokenWarningThreshold, showTokenUsage } = req.body;
    
    // 验证参数
    if (maxConcurrent !== undefined) {
      if (maxConcurrent < 1 || maxConcurrent > 10) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_CONCURRENCY', message: '并发上限必须在 1-10 之间' },
        });
      }
    }
    
    if (tokenWarningThreshold !== undefined) {
      if (tokenWarningThreshold < 1000 || tokenWarningThreshold > 100000) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_THRESHOLD', message: 'Token 警告阈值必须在 1000-100000 之间' },
        });
      }
    }
    
    // 合并现有配置
    const existingStr = await redis.get(CONFIG_KEY);
    const existing = existingStr ? JSON.parse(existingStr) : {};
    
    const newConfig = {
      ...existing,
      ...(maxConcurrent !== undefined && { maxConcurrent }),
      ...(tokenWarningThreshold !== undefined && { tokenWarningThreshold }),
      ...(showTokenUsage !== undefined && { showTokenUsage }),
    };
    
    // 写入 Redis（无 TTL，永久存储）
    await redis.set(CONFIG_KEY, JSON.stringify(newConfig));
    
    logger.info('Runtime config updated', { config: newConfig });
    
    res.json({
      success: true,
      data: newConfig,
      message: '配置已更新，TaskWorker 将在下次启动时生效',
    });
  } catch (error) {
    logger.error('Failed to update runtime config', { error: String(error) });
    res.status(500).json({
      success: false,
      error: { code: 'CONFIG_UPDATE_ERROR', message: '更新配置失败' },
    });
  }
});

/**
 * POST /api/v1/runtime-config/reload
 * 触发 TaskWorker 重载配置（热更新）
 */
router.post('/reload', async (req: Request, res: Response) => {
  try {
    // 发布重载事件（TaskWorker 监听）
    await redis.publish('studio:worker:reload', JSON.stringify({
      timestamp: new Date().toISOString(),
    }));
    
    res.json({
      success: true,
      message: '已发送重载信号，TaskWorker 将在下次轮询时重新读取配置',
    });
  } catch (error) {
    logger.error('Failed to reload config', { error: String(error) });
    res.status(500).json({
      success: false,
      error: { code: 'CONFIG_RELOAD_ERROR', message: '重载配置失败' },
    });
  }
});

export default router;