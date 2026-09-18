/**
 * local-workspace auth 透传（#565 AC4 数据流中段）
 *
 * scanAllProviders 的三态 auth 结果须随 runtimes 记录持久化到 workspace JSON，
 * 供 GET /workspaces/runtimes 读出。STUDIO_HOME 指向临时目录，不真扫 CLI
 * （cli-scanner mock）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));

vi.mock('../../../daemon/cli-scanner.js', () => ({
  scanAllProviders: mockScan,
}));

let tmpHome = '';
let prevHome: string | undefined;
let wsDir = '';
let rescanLocalRuntimes: () => Promise<void>;

beforeAll(async () => {
  prevHome = process.env.STUDIO_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-local-ws-auth-'));
  process.env.STUDIO_HOME = tmpHome;
  const { resolveWorkspacesDir } = await import('@dommaker/studio-shared/node');
  wsDir = resolveWorkspacesDir();
  fs.mkdirSync(wsDir, { recursive: true });
  ({ rescanLocalRuntimes } = await import('../local-workspace.js'));
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of fs.readdirSync(wsDir)) fs.rmSync(path.join(wsDir, f), { recursive: true, force: true });
});

function seedVpsWorkspace(): string {
  const id = 'ws_vps';
  fs.writeFileSync(path.join(wsDir, `${id}.json`), JSON.stringify({
    id,
    name: 'VPS',
    workspaceRoot: '/seed',
    status: 'idle',
    tokenId: null,
    runtimes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  return id;
}

describe('scanLocalRuntimes auth 透传', () => {
  it('auth 三态 + hint + authCheckedAt 写入 runtimes 记录', async () => {
    const id = seedVpsWorkspace();
    mockScan.mockReturnValue([
      {
        provider: 'claude', path: '/usr/local/bin/claude', version: '2.1.273',
        auth: 'failed', authHint: '运行 claude login 重新登录', authCheckedAt: '2026-09-16T01:00:00.000Z',
      },
      {
        provider: 'kimi', path: '/bin/kimi', version: '0.38.0',
        auth: 'unknown', authCheckedAt: '2026-09-16T01:00:00.000Z',
      },
    ]);

    await rescanLocalRuntimes();

    const ws = JSON.parse(fs.readFileSync(path.join(wsDir, `${id}.json`), 'utf-8'));
    expect(ws.runtimes).toHaveLength(2);
    const claude = ws.runtimes.find((r: Record<string, unknown>) => r.provider === 'claude');
    expect(claude.auth).toBe('failed');
    expect(claude.authHint).toBe('运行 claude login 重新登录');
    expect(claude.authCheckedAt).toBe('2026-09-16T01:00:00.000Z');
    const kimi = ws.runtimes.find((r: Record<string, unknown>) => r.provider === 'kimi');
    expect(kimi.auth).toBe('unknown');
    expect(kimi.authHint).toBeUndefined();
  });
});
