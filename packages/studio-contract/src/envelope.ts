/**
 * 统一响应壳（target-architecture.md §契约）：
 * 成功 `{ data }`，分页 `{ data, pagination }`，失败 `{ error: { code, message } }`。
 * 禁止第三种形状。
 */

import { z } from 'zod';

/** 失败响应壳 */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** 分页元信息（与 apps/api utils/pagination.ts 的 formatPaginatedResponse 对齐） */
export const paginationSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});
export type Pagination = z.infer<typeof paginationSchema>;

/** 成功响应壳：`{ data: T }` */
export const dataBodySchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data });
export type DataBody<T> = { data: T };

/** 分页响应壳：`{ data: T[], pagination }` */
export const paginatedBodySchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), pagination: paginationSchema });
export type PaginatedBody<T> = { data: T[]; pagination: Pagination };

/** 标准错误码词表（defineRoute 错误映射用，业务自定义码不限于此） */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
