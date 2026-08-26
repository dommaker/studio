/**
 * gc-service (#144) — GC 候选清单与人审归档端到端测试
 *
 * 覆盖（对应 #144 AC）：
 *   - 端到端：跑蒸馏运行（mock SystemExecutor）→ GC 候选清单卡内容正确（含逐条理由）
 *     → approve → 条目 maturity=archived（可恢复：文件不动只改 maturity）
 *   - 零候选时不发卡、不落提案
 *   - reject：条目保留、零副作用；人判保留的条目后续运行不再重复提案
 *   - 已有 pending GC 提案 → 不重复发卡
 *   - 发卡失败静默（card-failed），不阻塞蒸馏主链路
 *   - signal/rule 层条目不在 GC 射程内（蒸馏产物 reference 层在射程内但刚产出不过线）
 *
 * mock 点与 distill-service.test.ts 相同：getSystemExecutor + channelMessageService；
 * 运行历史直接播种 runs.jsonl（构造 ≥3 个蒸馏周期）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { FileKnowledgeStore, type KnowledgeEntry } from '@dommaker/harness';

const { mockRunJson, mockCreateCardMessage } = vi.hoisted(() => ({
  mockRunJson: vi.fn(),
  mockCreateCardMessage: vi.fn(),
}));

vi.mock('../../agents/system-executor.js', () => ({
  getSystemExecutor: () => ({ runJson: mockRunJson }),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

import { DistillService, type DistillProposal, type GcProposal } from '../distill-service.js';
import { approveProposal, rejectProposal } from '../../review-proposal/service.js';
import { getReviewProposalAdapter } from '../../review-proposal/registry.js';

// #351：GC 提案的 approve/reject/状态查询走 review-proposal 正本生命周期
const approveGc = (id: string) => approveProposal('gc', id);
const rejectGc = (id: string) => rejectProposal('gc', id);
const gcStore = () => getReviewProposalAdapter<GcProposal>('gc')!.store;
const distillStore = () => getReviewProposalAdapter<DistillProposal>('distill')!.store;

let tmpDir: string;
let fileStore: FileStore;
let store: FileKnowledgeStore;
let dataDir: string;
let eventsFile: string;
let service: DistillService;

let seq = 0;
function seedEntry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  seq += 1;
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: over.id ?? `entry-${seq}`,
    type: 'guideline',
    title: `entry ${seq}`,
    content: 'content',
    maturity: 'active',
    layer: 'project',
    created: now,
    lastReferenced: now,
    contributors: ['test'],
    projects: [],
    tags: [],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    executionResults: [],
    consumptionMode: 'reference',
    origin: 'agent',
    ...over,
  };
  store.save(entry);
  return entry;
}

/** 造矿石（signal 层，触发蒸馏门槛的原料） */
function seedOre(id: string, created: string): KnowledgeEntry {
  return seedEntry({
    id, consumptionMode: 'signal', title: `[Session Fix] ${id}`,
    created, lastReferenced: created, tags: ['session-summary'],
  });
}

/** 播种蒸馏运行历史（构造周期序列；executedAt 之外字段 GC 不关心） */
async function seedRuns(...executedAts: string[]): Promise<void> {
  for (const [i, at] of executedAts.entries()) {
    await fileStore.appendJsonl(path.join(dataDir, 'runs.jsonl'), {
      id: `run-seed-${i}`, proposalId: 'p-seed', executedAt: at,
      outcome: 'executed', signals: { topicTags: [], manualCount: 0 },
      materialIds: [], productIds: [],
    });
  }
}

async function readEvents(): Promise<Array<Record<string, unknown>>> {
  const rows = await fileStore.readJsonl<Record<string, unknown>>(eventsFile);
  return rows.filter(r => r.type === 'knowledge:distill');
}

function eventStages(events: Array<Record<string, unknown>>): string[] {
  return events.map(e => {
    try { return JSON.parse(String(e.payload)).stage; } catch { return undefined; }
  });
}

/** 跑一次完整蒸馏（矿石 → 提案 → approve → 产物），返回提案 id */
async function runDistill(): Promise<void> {
  await service.maybePropose({});
  const proposal = (await distillStore().listProposals()).at(-1)!;
  mockRunJson.mockResolvedValue({
    products: [{ title: '蒸馏产物', content: '模式正文', tags: ['pattern'] }],
  });
  const result = await approveProposal('distill', proposal.id);
  expect(result.kind).toBe('executed');
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-service-'));
  dataDir = path.join(tmpDir, 'distill');
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  fileStore = new FileStore(tmpDir);
  store = new FileKnowledgeStore({ baseDir: path.join(tmpDir, 'knowledge') });
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-system', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  service = new DistillService({ store, fileStore, dataDir, eventsFile });
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
});

afterEach(() => {
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('端到端：蒸馏运行 → GC 候选清单卡 → approve → archived', () => {
  it('连续 3 周期零引用的 reference 条目进清单（卡含逐条理由），approve 后归档', async () => {
    // 两个历史周期 + 本次蒸馏 = 3 个周期；老条目 lastReferenced 早于 cutoff（2026-07-01）
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    const staleRef = seedEntry({
      id: 'stale-ref', title: '过时参考条目',
      created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z',
    });
    const freshRef = seedEntry({ id: 'fresh-ref', title: '近期有引用的条目' }); // lastReferenced=now
    const ruleEntry = seedEntry({
      id: 'rule-entry', consumptionMode: 'rule',
      created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z',
    });
    // 蒸馏原料（signal 层，不计龄）
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();

    // 两张卡：distill_proposal + gc_proposal
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(2);
    const gcCall = mockCreateCardMessage.mock.calls.find(c => c[3] === 'gc_proposal');
    expect(gcCall).toBeTruthy();
    const [channelId, , content, , cardData] = gcCall!;
    expect(channelId).toBe('ch-system');

    // 清单内容：只含 stale-ref（rule/signal/新鲜条目/刚产出的蒸馏产物都不在）
    expect(cardData.candidates.map((c: { entryId: string }) => c.entryId)).toEqual(['stale-ref']);
    // 逐条可读理由：哪几个周期零引用
    expect(cardData.candidates[0].reason).toContain('连续 3 个蒸馏周期零引用');
    expect(cardData.candidates[0].reason).toContain('2026-07-01');
    expect(content).toContain('过时参考条目');
    expect(content).toContain('连续 3 个蒸馏周期零引用');

    // 提案落盘 pending + 事件
    const gcProposal = (await gcStore().listProposals())[0];
    expect(gcProposal.status).toBe('pending');
    expect(gcProposal.runId).toBeTruthy();
    expect(eventStages(await readEvents())).toContain('gc-proposal-posted');

    // approve → 候选 archived（其余不动）
    const result = await approveGc(gcProposal.id);
    expect(result.kind).toBe('executed');
    expect(result.kind === 'executed' && result.data?.archivedIds).toEqual(['stale-ref']);
    expect(store.get(staleRef.id)?.maturity).toBe('archived');
    expect(store.get(freshRef.id)?.maturity).toBe('active');
    expect(store.get(ruleEntry.id)?.maturity).toBe('active');
    // 蒸馏产物（reference 层，刚产出不过线）仍在主区
    expect(store.list().filter(e => e.tags.includes('distilled'))[0]?.maturity).toBe('active');
    expect(eventStages(await readEvents())).toContain('gc-executed');
    expect((await gcStore().getProposal(gcProposal.id))?.status).toBe('executed');
  });

  it('主区 >200 条强制出清单（周期不足也出）', async () => {
    // 202 条主区条目（lastReferenced 都老）+ 1 个历史周期 + 本次蒸馏 = 2 个周期（不足 3）
    await seedRuns('2026-07-15T00:00:00.000Z');
    for (let i = 0; i < 202; i++) {
      seedEntry({
        id: `bulk-${i}`,
        created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z',
      });
    }
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();

    const gcCall = mockCreateCardMessage.mock.calls.find(c => c[3] === 'gc_proposal');
    expect(gcCall).toBeTruthy();
    const cardData = gcCall![4];
    expect(cardData.forced).toBe(true);
    expect(cardData.mainAreaCount).toBeGreaterThan(200);
    expect(cardData.candidates.length).toBeGreaterThanOrEqual(202);
  });
});

describe('零候选不发卡', () => {
  it('全部条目近期有引用 → 蒸馏运行后无 GC 卡、无 GC 提案', async () => {
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    seedEntry({ id: 'fresh-1' });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1); // 仅 distill_proposal
    expect(await gcStore().listProposals()).toHaveLength(0);
    expect(eventStages(await readEvents())).not.toContain('gc-proposal-posted');
  });

  it('失败运行不构成蒸馏周期（同消费基线「失败不推进」口径）', async () => {
    // 1 个历史 executed + 1 个 failed + 本次 executed = 仅 2 个周期（不足 3）→ 不出清单；
    // 若失败运行也计周期则 3 周期过线会出清单
    await seedRuns('2026-07-01T00:00:00.000Z');
    await fileStore.appendJsonl(path.join(dataDir, 'runs.jsonl'), {
      id: 'run-failed', proposalId: 'p-f', executedAt: '2026-07-15T00:00:00.000Z',
      outcome: 'failed', signals: { topicTags: [], manualCount: 0 }, materialIds: [], productIds: [],
    });
    seedEntry({ id: 'stale-f', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();

    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1); // 仅 distill_proposal
    expect(await gcStore().listProposals()).toHaveLength(0);
  });
});

describe('reject 与人判保留', () => {
  it('reject → 条目保留零副作用；后续运行不再重复提案人判保留的条目', async () => {
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    const stale = seedEntry({
      id: 'stale-keep', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z',
    });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();
    const gcProposal = (await gcStore().listProposals())[0];
    const result = await rejectGc(gcProposal.id);
    expect(result.ok).toBe(true);
    expect(store.get(stale.id)?.maturity).toBe('active'); // 保留
    expect(eventStages(await readEvents())).toContain('gc-rejected');

    // 模拟下一次蒸馏运行后再跑 GC：人判保留的条目不再进清单 → 零候选不发卡
    const cardsBefore = mockCreateCardMessage.mock.calls.length;
    await service.runGcCheck({
      id: 'run-next', proposalId: 'p-next', executedAt: new Date().toISOString(),
      outcome: 'executed', signals: { topicTags: [], manualCount: 0 }, materialIds: [], productIds: [],
    });
    expect(mockCreateCardMessage.mock.calls.length).toBe(cardsBefore);
    expect(await gcStore().listProposals()).toHaveLength(1); // 没有新提案
  });
});

describe('降级与去重', () => {
  it('已有 pending GC 提案 → 不重复发卡', async () => {
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    seedEntry({ id: 'stale-a', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();
    const cardsBefore = mockCreateCardMessage.mock.calls.length;
    await service.runGcCheck({
      id: 'run-again', proposalId: 'p-again', executedAt: new Date().toISOString(),
      outcome: 'executed', signals: { topicTags: [], manualCount: 0 }, materialIds: [], productIds: [],
    });
    expect(mockCreateCardMessage.mock.calls.length).toBe(cardsBefore);
    expect(await gcStore().listProposals()).toHaveLength(1);
  });

  it('发卡失败静默：提案 card-failed，不抛、不影响蒸馏结果', async () => {
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    seedEntry({ id: 'stale-b', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await service.maybePropose({});
    const proposal = (await distillStore().listProposals()).at(-1)!;
    mockRunJson.mockResolvedValue({ products: [{ title: 'P', content: 'C', tags: [] }] });
    mockCreateCardMessage.mockRejectedValueOnce(new Error('channel write failed')); // GC 卡失败
    const result = await approveProposal('distill', proposal.id);
    expect(result.kind).toBe('executed'); // 蒸馏主链路不受影响

    const gcProposal = (await gcStore().listProposals())[0];
    expect(gcProposal.status).toBe('card-failed');
    expect(eventStages(await readEvents())).toContain('gc-card-failed');
  });

  it('approveGc 时条目已被其它路径归档 → 跳过该条，其余照归档', async () => {
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    const a = seedEntry({ id: 'stale-c1', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' });
    const b = seedEntry({ id: 'stale-c2', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();
    const gcProposal = (await gcStore().listProposals())[0];
    expect(gcProposal.candidates.map(c => c.entryId).sort()).toEqual(['stale-c1', 'stale-c2']);

    // 人审期间 a 被其它路径归档
    store.update(a.id, { maturity: 'archived' });
    const result = await approveGc(gcProposal.id);
    expect(result.kind).toBe('executed');
    expect(result.kind === 'executed' && result.data?.archivedIds).toEqual(['stale-c2']);
    expect(store.get(b.id)?.maturity).toBe('archived');
  });

  it('重复 approve/reject 已终态 GC 提案 → 拒绝', async () => {
    await seedRuns('2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    seedEntry({ id: 'stale-d', created: '2026-06-01T00:00:00.000Z', lastReferenced: '2026-06-01T00:00:00.000Z' });
    seedOre('ore-1', new Date().toISOString());
    seedOre('ore-2', new Date().toISOString());
    seedOre('ore-3', new Date().toISOString());

    await runDistill();
    const gcProposal = (await gcStore().listProposals())[0];
    await rejectGc(gcProposal.id);
    expect((await approveGc(gcProposal.id)).kind).toBe('invalid');
    expect((await rejectGc(gcProposal.id)).ok).toBe(false);
  });
});
