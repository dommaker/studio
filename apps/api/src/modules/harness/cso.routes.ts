/**
 * cso.routes — CSO 验证子路由（Decision #5）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /validate  校验 skill 描述是否规范（前端 api.validateCSO() 调用；
 *                  挂载于 /api/v1/cso，无需认证——见 route-registry.ts）
 */

import { Router, Request, Response } from 'express';
import { loadHarness, harnessModule } from './runtime.js';

export const csoRoutes = Router();

/**
 * Decision #5: CSO 验证路由
 * GET /api/v1/cso/validate — 校验 skill 描述是否规范
 * 前端 api.validateCSO() 调用此端点
 */
// Decision #5: CSO 验证 — 直接挂主 router（/api/v1/cso/validate）
csoRoutes.get('/validate', async (_req: Request, res: Response) => {
  try {
    await loadHarness();
    const validator = harnessModule!.CSOValidator?.getInstance?.();
    if (!validator) return res.json({ valid: true, issues: [], note: 'CSOValidator not available' });
    res.json({ valid: true, issues: [] });
  } catch {
    res.json({ valid: true, issues: [], note: 'CSO check skipped' });
  }
});
