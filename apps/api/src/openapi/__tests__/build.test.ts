/**
 * build.ts 单元测试：合成 DiscoveredRoute fixture 装配文档，断言 OpenAPI 结构语义
 * （参数/requestBody/security/204/通用壳回退/排序/undocumented 透传）。不建路由表。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument } from '../build.js';
import type { DiscoveredRoute, SkippedRoute } from '../discover.js';

function route(partial: Partial<DiscoveredRoute> & Pick<DiscoveredRoute, 'method' | 'path'>): DiscoveredRoute {
  return {
    meta: { schema: {}, status: 200 },
    auth: 'open',
    mountPath: '/api/v1/fixture',
    ...partial,
  };
}

const fixtures: DiscoveredRoute[] = [
  route({
    method: 'get',
    path: '/api/v1/fixture/items',
    meta: {
      status: 200,
      schema: { query: z.object({ q: z.string().optional(), page: z.string() }) },
    },
  }),
  route({
    method: 'post',
    path: '/api/v1/fixture/items',
    auth: 'authNotGuest',
    meta: {
      status: 201,
      schema: { body: z.object({ name: z.string().min(1) }) },
    },
  }),
  route({
    method: 'delete',
    path: '/api/v1/fixture/items/:id',
    auth: 'admin',
    meta: { status: 204, schema: { params: z.object({ id: z.string() }) } },
  }),
];

const skipped: SkippedRoute[] = [
  { method: 'get', path: '/api/v1/fixture/stream', mountPath: '/api/v1/fixture', reason: 'no-define-route' },
];

describe('buildOpenApiDocument（合成 fixture）', () => {
  const doc = buildOpenApiDocument(fixtures, skipped);

  it('顶层结构：openapi 3.0.3 + info/paths/components + bearerAuth', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('Studio API');
    expect(Object.keys(doc.paths)).toHaveLength(2);
    expect(doc.components.securitySchemes).toMatchObject({ bearerAuth: { type: 'http', scheme: 'bearer' } });
    expect(doc['x-studio-undocumented']).toEqual(skipped);
  });

  it('query 参数：required 取自 zod 可选性；路径参数恒 required', () => {
    const get = doc.paths['/api/v1/fixture/items'].get;
    const params = get.parameters as Array<{ name: string; in: string; required: boolean }>;
    expect(params.find(p => p.name === 'q')).toMatchObject({ in: 'query', required: false });
    expect(params.find(p => p.name === 'page')).toMatchObject({ in: 'query', required: true });
    const del = doc.paths['/api/v1/fixture/items/{id}'].delete;
    expect((del.parameters as Array<{ name: string; in: string; required: boolean }>)[0])
      .toMatchObject({ name: 'id', in: 'path', required: true });
  });

  it('requestBody 只来自 body schema；成功状态码尊重 meta.status', () => {
    const post = doc.paths['/api/v1/fixture/items'].post;
    expect(post.requestBody.content['application/json'].schema.required).toContain('name');
    expect(post.responses['201']).toBeDefined();
    expect(doc.paths['/api/v1/fixture/items'].get.requestBody).toBeUndefined();
  });

  it('鉴权语义：authNotGuest → security + 401 + 403；open → 无 security/401', () => {
    const post = doc.paths['/api/v1/fixture/items'].post;
    expect(post.security).toEqual([{ bearerAuth: [] }]);
    expect(post.responses['401']).toBeDefined();
    expect(post.responses['403']).toBeDefined();
    const get = doc.paths['/api/v1/fixture/items'].get;
    expect(get.security).toBeUndefined();
    expect(get.responses['401']).toBeUndefined();
  });

  it('204 无响应体；未映射端点退化通用 { data } 壳并如实标注', () => {
    const del = doc.paths['/api/v1/fixture/items/{id}'].delete;
    expect(del.responses['204'].content).toBeUndefined();
    const get = doc.paths['/api/v1/fixture/items'].get;
    const schema = get.responses['200'].content['application/json'].schema;
    expect(schema.required).toEqual(['data']);
    expect(schema.description).toContain('统一成功壳');
  });

  it('全部 operation 带 operationId/tags/400/500；JSON 可稳定序列化', () => {
    for (const pathItem of Object.values(doc.paths)) {
      for (const op of Object.values(pathItem)) {
        expect(op.operationId).toBeTruthy();
        expect(op.tags).toEqual(['fixture']);
        expect(op.responses['400']).toBeDefined();
        expect(op.responses['500']).toBeDefined();
      }
    }
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
