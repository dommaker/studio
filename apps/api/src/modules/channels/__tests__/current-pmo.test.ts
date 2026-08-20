/**
 * #272（决策 #251 Q1/Q6）：频道「当前 PMO」派生 + 创建频道默认工程落库。
 *
 * 当前 PMO = 派生概念不落库：本频道最近（seq 大→小）挂接 REQ 所属 PMO，
 * 无挂接 REQ 时回退杂务 PMO（isChore + channelId），都没有 → null。
 * chip 数据形状：{ id, pmoNumber, title, gitRepos }（gitRepos = gitRepo + deliveries 多腿去重）。
 *
 * 路由测试：STUDIO_DATA_DIR / STUDIO_HOME 指向临时目录后才动态 import channel.routes
 * （模块级 FileStore 与 project.service 的 PROJECTS_DIR 在 import 时解析数据根）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore } from '@dommaker/studio-shared';
import { deriveChannelCurrentPmo, type CurrentPmoDeps } from '../current-pmo.js';

// 数据根前置：vi.hoisted 先于一切 import 求值——project.service 的 PROJECTS_DIR、
// channel.routes / auth 中间件的模块级 FileStore 都在 import 时固化数据根。
const { envRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require('node:path') as typeof import('node:path');
  const envRoot = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'current-pmo-env-'));
  process.env.STUDIO_DATA_DIR = envRoot;
  process.env.STUDIO_HOME = envRoot;
  return { envRoot };
});

const now = () => new Date().toISOString();

// ─── 单元：deriveChannelCurrentPmo（注入 deps，不碰路由） ───

describe('deriveChannelCurrentPmo（派生逻辑）', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  const channelId = 'ch-pmo-unit';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-pmo-unit-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.createChannel({
      id: channelId, name: '#研发', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', createdAt: now(), updatedAt: now(),
    });
  });

  async function createReq(id: string, seq: number, projectId: string | null) {
    await fileStore.createRequirement({
      id, seq, title: id, status: 'open',
      channelId, createdAt: now(), createdBy: 'mention',
      ...(projectId ? { projectId } : {}),
    } as Parameters<FileStore['createRequirement']>[0]);
  }

  it('最近（seq 最大）挂接 REQ 所属 PMO 胜出；gitRepos 聚合 gitRepo + deliveries 多腿去重', async () => {
    await createReq('REQ-0001', 1, 'p-old');
    await createReq('REQ-0002', 2, 'p-new');
    const deps: CurrentPmoDeps = {
      fileStore,
      getProject: async id => id === 'p-new'
        ? { id: 'p-new', pmoNumber: 'PMO-2', title: '商城重构', gitRepo: '/repo/a', deliveries: [{ gitRepo: '/repo/a' }, { gitRepo: '/repo/b' }] }
        : { id: 'p-old', pmoNumber: 'PMO-1', title: '旧项目', gitRepo: '/repo/old' },
      findChoreProject: async () => { throw new Error('不应触达杂务回退'); },
    };

    const pmo = await deriveChannelCurrentPmo(channelId, deps);
    expect(pmo).toEqual({
      id: 'p-new', pmoNumber: 'PMO-2', title: '商城重构',
      gitRepos: ['/repo/a', '/repo/b'],
    });
  });

  it('最近 REQ 的项目解析失败/不存在 → 顺延到下一个挂接 REQ', async () => {
    await createReq('REQ-0001', 1, 'p-ok');
    await createReq('REQ-0002', 2, 'p-gone');
    const deps: CurrentPmoDeps = {
      fileStore,
      getProject: async id => {
        if (id === 'p-gone') throw new Error('corrupt');
        return { id: 'p-ok', pmoNumber: 'PMO-1', title: '可用项目', gitRepo: '/repo/ok' };
      },
      findChoreProject: async () => null,
    };

    const pmo = await deriveChannelCurrentPmo(channelId, deps);
    expect(pmo?.id).toBe('p-ok');
  });

  it('无挂接 REQ → 回退杂务 PMO（isChore + channelId）', async () => {
    await createReq('REQ-0001', 1, null);
    const deps: CurrentPmoDeps = {
      fileStore,
      getProject: async () => null,
      findChoreProject: async id => id === channelId
        ? { id: 'p-chore', pmoNumber: 'PMO-9', title: '杂务 · #研发', gitRepo: null }
        : null,
    };

    const pmo = await deriveChannelCurrentPmo(channelId, deps);
    expect(pmo).toEqual({
      id: 'p-chore', pmoNumber: 'PMO-9', title: '杂务 · #研发', gitRepos: [],
    });
  });

  it('既无挂接 REQ 又无杂务 PMO → null（chip 不渲染）', async () => {
    const deps: CurrentPmoDeps = {
      fileStore,
      getProject: async () => null,
      findChoreProject: async () => null,
    };

    expect(await deriveChannelCurrentPmo(channelId, deps)).toBeNull();
  });

  it('杂务 PMO 读取抛错 → null，不抛出（顶栏呈现绝不拖垮页面）', async () => {
    const deps: CurrentPmoDeps = {
      fileStore,
      getProject: async () => null,
      findChoreProject: async () => { throw new Error('boom'); },
    };

    expect(await deriveChannelCurrentPmo(channelId, deps)).toBeNull();
  });
});

// ─── 路由：POST 创建落 defaultPath + GET /:id/current-pmo ───

describe('channel routes（#272）：创建默认工程 + current-pmo 端点', () => {
  const tmpDir = envRoot;
  let fileStore: FileStore;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    fileStore = new FileStore(tmpDir);

    const { default: channelRoutes } = await import('../channel.routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/channels', channelRoutes);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
    baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;

    // PMO 项目（project.service 读 $STUDIO_HOME/projects/*.json）
    fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
    const proj = {
      id: 'proj-route', pmoNumber: 'PMO-7', title: '路由项目',
      description: null, requirement: null, companyId: null, okrId: null,
      status: 'active', priority: 'P1', progress: 0,
      gitBranch: 'pmo-7', gitRepo: '/repo/route',
      specFilePath: null, requirementsDocId: null,
      startedAt: null, completedAt: null,
      createdAt: now(), updatedAt: now(),
    };
    fs.writeFileSync(path.join(tmpDir, 'projects', 'proj-route.json'), JSON.stringify(proj, null, 2));
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /channels 带 defaultPath → 落库并回显；不带 → null', async () => {
    const withPath = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-default-path', type: 'rnd', defaultPath: '/repo/picked' }),
    });
    expect(withPath.status).toBe(201);
    const created = (await withPath.json()).data;
    expect(created.defaultPath).toBe('/repo/picked');

    const withoutPath = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-no-default-path', type: 'rnd' }),
    });
    expect(withoutPath.status).toBe(201);
    expect((await withoutPath.json()).data.defaultPath).toBeNull();
  });

  it('GET /:id/current-pmo：最近挂接 REQ 所属 PMO（chip 形状）', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-current-pmo', type: 'rnd' }),
    });
    const channel = (await res.json()).data;
    await fileStore.createRequirement({
      id: 'REQ-0701', seq: 701, title: 'r', status: 'open',
      channelId: channel.id, createdAt: now(), createdBy: 'mention', projectId: 'proj-route',
    } as Parameters<FileStore['createRequirement']>[0]);

    const pmoRes = await fetch(`${baseUrl}/${channel.id}/current-pmo`);
    expect(pmoRes.status).toBe(200);
    const body = await pmoRes.json();
    expect(body.data).toMatchObject({
      id: 'proj-route', pmoNumber: 'PMO-7', title: '路由项目', gitRepos: ['/repo/route'],
    });
  });

  it('GET /:id/current-pmo：无 REQ 无杂务 → data=null；未知频道 → 404', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-empty-pmo', type: 'rnd' }),
    });
    const channel = (await res.json()).data;

    const pmoRes = await fetch(`${baseUrl}/${channel.id}/current-pmo`);
    expect(pmoRes.status).toBe(200);
    expect((await pmoRes.json()).data).toBeNull();

    const missing = await fetch(`${baseUrl}/ch-not-exist/current-pmo`);
    expect(missing.status).toBe(404);
  });
});
