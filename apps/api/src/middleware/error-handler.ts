// 错误处理中间件
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { redactSensitive } from '../utils/redact.js';
import { ensureRequestId } from './audit-logger.js';

export function errorHandler(
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = ensureRequestId(req);
  logger.error({
    error: redactSensitive(error),
    method: req.method,
    path: req.path,
    body: redactSensitive(req.body),
    query: redactSensitive(req.query),
    requestId,
  }, 'Unhandled error');

  // 验证错误
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message,
        details: error.details,
      },
    });
  }

  // 默认错误
  const status = error.status || 500;
  const code = error.code || 'INTERNAL_ERROR';
  if (process.env.NODE_ENV === 'production' && status >= 500) {
    return res.status(status).json({
      error: { code, message: 'Internal server error', requestId },
    });
  }
  res.status(status).json({
    error: {
      code,
      message: error.message || 'An unexpected error occurred',
    },
  });
}
