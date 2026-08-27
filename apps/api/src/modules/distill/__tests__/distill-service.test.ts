/**
 * distill-service (#143) — 蒸馏主链路最小闭环测试
 *
 * 覆盖（对应 #143 AC）：
 *   - 端到端（mock SystemExecutor）：造矿石 → 门槛命中 → 发卡 → approve →
 *     产物带 sourceReferences、原料 archived、运行记录 + 事件落盘
 *   - reject 路径：原料不动、无产物、无运行记录
 *   - 失败路径：LLM 异常 / JSON 解析失败 → 原料不消费、WU 收尾不阻塞（maybePropose 永不抛）
 *   - token 预算耗尽 → 跳过执行（不报错、不消费、提案保持 pending 可重试）
 *   - 发卡失败静默跳过（同 #101 降级口径），不阻塞后续提案
 *   - 已有 pending 提案 → 不重复发卡；蒸馏后 7 天熔断内不再提案
 *
 * mock 点：getSystemExecutor（LLM 唯一 seam）+ channelMessageService（频道落盘）；
 * 知识库走真实 FileKnowledgeStore（临时目录），事件/运行记录走临时目录 JSONL。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { FileKnowledgeStore, type KnowledgeEntry } from '@dommaker/harness';
import { resetDailyTokenBudgetState } from '../../agents/loop/daily-token-budget.js';

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

import { DISTILL_SYSTEM_PROMPT, DistillService, type DistillProposal } from '../distill-service.js';
import { approveProposal, rejectProposal } from '../../review-proposal/service.js';
import { getReviewProposalAdapter } from '../../review-proposal/registry.js';

// #351：approve/reject/状态查询走 review-proposal 正本生命周期（adapter 由 DistillService 构造注册）
const approve = (id: string) => approveProposal('distill', id);
const reject = (id: string) => rejectProposal('distill', id);
const distillStore = () => getReviewProposalAdapter<DistillProposal>('distill')!.store;

let tmpDir: string;
let fileStore: FileStore;
let store: FileKnowledgeStore;
let dataDir: string;
let eventsFile: string;
let service: DistillService;

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

let oreSeq = 0;
/** 造矿石条目（session-summary 沉淀形态：guideline / active / signal） */
function seedOre(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  oreSeq += 1;
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: over.id ?? `ore-${oreSeq}`,
    type: 'guideline',
    title: `[Session Fix] ore ${oreSeq}`,
    content: `Commit: abc${oreSeq}\nMessage: fix something\nFiles: a.ts`,
    maturity: 'active',
    layer: 'project',
    created: now,
    lastReferenced: now,
    contributors: ['session-summary'],
    projects: [],
    tags: ['session-summary'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    executionResults: [],
    consumptionMode: 'signal',
    origin: 'agent',
    ...over,
  };
  store.save(entry);
  return entry;
}

async function listProposals(): Promise<Array<DistillProposal & { status: string }>> {
  return distillStore().listProposals();
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

beforeEach(async () => {
  vi.clearAllMocks();
  resetDailyTokenBudgetState();
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-service-'));
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
  eventBus.unsubscribeAll?.('workunit.status_changed');
  service = new DistillService({ store, fileStore, dataDir, eventsFile });
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  resetDailyTokenBudgetState();
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('端到端：矿石 → 门槛 → 发卡 → approve → 产物入库 + 原料归档', () => {
  it('门槛命中 → 提案落盘 + 发卡；approve → 产物带 sourceReferences、原料 archived、运行记录 + 事件', async () => {
    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({ workUnitId: 'wu-1' });

    // 提案落盘 + 发卡（原料清单进 cardData）
    const proposals = await listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('pending');
    expect(proposals[0].materialIds.sort()).toEqual(ores.map(o => o.id).sort());
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, , content, cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-system');
    expect(cardType).toBe('distill_proposal');
    expect(cardData.proposalId).toBe(proposals[0].id);
    expect(cardData.materials).toHaveLength(3);
    expect(content).toContain('原料');

    mockRunJson.mockResolvedValue({
      products: [
        { title: '蒸馏产物：fix 模式', content: '提炼后的模式正文', tags: ['distilled-pattern'] },
        { title: '', content: '缺 title 丢弃', tags: [] },
      ],
    });
    const result = await approve(proposals[0].id);
    expect(result.kind).toBe('executed');

    // #369：蒸馏是重 prompt 源，120s 默认超时由 SystemExecutor 按源注册表提供（调用点不再显式传）
    expect(mockRunJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        systemPrompt: DISTILL_SYSTEM_PROMPT,
        eventSource: 'knowledge-distill',
      }),
    );

    // 产物入库：sourceReferences 指向全部原料 id
    const all = store.list();
    const products = all.filter(e => e.tags.includes('distilled'));
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('蒸馏产物：fix 模式');
    expect(products[0].maturity).toBe('active');
    expect(products[0].origin).toBe('system');
    const refIds = products[0].sourceReferences.map(r => r.entryId);
    expect(refIds.sort()).toEqual(ores.map(o => o.id).sort());

    // 原料归档移出主区
    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('archived');
    }

    // 运行记录落数据区
    const runs = await service.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('executed');
    expect(runs[0].proposalId).toBe(proposals[0].id);
    expect(runs[0].materialIds.sort()).toEqual(ores.map(o => o.id).sort());
    expect(runs[0].productIds).toEqual([products[0].id]);

    // 全链路事件
    const stages = eventStages(await readEvents());
    expect(stages).toContain('proposal-posted');
    expect(stages).toContain('executed');

    // 提案终态
    expect((await distillStore().getProposal(proposals[0].id))?.status).toBe('executed');
  });

  it('WU done 事件驱动门槛检测（fire-and-forget 不阻塞）；非 done 忽略', async () => {
    seedOre(); seedOre(); seedOre();
    service.subscribeToEvents();

    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-x', status: 'in_progress' } });
    await new Promise(r => setTimeout(r, 100));
    expect(await listProposals()).toHaveLength(0);

    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-y', status: 'done' } });
    const fired = await waitFor(async () => (await listProposals()).length === 1);
    expect(fired).toBe(true);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
  });
});

describe('#366 冷启动灌入防御', () => {
  it('批量同 tag 的 system 来源条目经真实 store 全链路 → 不发卡、无事件、原料不动', async () => {
    for (let i = 0; i < 5; i++) {
      seedOre({ tags: ['deploy-checklist'], origin: 'system', title: `[Import] batch ${i}` });
    }
    await service.maybePropose({});

    expect(await listProposals()).toHaveLength(0);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    expect(await readEvents()).toHaveLength(0);
    expect(store.list().filter(e => e.tags.includes('deploy-checklist'))).toHaveLength(5);
  });
});

describe('reject 路径：零副作用', () => {
  it('reject → 原料不动、无产物、无运行记录；提案 rejected + 事件落盘', async () => {
    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({});
    const proposal = (await listProposals())[0];

    const result = await reject(proposal.id);
    expect(result.ok).toBe(true);
    expect(mockRunJson).not.toHaveBeenCalled();

    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('active');
    }
    expect(store.list().filter(e => e.tags.includes('distilled'))).toHaveLength(0);
    expect(await service.listRuns()).toHaveLength(0);
    expect((await distillStore().getProposal(proposal.id))?.status).toBe('rejected');
    expect(eventStages(await readEvents())).toContain('rejected');
  });

  it('重复 approve/reject 已终态提案 → 拒绝', async () => {
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    const proposal = (await listProposals())[0];
    await reject(proposal.id);
    expect((await approve(proposal.id)).kind).toBe('invalid');
    expect((await reject(proposal.id)).ok).toBe(false);
  });
});

describe('失败路径：不消费原料、不阻塞 WU 收尾', () => {
  it('LLM 异常 → 原料不归档、无产物；提案 failed + 失败运行记录 + 事件', async () => {
    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({});
    const proposal = (await listProposals())[0];

    mockRunJson.mockRejectedValue(new Error('provider timeout'));
    const result = await approve(proposal.id);
    expect(result.kind).toBe('failed');

    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('active');
    }
    expect(store.list().filter(e => e.tags.includes('distilled'))).toHaveLength(0);
    const runs = await service.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('failed');
    expect((await distillStore().getProposal(proposal.id))?.status).toBe('failed');
    expect(eventStages(await readEvents())).toContain('failed');
  });

  it('JSON 解析失败（runJson 抛 SystemExecutorJsonParseError 形态）→ 同样不消费原料', async () => {
    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({});
    const proposal = (await listProposals())[0];

    const parseErr = new SyntaxError('Unexpected token');
    parseErr.name = 'SystemExecutorJsonParseError';
    mockRunJson.mockRejectedValue(parseErr);
    const result = await approve(proposal.id);
    expect(result.kind).toBe('failed');
    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('active');
    }
    expect((await service.listRuns())[0].outcome).toBe('failed');
  });

  it('maybePropose 内部异常永不抛给 WU 收尾订阅链', async () => {
    // store.list 爆炸 → 事件订阅路径也必须吞掉
    vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('index corrupted'); });
    service.subscribeToEvents();
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-z', status: 'done' } });
    await new Promise(r => setTimeout(r, 150));
    // 不抛即通过；无提案无副作用
    expect(await listProposals()).toHaveLength(0);
  });
});

describe('token 预算熔断', () => {
  it('预算耗尽 → approve 跳过执行（不消费、不报错、提案保持 pending 可次日重试）', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '100';
    // 造当日已耗 200 > 100（getDailyTokenUsage 只计 workunit:tokens 的 billedTokens）
    await fileStore.appendJsonl(eventsFile, {
      type: 'workunit:tokens',
      source: 'test',
      payload: JSON.stringify({ billedTokens: 200 }),
      createdAt: new Date().toISOString(),
    });

    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({});
    const proposal = (await listProposals())[0];

    const result = await approve(proposal.id);
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.skipped).toBe('budget-exhausted');
    expect(mockRunJson).not.toHaveBeenCalled();
    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('active');
    }
    expect((await distillStore().getProposal(proposal.id))?.status).toBe('pending');
    expect(await service.listRuns()).toHaveLength(0);
    const events = await readEvents();
    const skipped = events.find(e => String(e.payload).includes('budget-exhausted'));
    expect(skipped).toBeTruthy();
  });
});

describe('发卡降级与去重', () => {
  it('发卡失败静默跳过：提案标记 card-failed 不阻塞后续提案', async () => {
    seedOre(); seedOre(); seedOre();
    mockCreateCardMessage.mockRejectedValue(new Error('channel write failed'));
    await expect(service.maybePropose({})).resolves.toBeUndefined();

    const proposals = await listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('card-failed');
    expect(eventStages(await readEvents())).toContain('card-failed');

    // 发卡恢复后再触发 → 新提案正常发卡（不被 card-failed 提案阻塞）
    mockCreateCardMessage.mockResolvedValue({ id: 'msg-2' });
    await service.maybePropose({});
    expect(await listProposals()).toHaveLength(2);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(2);
  });

  it('已有 pending 提案 → 不重复发卡', async () => {
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    await service.maybePropose({});
    expect(await listProposals()).toHaveLength(1);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
  });

  it('#系统 频道缺失 → 静默跳过（card-failed），不抛', async () => {
    // 换一个没有频道的新 fileStore
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-nochan-'));
    const svc = new DistillService({
      store, fileStore: new FileStore(emptyDir), dataDir, eventsFile,
    });
    seedOre(); seedOre(); seedOre();
    await expect(svc.maybePropose({})).resolves.toBeUndefined();
    const proposals = await getReviewProposalAdapter<DistillProposal>('distill')!.store.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('card-failed');
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe('7 天烧钱熔断', () => {
  it('蒸馏运行后 7 天内门槛命中也不再提案', async () => {
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    const proposal = (await listProposals())[0];
    mockRunJson.mockResolvedValue({ products: [{ title: 'P', content: 'C', tags: [] }] });
    await approve(proposal.id);

    // 新矿石到位、信号命中，但距上次运行 < 7 天 → 熔断
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    expect(await listProposals()).toHaveLength(1);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
  });

  it('失败运行推进熔断时钟（不立即再提案），但原料不老化作废', async () => {
    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({});
    const proposal = (await listProposals())[0];
    mockRunJson.mockRejectedValue(new Error('provider down'));
    await approve(proposal.id);

    // 熔断时钟已推进（失败也烧了 token）→ 不再发新提案
    await service.maybePropose({});
    expect(await listProposals()).toHaveLength(1);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    // 原料不被老化：留在主区，消费基线未推进（下次熔断期外门槛仍能看到它们）
    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('active');
    }
  });

  it('LLM 产出空 products → 不消费原料，运行记录 outcome=executed productIds=[]', async () => {
    const ores = [seedOre(), seedOre(), seedOre()];
    await service.maybePropose({});
    const proposal = (await listProposals())[0];
    mockRunJson.mockResolvedValue({ products: [] });
    const result = await approve(proposal.id);
    expect(result.kind).toBe('executed');
    for (const ore of ores) {
      expect(store.get(ore.id)?.maturity).toBe('active');
    }
    const runs = await service.listRuns();
    expect(runs[0].outcome).toBe('executed');
    expect(runs[0].productIds).toEqual([]);
  });
});
