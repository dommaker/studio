/**
 * audit-logs routes 注册测试 (#256)
 *
 * AC: POST /cleanup 端点下线--删除语义统一归 #213 轮转机制
 * （audit.jsonl 热 90 天 -> 月度 gzip 归档，只增不删）。
 *
 * 本测试为 #256 下线端点后的回归保护：防止后续误重新注册
 * 物理删除端点，绕过 #213「只增不删」决议。
 */
import { describe, it, expect } from 'vitest';
import router from '../routes';

interface FlatRoute { method: string; path: string }

function flattenRoutes(r: any): FlatRoute[] {
  const out: FlatRoute[] = [];
  for (const layer of r.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        out.push({ method: m.toUpperCase(), path: layer.route.path });
      }
    }
  }
  return out;
}

describe('audit-logs routes (#256: cleanup 端点下线)', () => {
  const routes = flattenRoutes(router);

  it('POST /cleanup 不再注册--物理删除路径已下线，删除语义归 #213 轮转机制', () => {
    const hasCleanup = routes.some(
      r => r.method === 'POST' && r.path === '/cleanup',
    );
    expect(hasCleanup).toBe(false);
  });

  it('其他 AR-012 端点保持注册（回归保护）', () => {
    const paths = routes.map(r => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /');
    expect(paths).toContain('GET /stats');
    expect(paths).toContain('GET /actions');
    expect(paths).toContain('GET /resources');
    expect(paths).toContain('POST /');
    expect(paths).toContain('GET /export');
  });
});
