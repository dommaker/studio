/**
 * openapi/build.ts — OpenAPI 3.0.3 文档装配。
 *
 * 输入 = discover.ts 的路由发现结果；schema 经本目录 convert.ts 的 zodToOpenAPISchema 转换。
 * 成功响应只读 defineRoute meta.response；无逐字段 schema 的非 204 端点必须落入
 * RESPONSELESS_ROUTE_OVERRIDES 的显式例外，清单外拒绝生成文档。
 */

import { errorBodySchema } from '@dommaker/studio-contract';
import type { z } from 'zod';
import { zodToOpenAPISchema, type OpenAPISchema } from './convert.js';
import { toOpenAPIPath, type DiscoveredRoute, type SkippedRoute } from './discover.js';

type Json = Record<string, unknown>;

const errorBody = zodToOpenAPISchema(errorBodySchema);

export interface ResponselessOverride {
  description: string;
  body: 'binary' | 'array';
}

/** 非 JSON envelope 的真实响应例外；普通业务端点不得借此绕过 response 声明。 */
export const RESPONSELESS_ROUTE_OVERRIDES: Record<string, ResponselessOverride> = {
  'GET /api/v1/channels/:id/attachments/:attachmentId': { description: '附件文件流，非 JSON envelope', body: 'binary' },
  'GET /api/v1/specs/:id/changes/export': { description: 'JSON 数组附件下载，非 envelope', body: 'array' },
  'GET /api/v1/audit-logs/export': { description: '裸 JSON 数组，非附件 envelope', body: 'array' },
};

function objectParameters(
  schema: z.ZodTypeAny | undefined,
  where: 'path' | 'query',
): Json[] {
  if (!schema) return [];
  const converted = zodToOpenAPISchema(schema);
  if (converted.type !== 'object' || !converted.properties) return [];
  const required = new Set(converted.required ?? []);
  return Object.entries(converted.properties).map(([name, prop]) => ({
    name,
    in: where,
    required: where === 'path' ? true : required.has(name),
    schema: prop,
  }));
}

function successSchema(route: DiscoveredRoute): { schema: OpenAPISchema; contentType: string } {
  if (route.meta.schema.response) {
    return { schema: zodToOpenAPISchema(route.meta.schema.response), contentType: 'application/json' };
  }
  const key = `${route.method.toUpperCase()} ${route.path}`;
  const override = RESPONSELESS_ROUTE_OVERRIDES[key];
  if (!override) throw new Error(`Missing response schema or explicit override: ${key}`);
  if (override.body === 'binary') {
    return {
      schema: { type: 'string', format: 'binary', description: override.description },
      contentType: 'application/octet-stream',
    };
  }
  return {
    schema: { type: 'array', items: {}, description: override.description },
    contentType: 'application/json',
  };
}

function operationId(route: DiscoveredRoute): string {
  const bare = route.path
    .replace(/^\/api\/v1\//, '/')
    .replace(/^\/api\//, '/internal/')
    .replace(/[/{-](\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/[}/]/g, '');
  return `${route.method}${bare.charAt(0).toUpperCase()}${bare.slice(1)}`;
}

function tagOf(mountPath: string): string {
  return mountPath.replace(/^\/api\/(v1\/)?/, '').split('/')[0] || 'root';
}

const AUTH_NOTE: Record<string, string> = {
  open: '读开放（生产 Lurk Wall 兜底；混合粒度例外面鉴权在路由内，见 registry 注释）',
  auth: '需登录（Bearer JWT；Guest 可读）',
  authNotGuest: '需登录且非 Guest（Bearer JWT）',
  admin: '需 Admin 角色（Bearer JWT）',
  localhost: '仅本机回环直连可用（无凭证；经反代一律 403）',
};

function buildOperation(route: DiscoveredRoute): Json {
  const parameters = [
    ...objectParameters(route.meta.schema.params, 'path'),
    ...objectParameters(route.meta.schema.query, 'query'),
  ];
  const responses: Json = {};

  if (route.meta.status === 204) {
    responses['204'] = { description: '成功（无响应体）' };
  } else {
    const { schema, contentType } = successSchema(route);
    responses[String(route.meta.status)] = {
      description: contentType === 'application/octet-stream'
        ? '成功（文件流）'
        : schema.type === 'array' ? '成功（裸 JSON 数组）' : '成功（统一 envelope）',
      content: { [contentType]: { schema } },
    };
  }
  for (const [status, responseSchema] of Object.entries(route.meta.responses ?? {})) {
    responses[status] = {
      description: '成功（统一 envelope）',
      content: { 'application/json': { schema: zodToOpenAPISchema(responseSchema) } },
    };
  }
  responses['400'] = {
    description: '入参校验失败（zod）',
    content: { 'application/json': { schema: errorBody } },
  };
  if (route.auth !== 'open') {
    responses[route.auth === 'localhost' ? '403' : '401'] = {
      description: route.auth === 'localhost' ? '非本机回环调用' : '未认证',
      content: { 'application/json': { schema: errorBody } },
    };
  }
  if (route.auth === 'authNotGuest' || route.auth === 'admin') {
    responses['403'] = {
      description: route.auth === 'admin' ? '非 Admin 角色' : 'Guest 无权执行',
      content: { 'application/json': { schema: errorBody } },
    };
  }
  responses['500'] = {
    description: '服务端错误',
    content: { 'application/json': { schema: errorBody } },
  };

  const descriptionParts = [AUTH_NOTE[route.auth]];
  if (route.entryComment) descriptionParts.push(`registry：${route.entryComment}`);

  const operation: Json = {
    operationId: operationId(route),
    summary: `${route.method.toUpperCase()} ${route.path}`,
    description: descriptionParts.join('\n\n'),
    tags: [tagOf(route.mountPath)],
    responses,
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (route.meta.schema.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: zodToOpenAPISchema(route.meta.schema.body) } },
    };
  }
  if (route.auth === 'auth' || route.auth === 'authNotGuest' || route.auth === 'admin') {
    operation.security = [{ bearerAuth: [] }];
  }
  return operation;
}

export interface OpenApiDocument extends Json {
  openapi: string;
  info: Json;
  paths: Record<string, Json>;
  components: Json;
}

/** 装配完整 OpenAPI 文档（确定性输出：paths 按键序排序，便于 diff/测试）。 */
export function buildOpenApiDocument(routes: DiscoveredRoute[], skipped: SkippedRoute[]): OpenApiDocument {
  const paths: Record<string, Json> = {};
  const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const route of sorted) {
    const apiPath = toOpenAPIPath(route.path);
    (paths[apiPath] ??= {})[route.method] = buildOperation(route);
  }

  const mappedCount = routes.filter(r => r.meta.schema.response || r.meta.status === 204).length;
  return {
    openapi: '3.0.3',
    info: {
      title: 'Studio API',
      version: '0.0.0-dev',
      description: [
        '由 packages/studio-contract 的 zod schema 派生（正本在 contract，本文档不手写）。',
        `覆盖 ${routes.length} 条契约驱动端点（defineRoute）：请求 params/query/body 全量准确；`,
        `成功响应逐字段 schema/204 已声明 ${mappedCount} 条；其余 ${routes.length - mappedCount} 条均由 RESPONSELESS_ROUTE_OVERRIDES 显式描述文件流或裸 JSON 数组，清单外拒绝生成文档。`,
        '协议面不进文档：discord/deploy webhook、SSE、MCP 消息面、health 运维探针（原始 handler，例外清单固化于 route-registry PROTOCOL_SURFACE_EXCEPTIONS，见 x-studio-undocumented）。',
        '统一响应壳：成功 { data }（分页 { data, pagination }），失败 { error: { code, message } }。',
      ].join('\n'),
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    'x-studio-undocumented': skipped,
  };
}
