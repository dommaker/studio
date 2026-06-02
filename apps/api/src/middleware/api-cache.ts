// API 缓存中间件 — 内存 Map
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

const cache = new Map<string, { data: string; expiresAt: number }>();

const CACHE_CONFIG = {
  short: 5,
  medium: 30,
  long: 60,
  static: 300,
};

function generateCacheKey(req: Request): string {
  return `api:cache:${req.path}:${JSON.stringify(req.query)}`;
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
        cache.set(cacheKey, { data: JSON.stringify(data), expiresAt: Date.now() + ttl * 1000 });
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
