/**
 * #445（spec #441 情境引导 04）：「认领即发声」原语提升契约测试。
 *
 * 背景：#175（#55 决策 1）的「认领即发声」原是 agent-loop 私有方法 claimAndAnnounce，
 * REST claim 端点只做状态迁移——人工经引导片认领与自动 claim 涌现行为不一致。
 * 本票把原语提升为可复用实现（workunit/claim-announce.ts），两条入口走同一路径。
 *
 * 契约断言（AC1）：loop 自动认领入口（AgentLoop.claimAndAnnounce）与 REST claim 端点
 * （POST /workunits/:id/claim）经同一原语（模块间谍双向命中），且可观察效果一致——
 * 认领成功（unassigned → active + assigneeId）+ WU 线程发一条普通系统消息
 * 「『认领方名』已认领任务，开始执行」（无里程碑 meta）；发声失败只记日志不阻断认领。
 *
 * 范式照抄 agent-loop-claim-fail-announce / suggestions.test.ts：tmpdir 真实 FileStore +
 * 真实 WorkUnitService/wu-messenger；CLI 执行与 knowledge-service mock；
 * 路由测试 STUDIO_DATA_DIR / STUDIO_HOME 指向临时目录后才动态 import workunit.routes
 * （模块级 FileStore 在 import 时固化数据根）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

// 原语间谍：两入口（loop / REST 路由）都必须经同一模块出口，包一层记录调用后放行真实实现
const { claimSpy } = vi.hoisted(() => ({ claimSpy: vi.fn() }));
vi.mock('../claim-announce.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claim-announce.js')>();
  return {
    ...actual,
    claimWorkUnitAndAnnounce: (...args: Parameters<typeof actual.claimWorkUnitAndAnnounce>) => {
      claimSpy(...args.map(a => (typeof a === 'object' && a !== null ? '[deps]' : a)));
      return actual.claimWorkUnitAndAnnounce(...args);
    },
  };
});

// 发声出口间谍：默认放行真实实现（发声落盘可断言）；单用例可 mockRejectedValueOnce 验证不阻断
vi.mock('../wu-messenger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wu-messenger.js')>();
  return {
    ...actual,
    postWuSystemMessage: vi.fn((...args: Parameters<typeof actual.postWuSystemMessage>) =>
      actual.postWuSystemMessage(...args)),
  };
});

// #591：认领决策埋点间谍（recordAgentDecision 落 audit-logs 轨，fire-and-forget）
const { decisionSpy } = vi.hoisted(() => ({ decisionSpy: vi.fn() }));
vi.mock('../../audit-logs/agent-decision.js', () => ({ recordAgentDecision: decisionSpy }));

import { postWuSystemMessage } from '../wu-messenger.js';
import { claimWorkUnitAndAnnounce } from '../claim-announce.js';
import { AgentLoop } from '../../agents/loop/agent-loop.js';

const nowIso = () => new Date().toISOString();

async function createChannel(fileStore: FileStore, id: string) {
  await fileStore.createChannel({
    id, name: '#445-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: nowIso(), updatedAt: nowIso(),
  });
}

function metaOf(msg: ChannelMessageData): Record<string, unknown> {
  const raw = (msg as unknown as { meta?: unknown }).meta;
  return typeof raw === 'string' ? JSON.parse(raw) : ((raw as Record<string, unknown>) ?? {});
}

// ─── 原语行为 ───

describe('claimWorkUnitAndAnnounce（认领即发声原语）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-announce-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-445-${Date.now()}`;
    await createChannel(fileStore, channelId);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('认领成功 → active + assigneeId；WU 线程发「『名字』已认领任务，开始执行」（普通消息，无里程碑 meta）', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });

    const claimed = await claimWorkUnitAndAnnounce(wu.id, 'user-1', '守夜人', { wuService, fileStore });

    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe('user-1');
    const msgs = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('『守夜人』已认领任务，开始执行');
    expect(msgs[0].agentName).toBe('守夜人');
    expect(metaOf(msgs[0]).atHuman).toBeUndefined(); // 普通系统消息，非里程碑（#175 决策 1）
  });

  it('认领竞争失败（已被他人领走）→ 抛 Claim failed 且不发声', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });
    await wuService.claim(wu.id, 'instance-other');

    await expect(
      claimWorkUnitAndAnnounce(wu.id, 'user-1', '守夜人', { wuService, fileStore }),
    ).rejects.toThrow('Claim failed');
    expect(await fileStore.queryMessages(channelId, { workUnitId: wu.id })).toHaveLength(0);
  });

  it('发声失败只记日志，绝不阻断认领（#175 决策 1 待遇不变）', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });
    vi.mocked(postWuSystemMessage).mockRejectedValueOnce(new Error('disk full'));

    const claimed = await claimWorkUnitAndAnnounce(wu.id, 'user-1', '守夜人', { wuService, fileStore });

    expect(claimed.status).toBe('active');
    expect((await wuService.getById(wu.id))!.assigneeId).toBe('user-1');
  });

  // ─── #591：认领决策埋点（词表 claim，落 audit-logs 轨）───

  it('认领埋点：人工认领（无实例状态）→ actorType=human；认领失败不落账', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });
    const wu2 = await wuService.create({ scope: '另一张单', channelId, type: 'task', status: 'unassigned' });
    await wuService.claim(wu2.id, 'instance-other');

    await claimWorkUnitAndAnnounce(wu.id, 'user-1', '守夜人', { wuService, fileStore });
    await expect(
      claimWorkUnitAndAnnounce(wu2.id, 'user-1', '守夜人', { wuService, fileStore }),
    ).rejects.toThrow('Claim failed');

    expect(decisionSpy).toHaveBeenCalledTimes(1);
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'claim',
      resource: 'workunit',
      resourceId: wu.id,
      actor: { id: 'user-1', type: 'human' },
      details: { claimerName: '守夜人' },
    }));
  });

  it('认领埋点：agent 实例认领 → actorType=agent；WU metadata.traceId 透传为 requestId', async () => {
    // 造一个 agent 运行实例状态（agents/<id>/state.json），getState 命中即 agent
    fs.mkdirSync(path.join(testDir, 'agents', 'instance-a1'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'agents', 'instance-a1', 'state.json'), JSON.stringify({ roleId: 'role-a1' }));
    const wu = await wuService.create({
      scope: '实现某个功能', channelId, type: 'task', status: 'unassigned',
      metadata: { traceId: 'trace-claim-1' },
    });

    await claimWorkUnitAndAnnounce(wu.id, 'instance-a1', '巡检员', { wuService, fileStore });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'claim',
      actor: { id: 'instance-a1', type: 'agent' },
      requestId: 'trace-claim-1',
    }));
  });
});

// ─── 契约：两条入口（loop 自动认领 / REST claim 端点）走同一原语、行为一致 ───

describe('认领即发声两入口同路径契约（AC1）', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;

  const mockRole = {
    id: 'role-445', name: 'loop-agent', description: '#445 test agent',
    channels: '[]', status: 'active', provider: 'claude',
    createdAt: nowIso(), updatedAt: nowIso(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-contract-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-445c-${Date.now()}`;
    await createChannel(fileStore, channelId);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('loop 自动认领入口：AgentLoop.claimAndAnnounce 经同一原语，效果一致（active + 一条发声）', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });
    const agentLoop = new AgentLoop(mockRole, fileStore);
    (agentLoop as unknown as { instance: unknown }).instance = { id: 'instance-445' };

    const ok = await (agentLoop as unknown as {
      claimAndAnnounce(workUnit: unknown): Promise<boolean>;
    }).claimAndAnnounce(wu);

    expect(ok).toBe(true);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy).toHaveBeenCalledWith(wu.id, 'instance-445', 'loop-agent', '[deps]');
    expect((await wuService.getById(wu.id))!.status).toBe('active');
    const msgs = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('『loop-agent』已认领任务，开始执行');
  });
});

// ─── REST 入口：POST /workunits/:id/claim ───

describe('REST claim 端点（认领即发声接入）', () => {
  const { envRoot } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsH = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const osH = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pathH = require('node:path') as typeof import('node:path');
    const envRoot = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'claim-route-env-'));
    process.env.STUDIO_DATA_DIR = envRoot;
    process.env.STUDIO_HOME = envRoot;
    return { envRoot };
  });

  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let server: Server;
  let baseUrl: string;
  let channelId: string;

  beforeAll(async () => {
    fileStore = new FileStore(envRoot);
    wuService = new WorkUnitService(fileStore);
    const { default: workunitRoutes } = await import('../workunit.routes.js');
    const app = express();
    app.use(express.json());
    app.use('/workunits', workunitRoutes);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
    baseUrl = `http://127.0.0.1:${addr.port}/workunits`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(envRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    channelId = `ch-445r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await createChannel(fileStore, channelId);
  });

  async function postClaim(wuId: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/${wuId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('REST 入口经同一原语：认领成功 → 200 + active + 频道发声（与 loop 入口同一消息形态）', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });

    const res = await postClaim(wu.id, { agentId: 'instance-rest' });

    expect(res.status).toBe(200);
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy.mock.calls[0][0]).toBe(wu.id);
    expect(claimSpy.mock.calls[0][1]).toBe('instance-rest');
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.assigneeId).toBe('instance-rest');
    const msgs = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toMatch(/^『.+』已认领任务，开始执行$/);
  });

  it('缺省身份：body 不带 agentId → 认领人 = 当前登录用户（none 模式 local），发声署用户显示名', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });

    const res = await postClaim(wu.id, {});

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.assigneeId).toBe('local'); // STUDIO_AUTH=none 注入的本地用户
    const msgs = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('『Local User』已认领任务，开始执行');
  });

  it('竞争失败（已被领走）→ 409 CLAIM_FAILED 且不发声', async () => {
    const wu = await wuService.create({ scope: '实现某个功能', channelId, type: 'task', status: 'unassigned' });
    await wuService.claim(wu.id, 'instance-other');

    const res = await postClaim(wu.id, {});

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CLAIM_FAILED');
    expect(await fileStore.queryMessages(channelId, { workUnitId: wu.id })).toHaveLength(0);
  });
});
