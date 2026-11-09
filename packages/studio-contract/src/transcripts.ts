/**
 * transcripts 域契约——正本以 apps/api/src/modules/transcripts/
 * transcript-archive.ts（TranscriptEntry）与 transcript.routes.ts 实测 wire 为准。
 *
 * 单端点 GET /api/v1/transcripts/:workUnitId（auth）：按 WU 读归档 transcript，
 * 文件不存在返回 200 空列表（不 404）。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - `{ data: { workUnitId, total, offset, limit, entries } }`（原平铺进壳；分页语义不变）
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: string }` 退役；
 *   workUnitId 防路径穿越手写 400 收进 zod params，文案变 zod 格式；
 *   500 文案由固定串变为实际错误消息）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体：TranscriptEntry（JSONL 一行 = 一步）──

export const transcriptEntrySchema = z.object({
  workUnitId: z.string(),
  assignmentId: z.string().optional(),
  /** 本步会话号（WU 内可能因重建/续用切换，逐行记录） */
  sessionId: z.string().optional(),
  /** 1 基步号（与 agent-loop recordResult 的 stepCount 同口径） */
  step: z.number(),
  /** 本步 ACTION 结论（progress/complete/need_input/failed） */
  action: z.string().optional(),
  /** 本步原文（raw CLI stdout；provider 无关，全文保留不截断） */
  rawOutput: z.string().optional(),
  /** 归档时间 ISO 8601 */
  createdAt: z.string(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

// ── 派生读形状 ──

/** GET /:workUnitId 响应 data */
export const transcriptResultSchema = z.object({
  workUnitId: z.string(),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
  entries: z.array(transcriptEntrySchema),
});
export type TranscriptResult = z.infer<typeof transcriptResultSchema>;

// ── 请求 ──

/** workUnitId 防路径穿越：拒绝空值 / 含路径分隔符 / 含 ..（原手写 400 收进 zod） */
export const transcriptParamsSchema = z.object({
  workUnitId: z.string()
    .min(1)
    .refine((v) => !v.includes('/') && !v.includes('\\') && !v.includes('..'), {
      message: 'invalid workUnitId',
    }),
});
export type TranscriptParams = z.infer<typeof transcriptParamsSchema>;

/** GET /:workUnitId（offset 缺省 0、limit clamp 1-100 缺省 20 均走 parsePagination） */
export const transcriptQuerySchema = z.object({
  offset: z.string().optional(),
  limit: z.string().optional(),
});
export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;

// ── 响应（统一 `{ data }` 壳）──

export const transcriptResponseSchema = dataBodySchema(transcriptResultSchema);
