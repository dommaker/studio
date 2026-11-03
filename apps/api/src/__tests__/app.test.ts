import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const getMetrics = vi.hoisted(() => vi.fn());
vi.mock('../modules/ops/index.js', () => ({ getMetrics }));

import { app } from '../app.js';
import { errorHandler } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

describe('app production error responses', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // registerRoutes() 在真实启动中于路由后挂载同一个全局错误处理器。
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('/metrics 500 hides internal details and correlates redacted logs by requestId', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const marker = 'SEC09_METRICS_INTERNAL_MARKER';
    getMetrics.mockRejectedValue(Object.assign(new Error(marker), {
      config: { headers: { authorization: 'Bearer metrics-secret' } },
    }));
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/metrics`, { headers: { 'x-request-id': 'req-sec09-metrics' } });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-sec09-metrics' },
      });
      expect(JSON.stringify(body)).not.toContain(marker);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-sec09-metrics',
        error: expect.objectContaining({
          message: marker,
          config: { headers: { authorization: '[REDACTED]' } },
        }),
      }), 'Unhandled error');
    } finally {
      log.mockRestore();
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });
});
