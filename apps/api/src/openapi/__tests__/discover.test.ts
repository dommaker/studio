/**
 * discover.ts 单元测试：toOpenAPIPath 转换 + probeNestedMount 嵌套挂载判别
 * （根挂载探测 / hint 签名匹配 / 未识别回退 null）。不建路由表，纯轻量。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { toOpenAPIPath, probeNestedMount } from '../discover.js';

describe('toOpenAPIPath', () => {
  it('Express 路径参数 → OpenAPI 大括号参数', () => {
    expect(toOpenAPIPath('/api/v1/workunits')).toBe('/api/v1/workunits');
    expect(toOpenAPIPath('/api/v1/workunits/:id')).toBe('/api/v1/workunits/{id}');
    expect(toOpenAPIPath('/a/:b/c/:d')).toBe('/a/{b}/c/{d}');
    expect(toOpenAPIPath('/api/v1/library/*splat')).toBe('/api/v1/library/*splat');
  });
});

describe('probeNestedMount', () => {
  /** 造一个 root 挂载 layer：router.use(sub) */
  function rootMountLayer() {
    const router = express.Router();
    const sub = express.Router();
    sub.get('/x', () => undefined);
    router.use(sub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (router as any).stack.find((l: any) => l.handle?.stack);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { layer, subRouter: sub as any };
  }

  it('根挂载（router.use(sub)，matcher 仅命中 /）→ 前缀不变', () => {
    const { layer, subRouter } = rootMountLayer();
    expect(probeNestedMount(layer, subRouter, '/api/v1/harness')).toBe('/');
  });

  it('静态路径挂载命中 hint 签名（mcp /admin：子路由首 route = /tools）→ 还原子路径', () => {
    const router = express.Router();
    const sub = express.Router();
    sub.get('/tools', () => undefined);
    router.use('/admin', sub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (router as any).stack.find((l: any) => l.handle?.stack);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(probeNestedMount(layer, sub as any, '/api/v1/mcp')).toBe('/admin');
  });

  it('静态路径挂载无 hint（签名不符）→ null（不猜）', () => {
    const router = express.Router();
    const sub = express.Router();
    sub.get('/unknown', () => undefined);
    router.use('/secret', sub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (router as any).stack.find((l: any) => l.handle?.stack);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(probeNestedMount(layer, sub as any, '/api/v1/mcp')).toBeNull();
  });
});
