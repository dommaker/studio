/**
 * core/http.ts — HTTP 边界唯一出口（docs/architecture/target-architecture.md §契约）。
 *
 * 每条路由走 defineRoute：zod 校验入参 → handler 返回业务数据 → 统一 envelope
 * （成功 `{ data }` / 分页 `{ data, pagination }` / 失败 `{ error: { code, message } }`）。
 *
 * 错误翻译顺序：HttpError 直出 → 可选映射表（字符串/RegExp/Error 类首命中）→ 500 兜底。
 * 消灭三件套：手写 `if (!x) return 400`、`msg.includes('not found')` 散落各 handler、
 * 响应格式第三种形状。
 *
 * 与 workunit/http-helpers.ts 的关系：本文件是它的通用化上浮（#551 模式推广到全 API）；
 * workunit 域已迁移（http-helpers 删除，requireHuman 一并上浮本文件），其余模块不再各自发明错误映射。
 */

import type { NextFunction, Request, Response } from 'express';
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
> {
  body?: B;
  query?: Q;
  params?: P;
}

type Infer<S, F> = S extends { [K in F & keyof S]: z.ZodTypeAny } ? z.infer<S[F & keyof S]> : never;

/** handler 的第三参：校验后的入参（req.query 在 Express 5 只读，消费方一律用 input） */
export type RouteInput<S extends RouteSchema> = {
  body: Infer<S, 'body'>;
  query: Infer<S, 'query'>;
  params: Infer<S, 'params'>;
};

export interface RouteOptions {
  /** 文案/类别 → 状态码 + code 映射表（首命中生效，类匹配器先于字符串项） */
  errors?: readonly ErrorMapping[];
  /** 成功状态码，默认 200（201/204 等场景覆盖；204 时忽略返回值） */
  status?: number;
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
}

/**
 * A2A §4.4: 调用方 authorType 识别（body.authorType 优先，其次 x-author-type header）。
 * 与讨论空间发帖的 authorType 字段同约定；UI/人类调用不发送该字段 → 'human'。
 * （自 workunit/http-helpers.ts 上浮——workunit 域迁移契约驱动后，human-only 守卫
 * 与 defineRoute 同属 HTTP 边界通用件，供后续域复用。）
 */
export function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

/**
 * A2A §4.4-2 / §8-Q3 human-only 守卫：agent 身份调用一律 403（验收权只在人）；
 * message 按端点动作定制。须在 defineRoute 之前挂载（读原始 body）。
 */
export function requireHuman(message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (resolveCallerAuthorType(req) === 'agent') {
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

function isPaginatedBody(value: unknown): value is PaginatedBody<unknown> {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as PaginatedBody<unknown>).data)
    && typeof (value as PaginatedBody<unknown>).pagination === 'object';
}

function sendMappedError(res: Response, error: unknown, mappings: readonly ErrorMapping[]): void {
  if (error instanceof HttpError) {
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
      res.status(m.status).json({ error: { code: m.code, message: msg } });
      return;
    }
  }
  logger.error({ error }, 'defineRoute: unhandled error');
  res.status(500).json({ error: { code: ERROR_CODES.INTERNAL, message: msg } });
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * 定义一条契约路由。handler 写快乐路径：返回业务数据（自动包 `{ data }`）、
 * 返回 paginated()（直出分页壳）、返回 undefined（204 或 handler 已自行写 res，
 * 如 SSE/文件流——属于例外路径，新代码优先让 defineRoute 代写）。
 */
export function defineRoute<S extends RouteSchema>(
  schema: S,
  options: RouteOptions | ((req: Request, res: Response, input: RouteInput<S>) => Promise<unknown>),
  handler?: (req: Request, res: Response, input: RouteInput<S>) => Promise<unknown>,
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
      const status = opts.status ?? 200;
      if (status === 204 || result === undefined) {
        res.status(status === 204 ? 204 : 200).end();
        return;
      }
      res.status(status).json(isPaginatedBody(result) ? result : { data: result });
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
      sendMappedError(res, error, opts.errors ?? []);
    }
  };
  // OpenAPI 派生：schema/成功状态码随 handler 走，openapi/discover.ts 从路由栈读回
  const meta: RouteSchemaMeta = { schema, status: opts.status ?? 200 };
  Object.defineProperty(wrapped, ROUTE_SCHEMA_META, { value: meta });
  return wrapped;
}
