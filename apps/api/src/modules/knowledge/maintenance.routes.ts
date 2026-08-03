/**
 * Knowledge Maintenance Routes — F1 知识库维护的手动触发入口
 *
 * 背景（docs/issues/2026-08-03-unattended-token-burn.md B7）：KnowledgeCurator 每日维护
 * （语义去重/质量评估/过期验证/矛盾审查，LLM 批调用）的自动日循环已由
 * knowledgeMaintenanceEnabled 门控默认停用；本端点是手动触发入口——人点按钮是明确意图，
 * 不走 B7 开关。一次运行约几十批 LLM 调用、持续数分钟，端点同步等待返回聚合结果。
 */
import { Router } from 'express';
import { knowledgeCurator } from '../agents/knowledge-curator.service.js';

const router = Router();

/** POST /api/v1/knowledge/maintenance/run — 手动运行 F1 知识库维护 */
router.post('/maintenance/run', async (_req, res) => {
  try {
    const result = await knowledgeCurator.runDailyMaintenance();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
  }
});

export { router as maintenanceRoutes };
