/**
 * AC-D3: Project Discovery API
 *
 * Endpoints:
 *   GET /api/v1/projects/discover — list discovered projects
 *   GET /api/v1/projects/exclude  — #266: 读取归属候选排除清单（~/.studio/projects-exclude.json）
 *   PUT /api/v1/projects/exclude  — #266: 全量保存排除清单（保存后主动 invalidateCache，候选即时生效）
 */
import { Router, type Request, type Response } from 'express';
import { ProjectDiscoveryService } from './project-discovery.service.js';
import { loadProjectExcludeConfig, saveProjectExcludeConfig } from './project-exclude-config.js';
import { getErrorMessage } from '../../utils/errors.js';

const router = Router();
const service = new ProjectDiscoveryService();

/** GET /discover — scan local directories for projects */
router.get('/discover', async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    const projects = search
      ? await service.search(search as string)
      : await service.discover();
    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

/** GET /exclude — #266（决策 #258）：排除清单读取（文件损坏降级空清单，不炸） */
router.get('/exclude', (_req: Request, res: Response) => {
  res.json({ success: true, data: { exclude: loadProjectExcludeConfig() } });
});

/** PUT /exclude — #266：全量保存排除清单；写盘成功后主动失效发现缓存 */
router.put('/exclude', (req: Request, res: Response) => {
  const exclude = (req.body as { exclude?: unknown })?.exclude;
  if (!Array.isArray(exclude) || !exclude.every(s => typeof s === 'string')) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'exclude must be an array of strings' },
    });
  }
  try {
    saveProjectExcludeConfig(exclude.map(s => s.trim()).filter(Boolean));
    service.invalidateCache();
    res.json({ success: true, data: { exclude: loadProjectExcludeConfig() } });
  } catch (error) {
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: getErrorMessage(error) },
    });
  }
});

export default router;
