/**
 * #551：workunit 路由层 HTTP 助手——错误契约收口唯一正本。
 *
 * 此前 20 个 handler 各自 try/catch + `msg.includes(...)` 映射状态码（service 改一句
 * 措辞就打穿全部端点）。现收口为一张映射表（WORKUNIT_ERROR_MAPS，覆盖全部端点）+
 * 唯一翻译出口（sendMappedError）：handler 只抛错，文案 ↔ 状态码的对应关系只在表内。
 *
 * 匹配器三态：字符串（message includes）/ RegExp / Error 类（instanceof）。
 * 路由内可预期的业务拒绝（404/409 前置守卫）直接抛 HttpRouteError，绕过查表。
 *
 * 开放问题定夺（grilling 议题「service 抛带类别的错 vs 统一翻译层」，#551 守夜会话无人
 * 可 grilling）：取统一翻译层——service 错误形态零改动、行为零漂移，文案↔状态码解耦
 * 由映射表单点承载；若日后 service 引入分类错误，表内类匹配器原位替换即可。
 */

import type { NextFunction, Request, Response } from 'express';
import { getErrorMessage } from '../../utils/errors.js';
import { ConfirmPayloadError } from './confirm-payload.js';
import { PlanRulingError } from '../pmo/plan-ruling.js';
import { PlanDirectionError } from '../pmo/plan-direction.js';

/** 路由内可预期的业务拒绝：自带 HTTP 语义，翻译层直出不查表 */
export class HttpRouteError extends Error {
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

/**
 * 全部端点的「错误文案/类别 → 状态码 + code」映射表（一张表，单测逐条覆盖）。
 * 表项按声明顺序首个命中生效——类匹配器须先于可能误吞的字符串项（对照原 handler
 * 的 instanceof 优先判断）。空表 = 一律 500（错误一律意外，如 GET 只读端点）。
 */
export const WORKUNIT_ERROR_MAPS = {
  fromMessage: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
    { match: 'already linked', status: 409, code: 'ALREADY_CONVERTED' },
  ],
  update: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
  ],
  deleteWu: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
    { match: 'Record to delete does not exist', status: 404, code: 'NOT_FOUND' },
  ],
  opportunity: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
    { match: 'already resolved', status: 409, code: 'INVALID_STATE' },
    { match: 'not an inspection', status: 409, code: 'INVALID_STATE' },
  ],
  claim: [
    { match: 'Claim failed', status: 409, code: 'CLAIM_FAILED' },
  ],
  unclaim: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
  ],
  reviewPassed: [
    { match: ConfirmPayloadError, status: 400, code: 'INVALID_CONFIRM' },
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
    { match: 'Cannot review', status: 400, code: 'INVALID_TRANSITION' },
  ],
  reviewRejected: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
    { match: 'Cannot review', status: 400, code: 'INVALID_TRANSITION' },
  ],
  dispatchReview: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
    { match: 'already', status: 409, code: 'ALREADY_SATISFIED' },
    { match: 'Cannot dispatch', status: 400, code: 'INVALID_INPUT' },
    { match: 'not reviewable', status: 400, code: 'INVALID_INPUT' },
    { match: 'no channel', status: 400, code: 'INVALID_INPUT' },
  ],
  status: [
    { match: 'Invalid status transition', status: 400, code: 'INVALID_TRANSITION' },
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
  ],
  ruling: [
    { match: PlanRulingError, status: 400, code: 'INVALID_RULING' },
  ],
  direction: [
    { match: PlanDirectionError, status: 400, code: 'INVALID_DIRECTION' },
  ],
  editMessage: [
    { match: 'not found', status: 404, code: 'NOT_FOUND' },
  ],
} as const satisfies Record<string, readonly ErrorMapping[]>;

/** 唯一翻译出口：HttpRouteError 直出 → 表项首命中 → 500 兜底 */
export function sendMappedError(res: Response, error: unknown, mappings: readonly ErrorMapping[]): void {
  if (error instanceof HttpRouteError) {
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
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } });
}

/** handler 包装器：业务写快乐路径并抛错，catch 全部经 sendMappedError 一处翻译 */
export function route(
  mappings: readonly ErrorMapping[],
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      sendMappedError(res, error, mappings);
    }
  };
}

/**
 * A2A §4.4: 调用方 authorType 识别（body.authorType 优先，其次 x-author-type header）。
 * 与讨论空间发帖的 authorType 字段同约定；UI/人类调用不发送该字段 → 'human'。
 */
export function resolveCallerAuthorType(req: Request): string {
  const fromBody = typeof req.body?.authorType === 'string' ? req.body.authorType : undefined;
  const fromHeader = req.headers['x-author-type'];
  return fromBody ?? (typeof fromHeader === 'string' ? fromHeader : 'human');
}

/**
 * A2A §4.4-2 / §8-Q3 human-only 守卫（#551：4 处复制收敛为中间件）。
 * agent 身份调用一律 403（验收权只在人）；message 按端点动作定制（沿用原文案）。
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
