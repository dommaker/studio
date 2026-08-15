// library 路由测试 — #155 T5（service 层 mock，验证 HTTP 形状与只读面）
// 风格同 companies/__tests__/routes.test.ts：挂载真实 router 起 HTTP 服务，fetch 验证。
import { describe, it, expect, vi, beforeAll, afterAll, type Mock } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mockListLibraryDocs = vi.fn() as Mock;
const mockGetLibraryDoc = vi.fn() as Mock;

vi.mock('../library.service.js', () => ({
  listLibraryDocs: (...args: unknown[]) => mockListLibraryDocs(...args),
  getLibraryDoc: (...args: unknown[]) => mockGetLibraryDoc(...args),
}));

let server: Server;
let base: string;

async function req(method: string, p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1/library${p}`, { method });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  const { libraryRoutes } = await import('../library.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/library', libraryRoutes);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe('library routes', () => {
  it('GET / 透传 project/search query 并返回列表', async () => {
    mockListLibraryDocs.mockResolvedValue([{ id: 'proj-a:specs/a.md', title: 'A' }]);

    const { status, json } = await req('GET', '/?project=proj-a&search=foo');
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([{ id: 'proj-a:specs/a.md', title: 'A' }]);
    expect(mockListLibraryDocs).toHaveBeenCalledWith({ projectId: 'proj-a', search: 'foo' });
  });

  it('GET /:id 命中返回详情；id 整段 encodeURIComponent（含 / 与 :）', async () => {
    mockGetLibraryDoc.mockResolvedValue({ id: 'proj-a:specs/a.md', content: '正文' });

    const { status, json } = await req('GET', `/${encodeURIComponent('proj-a:specs/a.md')}`);
    expect(status).toBe(200);
    expect(json.data.content).toBe('正文');
    expect(mockGetLibraryDoc).toHaveBeenCalledWith('proj-a:specs/a.md');
  });

  it('GET /:id 未命中返回 404', async () => {
    mockGetLibraryDoc.mockResolvedValue(null);

    const { status, json } = await req('GET', `/${encodeURIComponent('proj-x:specs/no.md')}`);
    expect(status).toBe(404);
    expect(json.success).toBe(false);
  });

  it('只读面：无 PUT/POST/DELETE', async () => {
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await fetch(`${base}/api/v1/library/${encodeURIComponent('proj-a:specs/a.md')}`, { method });
      expect(res.status).toBe(404);
    }
  });
});
