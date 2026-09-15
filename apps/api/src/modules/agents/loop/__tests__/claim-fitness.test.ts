/**
 * 决策 14 认领前适任判断（agents/loop/claim-fitness.ts + agent-loop 集成）单测
 *
 * 覆盖（对应设计要点）：
 *   - parseFitnessVerdict：FIT 协议解析（yes/no/理由/信封拆封），解析不出 → 从宽适任
 *   - parseUnfitRoles/isRoleUnfit：metadata 容错解析
 *   - judgeClaimFitness：prompt 组装（type+scope 截断+persona/acceptedTypes）、调用失败 → 从宽
 *   - observe 第 7 道过滤：unfitRoles 含本 role → 不可见；看下一候选；全不适任 → 不认领
 *   - ensureClaimFit：适任放行 / 不适任落档 unfitRoles / 指名不判 / 落档失败从宽
 *   - 全员不适任：unfitRoles 覆盖频道全部 active 成员 → blocked + blockReason + 频道消息
 *
 * 真实 FileStore（tmpdir）+ 真实 WorkUnitService；LLM 调用 mock getSystemExecutor
 * （同 completion-extraction.test.ts 先例）；CLI 执行与 knowledge-service mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../../../workunit/workunit.service.js';
import { parseWuMetadata } from '../../../workunit/wu-metadata.js';

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));

vi.mock('../../system-executor.js', () => ({
  getSystemExecutor: () => ({ run: mockRun }),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: vi.fn(),
  },
}));

vi.mock('../../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop, resolveTarget } from '../agent-loop';
import {
  buildClaimFitnessPrompt, parseFitnessVerdict, parseUnfitRoles, isRoleUnfit,
  judgeClaimFitness, FITNESS_SCOPE_MAX_CHARS,
} from '../claim-fitness';

const SELF_ROLE_ID = 'role-self';
const OTHER_ROLE_ID = 'role-other';
const SELF_INSTANCE_ID = 'instance-self';
const MY_CHANNEL = 'ch-mine';

const mockRole = {
  id: SELF_ROLE_ID,
  name: 'self-agent',
  description: '后端开发角色',
  channels: JSON.stringify([MY_CHANNEL]),
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  persona: '我负责后端 API 与数据层实现',
  acceptedTypes: ['implement', 'bug'],
};

interface ObserveCapable {
  observe(): Promise<{
    myActive: WorkUnitData[];
    unassigned: WorkUnitData[];
    newReplies: unknown[];
  }>;
}

interface FitnessCapable {
  ensureClaimFit(wu: WorkUnitData): Promise<boolean>;
}

let testDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let agentLoop: AgentLoop;

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.mockResolvedValue({ output: 'FIT: yes: 属于本角色职能域' });
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-claim-fitness-'));
  fileStore = new FileStore(testDir);
  wuService = new WorkUnitService(fileStore);
  agentLoop = new AgentLoop(mockRole, fileStore);
  (agentLoop as unknown as { instance: unknown }).instance = {
    id: SELF_INSTANCE_ID,
    roleId: SELF_ROLE_ID,
    sessionId: null,
    status: 'idle',
    currentWorkUnitId: null,
    startedAt: new Date().toISOString(),
    terminatedAt: null,
    lastHeartbeat: null,
    metadata: null,
  };
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function observe() {
  return (agentLoop as unknown as ObserveCapable).observe();
}

function ensureClaimFit(wu: WorkUnitData) {
  return (agentLoop as unknown as FitnessCapable).ensureClaimFit(wu);
}

async function createUnassignedWu(scope: string, metadata?: Record<string, unknown>, assigneeId: string | null = null) {
  return wuService.create({
    scope, channelId: MY_CHANNEL, type: 'implement',
    status: 'unassigned', assigneeId,
    ...(metadata ? { metadata } : {}),
  });
}

/** 把 WU createdAt 回填到过去（控制 observe 的 createdAt asc 排序） */
async function backdateCreatedAt(wuId: string, ms: number): Promise<void> {
  const snap = (await fileStore.getIndex()).find(s => s.id === wuId);
  if (!snap) throw new Error(`wu ${wuId} not found`);
  await fileStore.upsertSnapshot({ ...snap, createdAt: new Date(Date.now() - ms).toISOString() });
}

async function createChannelWithMembers(memberIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: MY_CHANNEL,
    name: 'test-channel',
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: JSON.stringify(memberIds),
    createdAt: now,
    updatedAt: now,
  });
}

async function createProfile(id: string, name: string, status: string): Promise<void> {
  const now = new Date().toISOString();
  await fileStore.createProfile({
    id, name, description: null, channels: '[]', status, provider: 'claude',
    createdAt: now, updatedAt: now,
  });
}

describe('parseFitnessVerdict', () => {
  it('FIT: yes → 适任，理由随行为空可缺省', () => {
    expect(parseFitnessVerdict('FIT: yes: 属于后端范畴')).toEqual({ fit: true, reason: '属于后端范畴' });
    expect(parseFitnessVerdict('FIT: yes')).toEqual({ fit: true, reason: '' });
  });

  it('FIT: no → 不适任，理由取同行余下部分', () => {
    expect(parseFitnessVerdict('FIT: no: 这是前端样式任务')).toEqual({ fit: false, reason: '这是前端样式任务' });
  });

  it('claude --output-format json 信封先拆封再解析', () => {
    const envelope = JSON.stringify({ type: 'result', result: 'FIT: no: 与角色无关' });
    expect(parseFitnessVerdict(envelope)).toEqual({ fit: false, reason: '与角色无关' });
  });

  it('模型输出夹带其他行 → 只认 FIT 行', () => {
    expect(parseFitnessVerdict('让我想想……\nFIT: no: 做不了\n以上')).toEqual({ fit: false, reason: '做不了' });
  });

  it('解析不出（无 FIT 行/空串/坏信封）→ 从宽适任', () => {
    expect(parseFitnessVerdict('我觉得可以试试吧').fit).toBe(true);
    expect(parseFitnessVerdict('').fit).toBe(true);
    expect(parseFitnessVerdict('{"type":"other"}').fit).toBe(true);
  });

  it('理由超 120 字符截断', () => {
    const long = parseFitnessVerdict(`FIT: no: ${'x'.repeat(200)}`);
    expect(long.fit).toBe(false);
    expect(long.reason.length).toBe(120);
  });
});

describe('parseUnfitRoles / isRoleUnfit', () => {
  const entry = { roleId: SELF_ROLE_ID, reason: 'r', at: '2026-09-15T00:00:00.000Z' };

  it('正常名单解析 + 命中判定', () => {
    const meta = JSON.stringify({ unfitRoles: [entry] });
    expect(parseUnfitRoles(meta)).toEqual([entry]);
    expect(isRoleUnfit(meta, SELF_ROLE_ID)).toBe(true);
    expect(isRoleUnfit(meta, OTHER_ROLE_ID)).toBe(false);
  });

  it('缺失/坏 JSON/非数组/缺 roleId 条目 → 空名单（不排除）', () => {
    expect(parseUnfitRoles(null)).toEqual([]);
    expect(parseUnfitRoles(undefined)).toEqual([]);
    expect(parseUnfitRoles('{bad json')).toEqual([]);
    expect(parseUnfitRoles(JSON.stringify({ unfitRoles: 'nope' }))).toEqual([]);
    expect(parseUnfitRoles(JSON.stringify({ unfitRoles: [{ reason: 'x' }, entry] }))).toEqual([entry]);
  });
});

describe('buildClaimFitnessPrompt / judgeClaimFitness', () => {
  it('prompt 含 role 名/persona/acceptedTypes/wu type/scope', () => {
    const prompt = buildClaimFitnessPrompt(
      { type: 'implement', scope: '给 API 加分页' },
      mockRole as never,
    );
    expect(prompt).toContain('self-agent');
    expect(prompt).toContain('我负责后端 API 与数据层实现');
    expect(prompt).toContain('implement、bug');
    expect(prompt).toContain('类型 implement');
    expect(prompt).toContain('给 API 加分页');
  });

  it('scope 超长按 FITNESS_SCOPE_MAX_CHARS 截断', () => {
    const prompt = buildClaimFitnessPrompt(
      { type: 'task', scope: 's'.repeat(FITNESS_SCOPE_MAX_CHARS + 500) },
      mockRole as never,
    );
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(FITNESS_SCOPE_MAX_CHARS + 500);
  });

  it('判断调用（默认走 getSystemExecutor）返回 FIT: no → 不适任', async () => {
    mockRun.mockResolvedValue({ output: 'FIT: no: 前端任务' });
    const verdict = await judgeClaimFitness({ type: 'implement', scope: '改样式' }, mockRole as never);
    expect(verdict.fit).toBe(false);
    expect(mockRun).toHaveBeenCalledTimes(1);
    const callArgs = mockRun.mock.calls[0];
    expect(callArgs[1].eventSource).toBe('claim-fitness');
  });

  it('判断调用抛错（spawn 失败/超时/未配置）→ 从宽适任', async () => {
    mockRun.mockRejectedValue(new Error('cli timeout'));
    const verdict = await judgeClaimFitness({ type: 'implement', scope: '任何任务' }, mockRole as never);
    expect(verdict.fit).toBe(true);
  });
});

describe('observe 第 7 道过滤（unfitRoles 不可见）', () => {
  it('unfitRoles 含本 role → 不可见；含其他 role → 可见', async () => {
    const unfitForSelf = await createUnassignedWu('别人做不了的单', {
      unfitRoles: [{ roleId: SELF_ROLE_ID, reason: '做不了', at: new Date().toISOString() }],
    });
    const unfitForOther = await createUnassignedWu('别人已被排除的单', {
      unfitRoles: [{ roleId: OTHER_ROLE_ID, reason: '不适合他', at: new Date().toISOString() }],
    });

    const obs = await observe();
    const ids = obs.unassigned.map(w => w.id);
    expect(ids).not.toContain(unfitForSelf.id);
    expect(ids).toContain(unfitForOther.id);
  });

  it('首候选不适任 → resolveTarget 取下一候选（继续评估下一单）', async () => {
    const first = await createUnassignedWu('更早但不适合我的单', {
      unfitRoles: [{ roleId: SELF_ROLE_ID, reason: 'r', at: new Date().toISOString() }],
    });
    await backdateCreatedAt(first.id, 60_000);
    const second = await createUnassignedWu('稍晚的普通单');

    const obs = await observe();
    const target = resolveTarget(obs);
    expect(target?.workUnit.id).toBe(second.id);
  });

  it('全部候选不适任 → resolveTarget 为 null（本轮不认领静默等待）', async () => {
    await createUnassignedWu('单甲', {
      unfitRoles: [{ roleId: SELF_ROLE_ID, reason: 'r', at: new Date().toISOString() }],
    });
    await createUnassignedWu('单乙', {
      unfitRoles: [{ roleId: SELF_ROLE_ID, reason: 'r', at: new Date().toISOString() }],
    });

    const obs = await observe();
    expect(obs.unassigned).toHaveLength(0);
    expect(resolveTarget(obs)).toBeNull();
  });
});

describe('ensureClaimFit（认领前闸门）', () => {
  it('判 yes → 放行，metadata 不写 unfitRoles', async () => {
    const wu = await createUnassignedWu('普通后端单');
    expect(await ensureClaimFit(wu)).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(1);
    const meta = parseWuMetadata((await wuService.getById(wu.id))!.metadata);
    expect(meta.unfitRoles).toBeUndefined();
  });

  it('判 no → 不放行 + unfitRoles 落档 {roleId, reason, at}', async () => {
    mockRun.mockResolvedValue({ output: 'FIT: no: 纯前端样式任务' });
    const wu = await createUnassignedWu('调整按钮颜色');
    expect(await ensureClaimFit(wu)).toBe(false);

    const meta = parseWuMetadata((await wuService.getById(wu.id))!.metadata);
    expect(meta.unfitRoles).toHaveLength(1);
    expect(meta.unfitRoles![0].roleId).toBe(SELF_ROLE_ID);
    expect(meta.unfitRoles![0].reason).toBe('纯前端样式任务');
    expect(typeof meta.unfitRoles![0].at).toBe('string');
  });

  it('已落档过本 role → 去重不重复追加', async () => {
    mockRun.mockResolvedValue({ output: 'FIT: no: 做不了' });
    const wu = await createUnassignedWu('单', {
      unfitRoles: [{ roleId: SELF_ROLE_ID, reason: '旧理由', at: '2026-09-14T00:00:00.000Z' }],
    });
    expect(await ensureClaimFit(wu)).toBe(false);
    const meta = parseWuMetadata((await wuService.getById(wu.id))!.metadata);
    expect(meta.unfitRoles).toHaveLength(1);
    expect(meta.unfitRoles![0].reason).toBe('做不了');
  });

  it('判断调用失败 → 从宽放行，不落档', async () => {
    mockRun.mockRejectedValue(new Error('spawn failed'));
    const wu = await createUnassignedWu('普通单');
    expect(await ensureClaimFit(wu)).toBe(true);
    const meta = parseWuMetadata((await wuService.getById(wu.id))!.metadata);
    expect(meta.unfitRoles).toBeUndefined();
  });

  it('显式指名本 role 的 WU 不判（人已点名），直接放行且不调用 LLM', async () => {
    const wu = await createUnassignedWu('指名单', undefined, SELF_ROLE_ID);
    expect(await ensureClaimFit(wu)).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('落档失败（FileStore 故障）→ 从宽放行（宁可误抢，不每轮空烧判断）', async () => {
    mockRun.mockResolvedValue({ output: 'FIT: no: 做不了' });
    const wu = await createUnassignedWu('普通单');
    const svc = (agentLoop as unknown as { workUnitService: WorkUnitService }).workUnitService;
    const original = svc.update.bind(svc);
    svc.update = vi.fn().mockRejectedValue(new Error('fs broken')) as never;
    try {
      expect(await ensureClaimFit(wu)).toBe(true);
    } finally {
      svc.update = original;
    }
  });

  it('判 no 但 WU 已被他人抢先认领 → 不落档', async () => {
    mockRun.mockResolvedValue({ output: 'FIT: no: 做不了' });
    const wu = await createUnassignedWu('普通单');
    await wuService.claim(wu.id, 'instance-other');
    expect(await ensureClaimFit(wu)).toBe(false);
    const meta = parseWuMetadata((await wuService.getById(wu.id))!.metadata);
    expect(meta.unfitRoles).toBeUndefined();
  });
});

describe('全员不适任转人工', () => {
  beforeEach(async () => {
    await createChannelWithMembers([SELF_ROLE_ID, OTHER_ROLE_ID]);
    await createProfile(SELF_ROLE_ID, 'self-agent', 'active');
  });

  it('unfitRoles 覆盖频道全部 active 成员 → blocked + blockReason + 频道消息', async () => {
    await createProfile(OTHER_ROLE_ID, 'other-agent', 'active');
    mockRun.mockResolvedValue({ output: 'FIT: no: 跨领域任务' });
    const wu = await createUnassignedWu('谁都不会做的单', {
      unfitRoles: [{ roleId: OTHER_ROLE_ID, reason: '他也不行', at: new Date().toISOString() }],
    });

    expect(await ensureClaimFit(wu)).toBe(false);

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    const meta = parseWuMetadata(after.metadata);
    expect(meta.blockReason).toContain('unfit-all');
    expect(meta.unfitRoles!.map(e => e.roleId).sort()).toEqual([OTHER_ROLE_ID, SELF_ROLE_ID].sort());
    // 仿 blocked 转人模式：频道消息「无人能接」
    const messages = await fileStore.queryAllMessages({ workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('无人能接此任务'))).toBe(true);
  });

  it('还有其他 active 成员未判 → 保持 unassigned，不转人工', async () => {
    await createProfile(OTHER_ROLE_ID, 'other-agent', 'active');
    mockRun.mockResolvedValue({ output: 'FIT: no: 我做不了' });
    const wu = await createUnassignedWu('普通单');

    expect(await ensureClaimFit(wu)).toBe(false);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('unassigned');
    const messages = await fileStore.queryAllMessages({ workUnitId: wu.id });
    expect(messages.some(m => m.content.includes('无人能接此任务'))).toBe(false);
  });

  it('inactive 成员不计入「全员」——唯一 active 成员判 no 即全员不适任', async () => {
    await createProfile(OTHER_ROLE_ID, 'other-agent', 'inactive');
    mockRun.mockResolvedValue({ output: 'FIT: no: 做不了' });
    const wu = await createUnassignedWu('普通单');

    expect(await ensureClaimFit(wu)).toBe(false);
    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
  });

  it('无频道 WU 判 no → 落档但不判全员（保持 unassigned）', async () => {
    mockRun.mockResolvedValue({ output: 'FIT: no: 做不了' });
    const wu = await wuService.create({
      scope: '无频道单', channelId: null, type: 'implement', status: 'unassigned', assigneeId: null,
    });
    expect(await ensureClaimFit(wu)).toBe(false);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('unassigned');
    expect(parseWuMetadata(after.metadata).unfitRoles).toHaveLength(1);
  });
});
