// Iron Laws API — 从 runtime-proxy 迁移 (2026-05-14)；#150 A5 起直连 harness（ConstraintService facade 退役）
//
// 契约驱动迁移（2026-10 批次 6/7）：走 core/http.ts defineRoute——
// lawId/context 必填收进 zod（MISSING_LAW_ID/MISSING_CONTEXT 手写码退役，文案变 zod 格式；
// context 用 record 保 has* 键供 #641 sanitize 剥离）；`{ success, data, count, source }`
// 壳退役（success 恒 true、count = length、source 常量，均无消费方）；check/check-all
// 标注键（strippedEvidenceFlags/degradedChecks/violationPartialView）收进 data 内；
// 404 IRON_LAW_NOT_FOUND 机器串保留；500 code IRON_LAW(S)_*_ERROR 归一 INTERNAL
// （message 由固定串变为实际错误消息）。
import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';
import { getAllConstraints, getConstraint, checkConstraint, checkConstraints, ConstraintViolationError } from '@dommaker/harness';
import type { ConstraintContext } from '@dommaker/harness';
import { defineRoute, HttpError } from '../../core/http.js';
import {
  ironLawIdParamsSchema,
  ironLawCheckBodySchema,
  ironLawCheckAllBodySchema,
} from '@dommaker/studio-contract';
import { sanitizeConstraintContext, downgradeAnnotation, degradedChecksOf, violationAsPartialView, VIOLATION_PARTIAL_VIEW } from './sanitize-context.js';

const router = Router();

router.get('/', defineRoute({}, async () => {
  return getAllConstraints();
}));

router.get('/:id', defineRoute(
  { params: ironLawIdParamsSchema },
  async (_req, _res, { params }) => {
    const law = getConstraint(params.id);
    if (!law) throw new HttpError(404, 'IRON_LAW_NOT_FOUND', `铁律 ${params.id} 不存在`);
    return law;
  },
));

router.post('/check', defineRoute(
  { body: ironLawCheckBodySchema },
  async (_req, _res, { body }) => {
    // 单约束面：checkConstraint(id) 返回 ConstraintResult 不抛（即抛即停只属于
    // checkConstraints 的 block 编排），违规天然走数据面——异常仅真实故障
    // #641：剥离请求体自报的证据标志（has*），依赖项降级 skip（见 sanitize-context.ts）
    // context wire 为 record（保 has* 键），sanitize 入参边界收回
    const sanitized = sanitizeConstraintContext(body.context as unknown as ConstraintContext);
    const downgrade = downgradeAnnotation(sanitized.strippedFlags);

    if (Array.isArray(body.lawId)) {
      const results: Record<string, unknown> = {};
      for (const id of body.lawId) {
        results[id] = await checkConstraint(id, sanitized.context);
      }
      return { result: results, ...downgrade };
    }
    const result = await checkConstraint(body.lawId!, sanitized.context);
    return { result, ...downgrade };
  },
));

router.post('/check-all', defineRoute(
  { body: ironLawCheckAllBodySchema },
  async (_req, _res, { body }) => {
    // #641：剥离请求体自报的证据标志（has*），依赖项降级 skip（见 sanitize-context.ts）
    const sanitized = sanitizeConstraintContext(body.context as unknown as ConstraintContext);
    try {
      const results = await checkConstraints(sanitized.context);
      const degraded = degradedChecksOf(results);
      return {
        results,
        ...downgradeAnnotation(sanitized.strippedFlags),
        ...(degraded.length > 0 ? { degradedChecks: degraded } : {}),
      };
    } catch (error) {
      // block 模式首个 error 级违规即抛（ConstraintViolationError 只带该条结果）：
      // 违规是判定数据不是服务故障——转部分视图数据返回，500 只留给真实调不通 harness
      if (error instanceof ConstraintViolationError) {
        logger.warn('[IronLaws] Check-all violation (partial view)', { id: error.result.id });
        return {
          results: violationAsPartialView(error),
          ...downgradeAnnotation(sanitized.strippedFlags),
          violationPartialView: VIOLATION_PARTIAL_VIEW,
        };
      }
      throw error;
    }
  },
));

export default router;
