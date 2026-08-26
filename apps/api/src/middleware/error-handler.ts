// 错误处理中间件
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export function errorHandler(
  error: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error({
    error,
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query,
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
