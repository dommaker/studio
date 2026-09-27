// API 缓存中间件 — 内存 Map
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

const cache = new Map<string, { data: string; expiresAt: number }>();

/**
 * 惰性清扫过期键（B6）：Map 只写不扫时过期键靠同 key 再访问才覆盖，缓慢泄漏。
 * 挂在写入路径——每次写缓存顺手扫一轮，代价与存活键数量同阶。
 * @returns 本次移除的键数（测试可观测）
 */
export function sweepExpired(): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) { cache.delete(key); removed++; }
  }
  return removed;
}

const CACHE_CONFIG = {
  short: 5,
  medium: 30,
  long: 60,
  static: 300,
};

function generateCacheKey(req: Request): string {
  // #448：key 含 baseUrl（挂载点），写路由才能按资源路径前缀精确失效（clearCache）
  return `api:cache:${req.baseUrl}${req.path}:${JSON.stringify(req.query)}`;
}

export function apiCache(ttl: number = CACHE_CONFIG.medium) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();

    const cacheKey = generateCacheKey(req);
    try {
      const entry = cache.get(cacheKey);
      if (entry && entry.expiresAt > Date.now()) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Cache-Control', `public, max-age=${ttl}`);
        return res.json(JSON.parse(entry.data));
      }

      res.setHeader('X-Cache', 'MISS');
      const originalJson = res.json.bind(res);
      res.json = (data: any) => {
        // 错误响应（≥400）不缓存：瞬时失败不得在 TTL 窗口内钉死端点（#403）
        if (res.statusCode < 400) {
          sweepExpired();
          cache.set(cacheKey, { data: JSON.stringify(data), expiresAt: Date.now() + ttl * 1000 });
        }
        return originalJson(data);
      };
      next();
    } catch (error) {
      logger.error({ error }, 'Cache middleware error');
      next();
    }
  };
}

export async function clearCache(pattern: string): Promise<void> {
  const prefix = `api:cache:${pattern}`;
  let count = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) { cache.delete(key); count++; }
  }
  if (count > 0) logger.info(`Cache cleared ${count} keys for pattern: ${pattern}`);
}

export { CACHE_CONFIG };
