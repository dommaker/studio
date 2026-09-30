/**
 * AC-D3: Project Discovery API
 *
 * Endpoints:
 *   GET /api/v1/projects/discover — list discovered projects
 *   GET /api/v1/projects/exclude  — #266: 读取归属候选排除清单（~/.studio/projects-exclude.json）
 *   PUT /api/v1/projects/exclude  — #266: 全量保存排除清单（保存后主动 invalidateCache，候选即时生效）
 *
 * 契约驱动迁移（2026-10 批次 2/7）：全部端点走 core/http.ts defineRoute——
 * PUT exclude 的手写数组校验收进 zod（口径不变）；统一 envelope（{ data }，
 * 原 `{ success: true, data }` 平铺壳退役）；500 兜底统一 INTERNAL。
 */
import { Router } from 'express';
import {
  discoverProjectsQuerySchema,
  putProjectExcludeBodySchema,
} from '@dommaker/studio-contract';
import { ProjectDiscoveryService } from './project-discovery.service.js';
import { loadProjectExcludeConfig, saveProjectExcludeConfig } from './project-exclude-config.js';
import { defineRoute } from '../../core/http.js';

const router = Router();
const service = new ProjectDiscoveryService();

/** GET /discover — scan local directories for projects */
router.get('/discover', defineRoute({ query: discoverProjectsQuerySchema }, async (_req, _res, { query }) => {
  return query.search ? service.search(query.search) : service.discover();
}));

/** GET /exclude — #266（决策 #258）：排除清单读取（文件损坏降级空清单，不炸） */
router.get('/exclude', defineRoute({}, async () => {
  return { exclude: loadProjectExcludeConfig() };
}));

/** PUT /exclude — #266：全量保存排除清单；写盘成功后主动失效发现缓存 */
router.put('/exclude', defineRoute({ body: putProjectExcludeBodySchema }, async (_req, _res, { body }) => {
  saveProjectExcludeConfig(body.exclude.map(s => s.trim()).filter(Boolean));
  service.invalidateCache();
  return { exclude: loadProjectExcludeConfig() };
}));

export default router;
