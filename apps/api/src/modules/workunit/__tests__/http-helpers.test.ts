// #551：routes 错误契约收口单测——一张映射表（WORKUNIT_ERROR_MAPS）覆盖全部端点。
// 文案 ↔ 状态码解耦的契约点：状态码只由表项决定，sendMappedError 是唯一翻译出口。
import { describe, it, expect, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  HttpRouteError,
  WORKUNIT_ERROR_MAPS,
  sendMappedError,
  route,
  resolveCallerAuthorType,
  requireHuman,
  type ErrorMapping,
} from '../http-helpers.js';
import { ConfirmPayloadError } from '../confirm-payload.js';
import { PlanRulingError } from '../../pmo/plan-ruling.js';

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function mockReq(init?: { body?: unknown; headers?: Record<string, string> }): Request {
  return { body: init?.body, headers: init?.headers ?? {} } as unknown as Request;
}

describe('sendMappedError（#551 统一翻译层）', () => {
  it('HttpRouteError → 自带 status/code/message 直出，不查表', () => {
    const res = mockRes();
    sendMappedError(res, new HttpRouteError(409, 'NOT_BLOCKED', 'WorkUnit 当前状态为 active'), []);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: 'NOT_BLOCKED', message: 'WorkUnit 当前状态为 active' } });
  });

  it('未命中任何表项 → 500 INTERNAL_ERROR，message 取 getErrorMessage', () => {
    const res = mockRes();
    sendMappedError(res, new Error('totally unexpected'), WORKUNIT_ERROR_MAPS.update);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'totally unexpected' } });
  });

  it('非 Error 抛出 → message 兜底 Unknown error', () => {
    const res = mockRes();
    sendMappedError(res, 42, []);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Unknown error' } });
  });

  // 全端点映射表逐条覆盖：字符串匹配器用自身作 message 必命中（includes 自反），
  // Error 类匹配器实例化必命中（instanceof）。每张表、每个表项都过一遍翻译出口。
  const classSamples: ReadonlyMap<unknown, Error> = new Map<unknown, Error>([
    [ConfirmPayloadError, new ConfirmPayloadError('confirm bad')],
    [PlanRulingError, new PlanRulingError('ruling bad')],
  ]);

  for (const [endpoint, mappings] of Object.entries(WORKUNIT_ERROR_MAPS)) {
    describe(`端点映射表: ${endpoint}`, () => {
      for (const mapping of mappings as readonly ErrorMapping[]) {
        const label = typeof mapping.match === 'string' ? `'${mapping.match}'` : String(mapping.match);
        it(`${label} → ${mapping.status} ${mapping.code}`, () => {
          const err = typeof mapping.match === 'string'
            ? new Error(mapping.match)
            : classSamples.get(mapping.match);
          expect(err, `缺少类匹配器 ${label} 的样例`).toBeDefined();
          const res = mockRes();
          sendMappedError(res, err, mappings);
          expect(res.statusCode).toBe(mapping.status);
          expect(res.body).toEqual({ error: { code: mapping.code, message: (err as Error).message } });
        });
      }
    });
  }

  it('表项按声明顺序优先（reviewPassed：ConfirmPayloadError 先于字符串项判定）', () => {
    const res = mockRes();
    sendMappedError(res, new ConfirmPayloadError('not found in payload'), WORKUNIT_ERROR_MAPS.reviewPassed);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_CONFIRM', message: 'not found in payload' } });
  });
});

describe('route() 包装器', () => {
  it('handler 正常返回 → 不干预响应', async () => {
    const res = mockRes();
    const handler = route([], async (_req, r) => {
      r.json({ ok: true });
    });
    await handler(mockReq(), res);
    expect(res.body).toEqual({ ok: true });
  });

  it('handler 抛错 → 经映射表翻译', async () => {
    const res = mockRes();
    const handler = route(WORKUNIT_ERROR_MAPS.update, async () => {
      throw new Error('WorkUnit wu-1 not found');
    });
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'WorkUnit wu-1 not found' } });
  });
});

describe('resolveCallerAuthorType / requireHuman（#551 human-only 中间件）', () => {
  it('body.authorType 优先；其次 x-author-type header；缺省 human', () => {
    expect(resolveCallerAuthorType(mockReq({ body: { authorType: 'agent' }, headers: { 'x-author-type': 'human' } }))).toBe('agent');
    expect(resolveCallerAuthorType(mockReq({ headers: { 'x-author-type': 'agent' } }))).toBe('agent');
    expect(resolveCallerAuthorType(mockReq())).toBe('human');
    expect(resolveCallerAuthorType(mockReq({ body: { authorType: 123 } }))).toBe('human');
  });

  it('requireHuman：agent → 403 FORBIDDEN + 定制 message，next 不调', () => {
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireHuman('Review actions are human-only (authorType=agent rejected)')(
      mockReq({ body: { authorType: 'agent' } }), res, next,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'Review actions are human-only (authorType=agent rejected)' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireHuman：human/缺省 → next()，不写响应', () => {
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireHuman('x')(mockReq(), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });
});
