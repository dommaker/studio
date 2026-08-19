/**
 * Compression filter (#263)
 *
 * 全局 compression 中间件会缓冲 SSE 流（compressible('text/event-stream')
 * 经 /^text\// fallback 返回 true，#259 坐实），导致频道实时推送全灭。
 * filter 排除 text/event-stream，其余响应走 compression 默认逻辑。
 */
import compression from 'compression';
import type { Request, Response } from 'express';

export function shouldCompress(req: Request, res: Response): boolean {
  const contentType = res.getHeader('Content-Type');
  if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
    return false;
  }
  return compression.filter(req, res);
}
