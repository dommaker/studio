/**
 * index.ts（mountApiDocs）单元测试：迷你 express app + 单条 defineRoute 路由表，
 * 实际 HTTP 命中 /api/docs（JSON 合法 + 含该路由）与 /api/docs/ui（Swagger 页）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { z } from 'zod';
import { dataBodySchema } from '@dommaker/studio-contract';
import { defineRoute } from '../../core/http.js';
import { mountApiDocs } from '../index.js';
import { buildOpenApiDocument } from '../build.js';
import { discoverRoutes } from '../discover.js';
import type { RouteEntry } from '../../route-registry.js';

describe('mountApiDocs', () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it('GET /api/docs 返回含挂载路由的合法 OpenAPI；GET /api/docs/ui 返回 Swagger 页', async () => {
    const router = express.Router();
    router.get('/ping', defineRoute({
      query: z.object({ n: z.string().optional() }),
      response: dataBodySchema(z.object({ pong: z.boolean() })),
    }, async () => ({ pong: true })));
    const table: RouteEntry[] = [{ path: '/api/v1/mini', router }];

    const app = express();
    app.use('/api/v1/mini', router);
    mountApiDocs(app, table);

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/docs`);
    expect(res.status).toBe(200);
    const doc = await res.json() as { openapi: string; paths: Record<string, { get?: {
      parameters?: Array<{ name: string }>;
      responses: Record<string, { content?: { 'application/json': { schema: {
        properties?: { data?: { properties?: Record<string, unknown> } };
      } } } }>;
    } }> };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.paths['/api/v1/mini/ping']?.get?.parameters?.[0]?.name).toBe('n');
    expect(doc.paths['/api/v1/mini/ping']?.get?.responses['200']
      .content?.['application/json'].schema.properties?.data?.properties).toHaveProperty('pong');

    const ui = await fetch(`http://127.0.0.1:${port}/api/docs/ui`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('swagger-ui');
  });

  it('未声明 response 且不在显式覆盖清单的路由拒绝静默退化', () => {
    const router = express.Router();
    router.get('/missing', defineRoute({}, async () => ({ ok: true })));
    const { routes, skipped } = discoverRoutes([{ path: '/api/v1/mini', router }]);

    expect(() => buildOpenApiDocument(routes, skipped)).toThrow('GET /api/v1/mini/missing');
  });
});
