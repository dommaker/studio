/**
 * 分页工具 - 统一 API 分页参数解析和响应格式
 */

import type { Request, Response } from 'express';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** 从请求 query 中解析分页参数 */
export function parsePagination(req: Request): PaginationParams {
  const page = Math.max(1, parseInt(String(req.query.page ?? DEFAULT_PAGE), 10) || DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  return { page, limit, offset: (page - 1) * limit };
}

/** 构造分页响应对象 */
export function formatPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResponse<T> {
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/** 发送分页响应 */
export function sendPaginated<T>(res: Response, data: T[], total: number, page: number, limit: number): void {
  res.json(formatPaginatedResponse(data, total, page, limit));
}
