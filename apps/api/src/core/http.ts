/**
 * core/http.ts — HTTP 边界唯一出口（docs/architecture/target-architecture.md §契约）。
 *
 * 每条路由走 defineRoute：zod 校验入参 → handler 返回业务数据 → 统一 envelope
 * （成功 `{ data }` / 分页 `{ data, pagination }` / 失败 `{ error: { code, message } }`）。
 * response 声明完整成功壳，推导 handler 返回类型；测试/开发环境校验实际响应，并供 OpenAPI 消费。
 *
 * 错误翻译顺序：HttpError → 可选映射表（字符串/RegExp/Error 类首命中）→ 500 兜底。
 * 4xx 与非生产诊断 message 直出；生产所有 5xx 只回通用 message + requestId。
 * 消灭三件套：手写 `if (!x) return 400`、`msg.includes('not found')` 散落各 handler、
 * 响应格式第三种形状。
 *
 * 与 workunit/http-helpers.ts 的关系：本文件是它的通用化上浮（#551 模式推广到全 API）；
 * workunit 域已迁移（http-helpers 删除，requireHuman 一并上浮本文件），其余模块不再各自发明错误映射。
 */

import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ERROR_CODES, type Pagination, type PaginatedBody } from '@dommaker/studio-contract';
import { getErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** 业务拒绝：自带 HTTP 语义，defineRoute 直出不查表 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ErrorMatcher = string | RegExp | (new (...args: never[]) => Error);

export interface ErrorMapping {
  match: ErrorMatcher;
  status: number;
  code: string;
}

export interface RouteSchema<
  B extends z.ZodTypeAny = z.ZodTypeAny,
  Q extends z.ZodTypeAny = z.ZodTypeAny,
  P extends z.ZodTypeAny = z.ZodTypeAny,
  R extends z.ZodTypeAny = z.ZodTypeAny,
> {
  body?: B;
  query?: Q;
  params?: P;
  /** 完整成功响应壳（{ data } 或 { data, pagination }），同时驱动 handler 类型与 OpenAPI */
  response?: R;
}

type Infer<S, F> = S extends { [K in F & keyof S]: z.ZodTypeAny } ? z.infer<S[F & keyof S]> : never;

/** handler 的第三参：校验后的入参（req.query 在 Express 5 只读，消费方一律用 input） */
export type RouteInput<S extends RouteSchema> = {
  body: Infer<S, 'body'>;
  query: Infer<S, 'query'>;
  params: Infer<S, 'params'>;
};

/** response 是 wire 壳；普通响应返回 data，分页响应返回完整 paginated() 形状。 */
export type RouteResult<S extends RouteSchema> = S extends { response: z.ZodTypeAny }
  ? z.infer<S['response']> extends { data: unknown[]; pagination: Pagination }
    ? z.infer<S['response']>
    : z.infer<S['response']> extends { data: infer D } ? D : never
  : unknown;

const ROUTE_STATUS_RESULT: unique symbol = Symbol('studio.routeStatusResult');

export interface RouteStatusResult<T> {
  readonly [ROUTE_STATUS_RESULT]: true;
  readonly status: number;
  readonly data: T;
}

/** 非默认成功分支；对应 RouteOptions.responses 的响应契约。 */
export function withStatus<T>(status: number, data: T): RouteStatusResult<T> {
  return { [ROUTE_STATUS_RESULT]: true, status, data };
}

function isRouteStatusResult<T>(value: unknown): value is RouteStatusResult<T> {
  return typeof value === 'object' && value !== null && ROUTE_STATUS_RESULT in value;
}

type RouteHandler<S extends RouteSchema> = (
  req: Request,
  res: Response,
  input: RouteInput<S>,
) => Promise<RouteResult<S> | RouteStatusResult<RouteResult<S>> | undefined>;

export interface RouteOptions {
  /** 文案/类别 → 状态码 + code 映射表（首命中生效，类匹配器先于字符串项） */
  errors?: readonly ErrorMapping[];
  /** 成功状态码，默认 200（201/204 等场景覆盖；204 时忽略返回值） */
  status?: number;
  /** withStatus 非默认成功分支的完整响应壳 */
  responses?: Readonly<Record<number, z.ZodTypeAny>>;
}

/**
 * defineRoute 挂在返回 handler 上的 schema 元数据（OpenAPI 派生用，apps/api openapi/）。
 * 非枚举 Symbol 键，不影响序列化与中间件组合行为。
 */
export const ROUTE_SCHEMA_META: unique symbol = Symbol('studio.routeSchemaMeta');
export interface RouteSchemaMeta {
  schema: RouteSchema;
  /** 成功状态码（RouteOptions.status，缺省 200；204 = 无响应体） */
  status: number;
  /** withStatus 非默认成功分支（RouteOptions.responses） */
  responses?: Readonly<Record<number, z.ZodTypeAny>>;
}

/**
 * A2A 业务 authorType 解析（body.authorType 优先，其次 x-author-type header）。
 * 仅作展示/路由元数据，不得用于授权；UI/人类调用不发送该字段 → 'human'。
 * （自 workunit/http-helpers.ts 上浮——workunit 域迁移契约驱动后，human-only 守卫
 * 与 defineRoute 同属 HTTP 边界通用件，供后续域复用。）
 */
export function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

/** Operator-only 守卫：业务 authorType 不参与授权；须在认证中间件之后挂载。 */
export function requireHuman(message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.actorType !== 'Operator') {
      res.status(403).json({ error: { code: 'FORBIDDEN', message } });
      return;
    }
    next();
  };
}

/** 构造分页返回体（defineRoute 识别后原样直出，不再包 `{ data }`） */
export function paginated<T>(items: T[], pagination: Pagination): PaginatedBody<T> {
  return { data: items, pagination };
}

/**
 * paginated() 的配套元信息助手：fields 口径与 paginated() 一致，totalPages 收敛
 * 全仓手搓 `Math.ceil(total / limit)`（P2.3，共 6 处）。刻意纯委托不 clamp：
 * 各调用方的 limit 均由 parsePagination clamp 1..100（skills 除外——其未校验
 * NaN/0 是契约注释明言保留的 #359 前旧行为，助手不得改变）；limit=0 时
 * 原样透出 Math.ceil(total/0)=Infinity，与该 6 处收敛前输出一致。
 */
export function makePagination(page: number, limit: number, total: number): Pagination {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

function isPaginatedBody(value: unknown): value is PaginatedBody<unknown> {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as PaginatedBody<unknown>).data)
    && typeof (value as PaginatedBody<unknown>).pagination === 'object';
}

function sendProduction5xx(req: Request, res: Response, error: unknown, status: number, code: string): void {
  const header = req.headers['x-request-id'];
  const requestId = (req as any).requestId
    || (typeof header === 'string' && header.trim())
    || randomUUID();
  (req as any).requestId = requestId;
  logger.error({ error, requestId }, 'defineRoute: unhandled error');
  res.status(status).json({ error: { code, message: 'Internal server error', requestId } });
}

function sendMappedError(req: Request, res: Response, error: unknown, mappings: readonly ErrorMapping[]): void {
  const production = process.env.NODE_ENV === 'production';
  if (error instanceof HttpError) {
    if (production && error.status >= 500) {
      sendProduction5xx(req, res, error, error.status, error.code);
      return;
    }
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  const msg = getErrorMessage(error);
  for (const m of mappings) {
    const hit = typeof m.match === 'string'
      ? msg.includes(m.match)
      : m.match instanceof RegExp
        ? m.match.test(msg)
        : error instanceof m.match;
    if (hit) {
      if (production && m.status >= 500) {
        sendProduction5xx(req, res, error, m.status, m.code);
        return;
      }
      res.status(m.status).json({ error: { code: m.code, message: msg } });
      return;
    }
  }
  if (!production) {
    logger.error({ error }, 'defineRoute: unhandled error');
    res.status(500).json({ error: { code: ERROR_CODES.INTERNAL, message: msg } });
    return;
  }
  sendProduction5xx(req, res, error, 500, ERROR_CODES.INTERNAL);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * 定义一条契约路由。handler 写快乐路径：返回业务数据（自动包 `{ data }`）、
 * 返回 paginated()（直出分页壳）、withStatus()（非默认成功分支，使用 options.responses
 * 对应的 schema 校验并进入 OpenAPI）、返回 undefined（204 或 handler 已自行写 res，
 * 如 SSE/文件流——属于例外路径，新代码优先让 defineRoute 代写）。
 */
export function defineRoute<S extends RouteSchema>(
  schema: S,
  options: RouteOptions | RouteHandler<S>,
  handler?: RouteHandler<S>,
) {
  const opts: RouteOptions = typeof options === 'function' ? {} : options;
  const fn = (typeof options === 'function' ? options : handler)!;

  const wrapped = async (req: Request, res: Response): Promise<void> => {
    try {
      const input = {
        params: schema.params ? schema.params.parse(req.params) : req.params,
        query: schema.query ? schema.query.parse(req.query) : req.query,
        body: schema.body ? schema.body.parse(req.body) : req.body,
      } as RouteInput<S>;
      if (schema.body) req.body = input.body;

      const result = await fn(req, res, input);
      if (res.headersSent) return;
      const defaultStatus = opts.status ?? 200;
      const status = isRouteStatusResult(result) ? result.status : defaultStatus;
      const value = isRouteStatusResult(result) ? result.data : result;
      if (status === 204 || value === undefined) {
        res.status(status === 204 ? 204 : 200).end();
        return;
      }
      const responseSchema = isRouteStatusResult(result) && status !== defaultStatus
        ? opts.responses?.[status]
        : schema.response;
      if (isRouteStatusResult(result) && !responseSchema) {
        throw new Error(`Missing response schema for withStatus(${status})`);
      }
      const body = isPaginatedBody(value) ? value : { data: value };
      if (responseSchema && process.env.NODE_ENV !== 'production') {
        const parsed = responseSchema.safeParse(body);
        if (!parsed.success) {
          throw new Error(`Invalid defineRoute response: ${formatZodError(parsed.error)}`);
        }
      }
      res.status(status).json(body);
    } catch (error) {
      if (res.headersSent) {
        logger.error({ error }, 'defineRoute: error after response sent');
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: { code: ERROR_CODES.BAD_REQUEST, message: formatZodError(error) },
        });
        return;
      }
      sendMappedError(req, res, error, opts.errors ?? []);
    }
  };
  // OpenAPI 派生：schema/成功状态码随 handler 走，openapi/discover.ts 从路由栈读回
  const meta: RouteSchemaMeta = { schema, status: opts.status ?? 200, responses: opts.responses };
  Object.defineProperty(wrapped, ROUTE_SCHEMA_META, { value: meta });
  return wrapped;
}
