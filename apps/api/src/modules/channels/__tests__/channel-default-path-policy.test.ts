import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore } from '@dommaker/studio-shared';

let dataDir: string;
let allowedRoot: string;
let server: Server;
let baseUrl: string;
const originalRoots = process.env.PMO_GIT_REPO_ROOTS;
const originalDataDir = process.env.STUDIO_DATA_DIR;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-policy-data-'));
  allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-policy-root-'));
  process.env.STUDIO_DATA_DIR = dataDir;
  process.env.PMO_GIT_REPO_ROOTS = allowedRoot;
  fs.mkdirSync(path.join(allowedRoot, 'repo'));
  const now = new Date().toISOString();
  await new FileStore(dataDir).createChannel({
    id: 'ch-policy', name: '#policy', type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]', createdAt: now, updatedAt: now,
  });
  const { channelWriteRoutes } = await import('../channel.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels', channelWriteRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${address.port}/api/v1/channels`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (originalRoots === undefined) delete process.env.PMO_GIT_REPO_ROOTS;
  else process.env.PMO_GIT_REPO_ROOTS = originalRoots;
  if (originalDataDir === undefined) delete process.env.STUDIO_DATA_DIR;
  else process.env.STUDIO_DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(allowedRoot, { recursive: true, force: true });
});

describe('channel.defaultPath 执行根策略', () => {
  it('创建与更新拒绝允许根之外的目录', async () => {
    const created = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '#outside', defaultPath: '/etc' }),
    });
    expect(created.status).toBe(400);

    const updated = await fetch(`${baseUrl}/ch-policy`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultPath: '/etc' }),
    });
    expect(updated.status).toBe(400);
  });

  it('接受允许根内的目录，并保留 null 清除语义', async () => {
    const repo = path.join(allowedRoot, 'repo');
    const created = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '#inside', defaultPath: repo }),
    });
    expect(created.status).toBe(201);

    const updated = await fetch(`${baseUrl}/ch-policy`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultPath: repo }),
    });
    expect(updated.status).toBe(200);

    const cleared = await fetch(`${baseUrl}/ch-policy`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultPath: null }),
    });
    expect(cleared.status).toBe(200);
  });
});
