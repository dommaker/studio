/**
 * workspace-store tests (F6)
 * Hermetic: os.homedir() mocked to a per-run tmp dir — never touches the real ~/.studio.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpHome = vi.hoisted(() => {
  const fsH = require('node:fs') as typeof import('node:fs');
  const osH = require('node:os') as typeof import('node:os');
  const pathH = require('node:path') as typeof import('node:path');
  const tmp = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'ws-store-test-'));
  // #219：STUDIO_HOME 优先于 os.homedir() mock，且 SUT 的 WORKSPACES_DIR 在 import 期冻结；
  // 把 STUDIO_HOME 钉到同一 tmp home，保证 SUT 与断言读写同根（仍是隔离临时目录）。
  process.env.STUDIO_HOME = pathH.join(tmp, '.studio');
  return tmp;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import { getWorkspaceRecord, resolveWorkspaceRoot } from '../workspace-store.js';

const WS_DIR = path.join(tmpHome, '.studio', 'workspaces');

function writeWorkspace(id: string, record: unknown) {
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, `${id}.json`), JSON.stringify(record), 'utf-8');
}

beforeAll(() => fs.mkdirSync(WS_DIR, { recursive: true }));
afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

describe('getWorkspaceRecord', () => {
  test('returns the record for an existing workspace', async () => {
    writeWorkspace('ws-1', { id: 'ws-1', name: 'demo', workspaceRoot: '/repo/demo' });
    expect(await getWorkspaceRecord('ws-1')).toMatchObject({ id: 'ws-1', workspaceRoot: '/repo/demo' });
  });

  test('returns null for a missing workspace', async () => {
    expect(await getWorkspaceRecord('nope')).toBeNull();
  });

  test('returns null for a malformed record', async () => {
    fs.writeFileSync(path.join(WS_DIR, 'bad.json'), '{ not json', 'utf-8');
    expect(await getWorkspaceRecord('bad')).toBeNull();
  });
});

describe('resolveWorkspaceRoot', () => {
  test('resolves workspaceRoot when present', async () => {
    writeWorkspace('ws-2', { id: 'ws-2', workspaceRoot: '/repo/x' });
    expect(await resolveWorkspaceRoot('ws-2')).toBe('/repo/x');
  });

  test('returns null when workspaceRoot is empty or missing', async () => {
    writeWorkspace('ws-3', { id: 'ws-3', workspaceRoot: '' });
    expect(await resolveWorkspaceRoot('ws-3')).toBeNull();
    expect(await resolveWorkspaceRoot('missing')).toBeNull();
  });
});
