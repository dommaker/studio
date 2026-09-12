/**
 * GET /workspaces/runtimes 只报本机 CLI 清单（远程节点方向已放弃，bdaf0dd3 2026-08-04）。
 *
 * 原语义「聚合所有 workspace 的 runtimes」是远程节点时代的产物：多节点执行已无活路径，
 * 死节点的记录会永久污染角色创建候选列表（生产实测：2026-07-18 的 offline 幽灵节点
 * 其 runtimes 仍在弹框里可勾选）。收敛后：
 *   - 数据源 = resolveVpsWorkspace()（name='VPS' 且无 tokenId 的本机记录）
 *   - 响应项 = { provider, version }，无 nodeId / workspaceName（节点概念不再存在）
 * rescanLocalRuntimes mock 为 spy，测试自己摆数据，不真扫 CLI。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockRescan } = vi.hoisted(() => ({ mockRescan: vi.fn(async () => {}) }));

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  requireAdmin: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));

vi.mock('../local-workspace.js', () => ({ rescanLocalRuntimes: mockRescan }));

let tmpHome = '';
let prevHome: string | undefined;
let server: Server;
let baseUrl = '';
let wsDir = '';

interface Seed {
  id: string;
  name: string;
  status?: string;
  tokenId?: string | null;
  runtimes: Array<Record<string, unknown>>;
}

function seedWorkspace(s: Seed): void {
  fs.writeFileSync(path.join(wsDir, `${s.id}.json`), JSON.stringify({
    id: s.id,
    name: s.name,
    workspaceRoot: '/seed',
    status: s.status ?? 'idle',
    tokenId: s.tokenId ?? null,
    runtimes: s.runtimes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

async function getRuntimes(): Promise<{ status: number; body: { runtimes: Array<Record<string, unknown>> } }> {
  const res = await fetch(baseUrl);
  return { status: res.status, body: await res.json() as { runtimes: Array<Record<string, unknown>> } };
}

beforeAll(async () => {
  prevHome = process.env.STUDIO_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ws-runtimes-local-'));
  process.env.STUDIO_HOME = tmpHome;
  const { resolveWorkspacesDir } = await import('@dommaker/studio-shared/node');
  wsDir = resolveWorkspacesDir();
  fs.mkdirSync(wsDir, { recursive: true });

  const { default: workspaceRoutes } = await import('../workspace.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workspaces', workspaceRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/runtimes`;
});

afterAll(async () => {
  server?.close();
  if (prevHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { clearCache } = await import('../../../middleware/api-cache.js');
  await clearCache('');
  for (const f of fs.readdirSync(wsDir)) fs.rmSync(path.join(wsDir, f), { recursive: true, force: true });
});

describe('GET /workspaces/runtimes — 本机 CLI 清单', () => {
  it('返回本机 VPS 的 provider + version，不带 nodeId / workspaceName', async () => {
    seedWorkspace({
      id: 'ws_vps', name: 'VPS',
      runtimes: [
        { id: 'ws_vps_claude', provider: 'claude', version: '2.1.80', path: '/usr/local/bin/claude', status: 'online' },
        { id: 'ws_vps_kimi', provider: 'kimi', version: '0.31.0', path: '/bin/kimi', status: 'online' },
      ],
    });

    const { status, body } = await getRuntimes();
    expect(status).toBe(200);
    expect(body.runtimes).toEqual([
      { provider: 'claude', version: '2.1.80' },
      { provider: 'kimi', version: '0.31.0' },
    ]);
  });

  it('历史/远程节点的 runtimes 不再出现在响应里（幽灵节点不污染角色候选）', async () => {
    seedWorkspace({
      id: 'ws_vps', name: 'VPS',
      runtimes: [{ id: 'r1', provider: 'claude', version: '2.1.80' }],
    });
    // 已废弃的 daemon 注册记录：offline、另一台机器的 CLI（其中 codex 本机没装）
    seedWorkspace({
      id: 'ws_ghost', name: 'VM-0-5-ubuntu', status: 'offline',
      runtimes: [
        { id: 'r2', provider: 'codex', version: null },
        { id: 'r3', provider: 'openclaw', version: null },
      ],
    });

    const { body } = await getRuntimes();
    expect(body.runtimes.map(r => r.provider)).toEqual(['claude']);
  });

  it('绑过 token 的同名记录不算本机（与 resolveVpsWorkspace 判定一致）', async () => {
    seedWorkspace({
      id: 'ws_tok', name: 'VPS', tokenId: 'wt_1',
      runtimes: [{ id: 'r1', provider: 'codex', version: '0.1' }],
    });

    const { body } = await getRuntimes();
    expect(body.runtimes).toEqual([]);
  });

  it('本机记录缺失 → 空清单（不报错，前端回退全量可选）', async () => {
    seedWorkspace({
      id: 'ws_other', name: 'somewhere-else',
      runtimes: [{ id: 'r1', provider: 'claude', version: '1.0' }],
    });

    const { status, body } = await getRuntimes();
    expect(status).toBe(200);
    expect(body.runtimes).toEqual([]);
  });

  it('请求前仍先重扫本机（best-effort 新鲜度语义不回归），扫失败不阻断', async () => {
    seedWorkspace({
      id: 'ws_vps', name: 'VPS',
      runtimes: [{ id: 'r1', provider: 'kimi', version: '0.31.0' }],
    });

    mockRescan.mockRejectedValueOnce(new Error('scan boom'));
    const res1 = await getRuntimes();
    expect(res1.status).toBe(200);
    expect(res1.body.runtimes).toEqual([{ provider: 'kimi', version: '0.31.0' }]);
    expect(mockRescan).toHaveBeenCalledTimes(1);
  });
});
