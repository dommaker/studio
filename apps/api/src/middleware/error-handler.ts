// 错误处理中间件
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { redactSensitive } from '../utils/redact.js';

export function errorHandler(
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error({
    error: redactSensitive(error),
    method: req.method,
    path: req.path,
    body: redactSensitive(req.body),
    query: redactSensitive(req.query),
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
  res.status(error.status || 500).json({
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
    },
  });
}
