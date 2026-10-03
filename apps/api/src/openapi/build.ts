/**
 * openapi/build.ts — OpenAPI 3.0.3 文档装配。
 *
 * 输入 = discover.ts 的路由发现结果；schema 经 contract 的 zodToOpenAPISchema 转换。
 * 成功响应 schema 的映射在 response-map.ts（contract 的 xxxResponseSchema 逐端点挂上）；
 * 未映射端点退化为通用 `{ data }` 壳并在 description 如实标注——映射覆盖面扩域时只动
 * response-map.ts，测试锁定「映射键 ⊆ 真实路由」防漂移。
 */

import { zodToOpenAPISchema, errorBodySchema, type OpenAPISchema } from '@dommaker/studio-contract';
import type { z } from 'zod';
import { RESPONSE_MAP } from './response-map.js';
import { toOpenAPIPath, type DiscoveredRoute, type SkippedRoute } from './discover.js';

type Json = Record<string, unknown>;

const errorBody = zodToOpenAPISchema(errorBodySchema);

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

function successSchema(route: DiscoveredRoute): { schema: OpenAPISchema; mapped: boolean } {
  const hit = RESPONSE_MAP[`${route.method.toUpperCase()} ${route.path}`];
  if (hit?.response) return { schema: zodToOpenAPISchema(hit.response), mapped: true };
  // 通用壳：defineRoute 语义保证成功体 = { data }（分页 { data, pagination } 由映射覆盖）
  return {
    schema: {
      type: 'object',
      properties: { data: {} },
      required: ['data'],
      description: '统一成功壳 { data }；该端点逐字段响应 schema 见 packages/studio-contract 对应域文件（尚未接入 response-map）',
    },
    mapped: false,
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
  const mapped = RESPONSE_MAP[`${route.method.toUpperCase()} ${route.path}`];

  if (route.meta.status === 204) {
    responses['204'] = { description: '成功（无响应体）' };
  } else {
    const { schema } = successSchema(route);
    responses[String(route.meta.status)] = {
      description: '成功（统一 envelope）',
      content: { 'application/json': { schema } },
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
  if (mapped?.description) descriptionParts.push(mapped.description);
  if (route.entryComment) descriptionParts.push(`registry：${route.entryComment}`);

  const operation: Json = {
    operationId: operationId(route),
    summary: mapped?.summary ?? `${route.method.toUpperCase()} ${route.path}`,
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

  const mappedCount = routes.filter(r => RESPONSE_MAP[`${r.method.toUpperCase()} ${r.path}`]?.response).length;
  return {
    openapi: '3.0.3',
    info: {
      title: 'Studio API',
      version: '0.0.0-dev',
      description: [
        '由 packages/studio-contract 的 zod schema 派生（正本在 contract，本文档不手写）。',
        `覆盖 ${routes.length} 条契约驱动端点（defineRoute）：请求 params/query/body 全量准确；`,
        `成功响应逐字段 schema 已映射 ${mappedCount} 条，其余为通用 { data } 壳（映射增量补齐中）。`,
        '协议面不进文档：discord/deploy webhook、lark/dingtalk 回调、SSE、MCP 消息面（原始 handler，见 x-studio-undocumented）。',
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
