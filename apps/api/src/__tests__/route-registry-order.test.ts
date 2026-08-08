/**
 * route-registry 顺序断言测试（工单 32）。
 *
 * 覆盖 assertRouteOrder 的 fail-fast 语义：顺序正确放行、
 * 顺序颠倒抛错、注册项缺失抛错。用真实 express Router 实例做身份匹配，
 * 不触达 buildRouteTable 的全量动态 import（避免 40+ 模块副作用）。
 */
import { describe, it, expect } from 'vitest';
import { Router } from 'express';
import { assertRouteOrder, type RouteEntry, type RouteOrderConstraint } from '../route-registry.js';

const reason = '测试约束原因';

function makeConstraint(before: Router, after: Router): RouteOrderConstraint {
  return {
    before: { path: '/api/v1/x', router: before },
    after: { path: '/api/v1/x', router: after },
    reason,
  };
}

describe('assertRouteOrder', () => {
  it('顺序正确时放行（同 path 双挂载按 router 身份区分）', () => {
    const before = Router();
    const after = Router();
    const table: RouteEntry[] = [
      { path: '/api/v1/x', router: before },
      { path: '/api/v1/other', router: Router() },
      { path: '/api/v1/x', router: after },
    ];
    expect(() => assertRouteOrder(table, [makeConstraint(before, after)])).not.toThrow();
  });

  it('顺序颠倒时抛错（fail-fast），报错含路径与原因', () => {
    const before = Router();
    const after = Router();
    const table: RouteEntry[] = [
      { path: '/api/v1/x', router: after },
      { path: '/api/v1/x', router: before },
    ];
    expect(() => assertRouteOrder(table, [makeConstraint(before, after)]))
      .toThrowError(/注册顺序错误.*\/api\/v1\/x.*测试约束原因/s);
  });

  it('注册项缺失时抛错并指出缺失侧', () => {
    const before = Router();
    const after = Router();
    const table: RouteEntry[] = [{ path: '/api/v1/x', router: before }];
    expect(() => assertRouteOrder(table, [makeConstraint(before, after)]))
      .toThrowError(/顺序断言失败：注册项缺失/);
  });

  it('path 相同但 router 不是同一实例时视为缺失', () => {
    const before = Router();
    const table: RouteEntry[] = [
      { path: '/api/v1/x', router: Router() },
      { path: '/api/v1/x', router: Router() },
    ];
    expect(() => assertRouteOrder(table, [makeConstraint(before, Router())]))
      .toThrowError(/注册项缺失/);
  });
});
