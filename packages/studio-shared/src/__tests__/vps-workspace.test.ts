/**
 * resolveVpsWorkspace — 'VPS' 命名约定唯一属主的行为测试
 *
 * Strategy: 真实 fs + tmpdir fixture（workspacesDir 注入点），不碰 homedir。
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveVpsWorkspace, resolveWorkspacesDir } from '../vps-workspace.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => fs.rm(d, recursiveForce)));
});
const recursiveForce = { recursive: true, force: true } as const;

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-ws-'));
  tmpDirs.push(dir);
  return dir;
}

async function writeRecord(dir: string, id: string, data: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(data), 'utf-8');
}

describe('resolveVpsWorkspace()', () => {
  test('returns the VPS record (name=VPS, no tokenId)', async () => {
    const dir = await makeDir();
    await writeRecord(dir, 'ws-1', { id: 'ws-1', name: 'VPS', workspaceRoot: '/vps/root', updatedAt: '2026-01-01T00:00:00Z' });

    const ws = await resolveVpsWorkspace({ workspacesDir: dir });

    expect(ws?.id).toBe('ws-1');
    expect(ws?.workspaceRoot).toBe('/vps/root');
  });

  test('ignores records with a different name', async () => {
    const dir = await makeDir();
    await writeRecord(dir, 'ws-1', { id: 'ws-1', name: 'remote-node', workspaceRoot: '/other' });

    expect(await resolveVpsWorkspace({ workspacesDir: dir })).toBeNull();
  });

  test('ignores token-bound VPS records (remote daemon registrations)', async () => {
    const dir = await makeDir();
    await writeRecord(dir, 'ws-1', { id: 'ws-1', name: 'VPS', tokenId: 'tok-1', workspaceRoot: '/remote' });

    expect(await resolveVpsWorkspace({ workspacesDir: dir })).toBeNull();
  });

  test('multiple matches → latest updatedAt wins', async () => {
    const dir = await makeDir();
    await writeRecord(dir, 'ws-old', { id: 'ws-old', name: 'VPS', workspaceRoot: '/old', updatedAt: '2026-01-01T00:00:00Z' });
    await writeRecord(dir, 'ws-new', { id: 'ws-new', name: 'VPS', workspaceRoot: '/new', updatedAt: '2026-06-01T00:00:00Z' });

    const ws = await resolveVpsWorkspace({ workspacesDir: dir });

    expect(ws?.id).toBe('ws-new');
  });

  test('returns null when dir does not exist', async () => {
    expect(await resolveVpsWorkspace({ workspacesDir: '/nonexistent/vps-ws-dir' })).toBeNull();
  });

  test('skips non-json files, subdirectories and corrupt records', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a workspace', 'utf-8');
    await fs.mkdir(path.join(dir, 'ws-dir.json'));
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf-8');
    await writeRecord(dir, 'ws-1', { id: 'ws-1', name: 'VPS', workspaceRoot: '/vps/root' });

    const ws = await resolveVpsWorkspace({ workspacesDir: dir });

    expect(ws?.id).toBe('ws-1');
  });

  test('defaults to ~/.studio/workspaces when no dir injected', () => {
    // #219 setup 把 STUDIO_HOME 钉到隔离根，studioPath() 走 env 优先；
    // 本用例测的是缺省回退，临时摘除 env，finally 恢复。
    const savedStudioHome = process.env.STUDIO_HOME;
    try {
      delete process.env.STUDIO_HOME;
      expect(resolveWorkspacesDir()).toBe(path.join(os.homedir(), '.studio', 'workspaces'));
    } finally {
      if (savedStudioHome === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = savedStudioHome;
    }
  });
});
