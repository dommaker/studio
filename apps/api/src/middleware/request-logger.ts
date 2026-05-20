// 请求日志中间件
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      contentLength: res.getHeader('content-length'),
    }, 'Request completed');
  });

  next();
}
