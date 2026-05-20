/**
 * 统一响应格式工具 - 规范化 API 响应结构
 */

import type { Response } from 'express';

/** 成功响应 */
export function sendSuccess(res: Response, data?: unknown, statusCode = 200): void {
  res.status(statusCode).json(data !== undefined ? { success: true, data } : { success: true });
}

/** 错误响应 */
export function sendError(res: Response, message: string, statusCode = 500, code?: string): void {
  res.status(statusCode).json({
    success: false,
    error: { code: code ?? `ERR_${statusCode}`, message },
  });
}

/** 404 响应 */
export function sendNotFound(res: Response, entity = 'Resource'): void {
  sendError(res, `${entity} not found`, 404, 'NOT_FOUND');
}

/** 400 响应 */
export function sendBadRequest(res: Response, message: string): void {
  sendError(res, message, 400, 'BAD_REQUEST');
}
