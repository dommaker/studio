/**
 * admin 域契约（批次 6/7）——正本以 apps/api/src/modules/admin/
 * docs-freshness.routes.ts 实测 wire 为准。
 *
 * 单端点（route-registry /api/v1/admin/docs-freshness 挂 admin）：
 *   GET /  CLAUDE.md 新鲜度 + harness checkConstraints（docs_freshness/capability_sync）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 裸 FreshnessResult → `{ data: DocsFreshnessResult }`
 * - 500 `{ error: 'Freshness check failed' }` → `{ error: { code, message } }`
 *   （message 由固定串变为实际错误消息）
 * （无前端消费方——z.infer 结果类型全可选无害，不手写 interface）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

export const docsFreshnessSectionSchema = z.object({
  section: z.string(),
  status: z.enum(['ok', 'stale', 'missing']),
  detail: z.string(),
});

/** GET / 响应 data（FreshnessResult wire 正本） */
export const docsFreshnessResultSchema = z.object({
  status: z.enum(['fresh', 'stale', 'missing']),
  claudeLastModified: z.string().optional(),
  daysSinceUpdate: z.number().optional(),
  recentChanges: z.array(z.object({ file: z.string(), modified: z.string() })),
  sections: z.array(docsFreshnessSectionSchema),
  recommendations: z.array(z.string()),
  /** T-059：harness checkDocsFreshness 段（harness 不可用时不带该键） */
  harnessCheck: z.object({
    passed: z.boolean(),
    details: z.array(z.object({
      id: z.string(),
      passed: z.boolean(),
      message: z.string(),
    })),
  }).optional(),
});
export type DocsFreshnessResult = z.infer<typeof docsFreshnessResultSchema>;

export const docsFreshnessResponseSchema = dataBodySchema(docsFreshnessResultSchema);
