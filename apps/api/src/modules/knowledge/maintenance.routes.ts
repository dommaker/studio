/**
 * Knowledge Maintenance Routes — F1 知识库维护的手动触发入口
 *
 * 背景（docs/issues/2026-08-03-unattended-token-burn.md B7）：KnowledgeCurator 每日维护
 * （语义去重/质量评估/过期验证/矛盾审查，LLM 批调用）的自动日循环已由
 * knowledgeMaintenanceEnabled 门控默认停用；本端点是手动触发入口——人点按钮是明确意图，
 * 不走 B7 开关。一次运行约几十批 LLM 调用、持续数分钟，端点同步等待返回聚合结果。
 *
 * 契约驱动迁移（2026-10 批次 4/7）：走 core/http.ts defineRoute——响应统一
 * `{ data }` 壳（原平铺裸结果对象）；错误统一 `{ error: { code, message } }`
 * （原 `{ error: { message } }` 补 code）。
 */
import { Router } from 'express';
import { knowledgeCurator } from '../agents/knowledge/knowledge-curator.service.js';
import { defineRoute } from '../../core/http.js';

const router = Router();

/** POST /api/v1/knowledge/maintenance/run — 手动运行 F1 知识库维护 */
router.post('/maintenance/run', defineRoute({}, async () => {
  return knowledgeCurator.runDailyMaintenance();
}));

export { router as maintenanceRoutes };
