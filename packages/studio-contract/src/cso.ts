/**
 * cso 域契约（批次 6/7）——正本以 apps/api/src/modules/harness/cso.routes.ts
 * 实测 wire 为准。
 *
 * 单端点（route-registry /api/v1/cso 公开挂载——Lurk Wall 白名单，
 * 只挂 validate 不整挂 harness router）：
 *   GET /validate  校验 skill 描述是否规范（恒 200；validator 不可用/异常
 *                  均降级为 valid:true + note，不抛错）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - `{ valid, issues, note? }` → `{ data: { valid, issues, note? } }`
 * （无仓内消费方——后端注释的前端 api.validateCSO() 已不存在，死注释随迁移清除）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/** GET /validate 响应 data（issues 元素形状归 CSOValidator，宽声明） */
export const csoValidateResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.unknown()),
  /** 降级说明（'CSOValidator not available' / 'CSO check skipped'；正常校验不带该键） */
  note: z.string().optional(),
});
export type CsoValidateResult = z.infer<typeof csoValidateResultSchema>;

export const csoValidateResponseSchema = dataBodySchema(csoValidateResultSchema);
