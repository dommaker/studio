/**
 * cso.routes — CSO 验证子路由（Decision #5）
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更），处理器逐字迁移：
 * - GET /validate  校验 skill 描述是否规范
 *                  （挂载于 /api/v1/cso，无需认证——见 route-registry.ts）
 *
 * 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
 * `{ valid, issues, note? }` 进 `{ data }` 壳（schema 见 studio-contract cso.ts）；
 * 恒 200 降级语义不变（validator 不可用/异常均 valid:true + note，不抛错）。
 * 原注释的前端 api.validateCSO() 调用方已不存在（死注释清除，无仓内消费方）。
 */

import { Router } from 'express';
import { defineRoute } from '../../core/http.js';
import { loadHarness, harnessModule } from './runtime.js';

export const csoRoutes = Router();

/**
 * Decision #5: CSO 验证路由
 * GET /api/v1/cso/validate — 校验 skill 描述是否规范
 */
// Decision #5: CSO 验证 — 直接挂主 router（/api/v1/cso/validate）
csoRoutes.get('/validate', defineRoute({}, async () => {
  try {
    await loadHarness();
    const validator = harnessModule!.CSOValidator?.getInstance?.();
    if (!validator) return { valid: true, issues: [], note: 'CSOValidator not available' };
    return { valid: true, issues: [] };
  } catch {
    return { valid: true, issues: [], note: 'CSO check skipped' };
  }
}));
