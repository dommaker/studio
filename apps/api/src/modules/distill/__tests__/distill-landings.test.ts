/**
 * distill-landings (#145) — 蒸馏产物三分落地分流测试
 *
 * 覆盖（对应 #145 AC）：
 *   - normalize 类型解析：skill/constraint/preference/execution-knowledge 直通；
 *     缺类型 / 未知类型 / 约束缺 change → 回落 knowledge（#143 行为）
 *   - skill 类 → skills 库提案（skillStore draft + proposalStore pending + sourceReferences 指针）
 *   - constraint 类 → constraint-drafts.jsonl 变更草案（add/override/retire + ymlSnippet），不改约束文件
 *   - preference/execution-knowledge 类 → 角色记忆草稿（studio 系统角色，sourceRefs 指针）+ memory_proposal 卡
 *   - 落地通道抛错 / 未接线 → 回落知识条目，产物不丢、原料照归档
 *
 * mock 点：getSystemExecutor（LLM seam）+ channelMessageService + postMemoryProposalCard
 * + skillStore/proposalStore（路径固定 ~/.studio，不可触真实数据区）；
 * 约束落盘与角色记忆走真实实现（临时 dataDir / tmpdir 重定向）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { FileKnowledgeStore, type KnowledgeEntry } from '@dommaker/harness';

const {
  mockRunJson,
  mockCreateCardMessage,
  mockPostMemoryCard,
  mockSkillCreate,
  mockProposalCreate,
} = vi.hoisted(() => ({
  mockRunJson: vi.fn(),
  mockCreateCardMessage: vi.fn(),
  mockPostMemoryCard: vi.fn(),
  mockSkillCreate: vi.fn(),
  mockProposalCreate: vi.fn(),
}));

vi.mock('../../agents/system-executor.js', () => ({
  getSystemExecutor: () => ({ runJson: mockRunJson }),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage },
}));

vi.mock('../../role-memory/memory-proposal-card.js', () => ({
  postMemoryProposalCard: mockPostMemoryCard,
}));

vi.mock('../../skills/skill-store.js', () => ({
  skillStore: { create: mockSkillCreate },
}));

vi.mock('../../skills/proposal-store.js', () => ({
  proposalStore: { create: mockProposalCreate },
}));

import {
  DistillService,
  normalizeDistillProducts,
  type DistillProposal,
} from '../distill-service.js';
import { createSkillLanding, createConstraintLanding, createMemoryLanding } from '../distill-landings.js';
import { roleMemoryStore } from '../../role-memory/role-memory.js';

let tmpDir: string;
let fileStore: FileStore;
let store: FileKnowledgeStore;
let dataDir: string;
let eventsFile: string;
let service: DistillService;
let companiesDir: string;
/** 本用例创建的角色记忆目录（tmpdir 重定向根下的 per-role 目录，外科式清理） */
const createdRoleIds: string[] = [];

let oreSeq = 0;
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

/** 造矿石 → 门槛 → 发卡，返回 pending 提案 */
async function propose(oreCount = 3): Promise<DistillProposal & { status: string }> {
  for (let i = 0; i < oreCount; i++) seedOre();
  await service.maybePropose({ workUnitId: 'wu-1' });
  const proposals = await service.listProposals();
  expect(proposals).toHaveLength(1);
  expect(proposals[0].status).toBe('pending');
  return proposals[0];
}

function knowledgeProducts(): KnowledgeEntry[] {
  return store.list().filter(e => e.tags.includes('distilled'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-landings-'));
  dataDir = path.join(tmpDir, 'distill');
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  companiesDir = path.join(tmpDir, 'companies');
  fs.mkdirSync(companiesDir, { recursive: true });
  fs.writeFileSync(path.join(companiesDir, 'c1.json'), JSON.stringify({ id: 'c1', name: 'Default' }));
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
  mockPostMemoryCard.mockResolvedValue(undefined);
  mockSkillCreate.mockReturnValue({ id: 'skill-1' });
  mockProposalCreate.mockReturnValue({ id: 'sp-1' });
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const roleId of createdRoleIds.splice(0)) {
    fs.rmSync(path.join(os.tmpdir(), 'studio-test-role-memory', roleId), { recursive: true, force: true });
  }
});

describe('normalizeDistillProducts 类型解析', () => {
  it('四类合法 type 直通；constraint 带 change', () => {
    const out = normalizeDistillProducts({
      products: [
        { type: 'skill', title: 's', content: 'c', tags: [] },
        { type: 'preference', title: 'p', content: 'c', tags: [] },
        { type: 'execution-knowledge', title: 'e', content: 'c', tags: [] },
        {
          type: 'constraint', title: 'k', content: 'c', tags: [],
          change: { action: 'add', constraintId: 'no-foo', level: 'guideline', message: 'm' },
        },
      ],
    });
    expect(out.map(p => p.type)).toEqual(['skill', 'preference', 'execution-knowledge', 'constraint']);
    expect(out[3].change).toEqual({ action: 'add', constraintId: 'no-foo', level: 'guideline', message: 'm', description: undefined });
  });

  it('缺 type / 未知 type → 回落 knowledge', () => {
    const out = normalizeDistillProducts({
      products: [
        { title: 'no-type', content: 'c', tags: [] },
        { type: 'wat', title: 'bad-type', content: 'c', tags: [] },
      ],
    });
    expect(out.map(p => p.type)).toEqual(['knowledge', 'knowledge']);
  });

  it('constraint 缺 change / action 非法 / 缺 constraintId → 回落 knowledge', () => {
    const out = normalizeDistillProducts({
      products: [
        { type: 'constraint', title: 'a', content: 'c', tags: [] },
        { type: 'constraint', title: 'b', content: 'c', tags: [], change: { action: 'explode', constraintId: 'x' } },
        { type: 'constraint', title: 'c', content: 'c', tags: [], change: { action: 'add' } },
      ],
    });
    expect(out.map(p => p.type)).toEqual(['knowledge', 'knowledge', 'knowledge']);
  });

  it('constraint 的 level 走白名单（非法 level 丢弃，不进草案）', () => {
    const out = normalizeDistillProducts({
      products: [
        { type: 'constraint', title: 'a', content: 'c', tags: [], change: { action: 'add', constraintId: 'x', level: 'bogus' } },
        { type: 'constraint', title: 'b', content: 'c', tags: [], change: { action: 'add', constraintId: 'y', level: 'iron_law' } },
      ],
    });
    expect(out[0].type).toBe('constraint');
    expect(out[0].change?.level).toBeUndefined();
    expect(out[1].change?.level).toBe('iron_law');
  });
});

describe('三分路由（注入 fake landings）', () => {
  it('skill 产物走 skill 通道：sourceReferences 指针 + 原料归档 + 运行记录分布', async () => {
    const skillLanding = vi.fn().mockResolvedValue('sp-1');
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { skill: skillLanding },
    });
    const proposal = await propose();
    const materialIds = proposal.materialIds;

    mockRunJson.mockResolvedValue({
      products: [{ type: 'skill', title: 'TDD 接缝模式', content: '过程性知识正文', tags: ['tdd'] }],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);

    // 通道调用：产物 + 原料指针
    expect(skillLanding).toHaveBeenCalledTimes(1);
    const [product, ctx] = skillLanding.mock.calls[0];
    expect(product.type).toBe('skill');
    expect(ctx.materialIds.sort()).toEqual(materialIds.slice().sort());
    expect(ctx.proposalId).toBe(proposal.id);

    // 不落知识条目；原料归档；运行记录带分布
    expect(knowledgeProducts()).toHaveLength(0);
    for (const id of materialIds) expect(store.get(id)?.maturity).toBe('archived');
    const runs = await service.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].landings?.skill).toEqual(['sp-1']);
    expect(runs[0].productIds).toContain('sp-1');
  });

  it('混合产物：skill + preference + 无类型各一 → 三路各得其所，lastConsumedAt 推进', async () => {
    const skillLanding = vi.fn().mockResolvedValue('sp-1');
    const memoryLanding = vi.fn().mockResolvedValue('draft-1');
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { skill: skillLanding, memory: memoryLanding },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [
        { type: 'skill', title: 's', content: 'c', tags: [] },
        { type: 'preference', title: 'p', content: 'c', tags: [] },
        { title: 'k', content: 'c', tags: [] },
      ],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);
    expect(memoryLanding).toHaveBeenCalledTimes(1);
    expect(knowledgeProducts()).toHaveLength(1);

    const runs = await service.listRuns();
    expect(runs[0].landings).toEqual({ knowledge: [knowledgeProducts()[0].id], skill: ['sp-1'], constraint: [], memory: ['draft-1'] });
    // productIds 含全部落地产物 id → 消费基线推进（下轮不重复提案本批原料）
    expect(runs[0].productIds).toHaveLength(3);
  });

  it('落地通道抛错 → 回落知识条目，产物不丢、原料照归档', async () => {
    const skillLanding = vi.fn().mockRejectedValue(new Error('skill store boom'));
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { skill: skillLanding },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [{ type: 'skill', title: 's', content: 'c', tags: [] }],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);

    const products = knowledgeProducts();
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('s');
    for (const id of proposal.materialIds) expect(store.get(id)?.maturity).toBe('archived');
  });
});

describe('constraint 通道（真实落盘）', () => {
  it('add 类约束产物 → constraint-drafts.jsonl 草案（ymlSnippet + sourceReferences），不改约束文件', async () => {
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { constraint: createConstraintLanding({ fileStore, dataDir }) },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [{
        type: 'constraint', title: '禁止跳级推理', content: '数字异常先验证含义再定根因', tags: ['debug'],
        change: { action: 'add', constraintId: 'no-leap-diagnosis', level: 'guideline', message: '禁止跳级推理', description: '先验证再断言' },
      }],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);
    expect(knowledgeProducts()).toHaveLength(0);

    const drafts = await fileStore.readJsonl<Record<string, unknown>>(path.join(dataDir, 'constraint-drafts.jsonl'));
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft.status).toBe('pending');
    expect(draft.action).toBe('add');
    expect(draft.constraintId).toBe('no-leap-diagnosis');
    expect(String(draft.ymlSnippet)).toContain('no-leap-diagnosis');
    expect(String(draft.ymlSnippet)).toContain('禁止跳级推理');
    expect(draft.sourceReferences).toEqual(expect.arrayContaining(proposal.materialIds));
    expect(draft.distillProposalId).toBe(proposal.id);
  });

  it('retire 类约束产物 → config.yml 退役 YAML 草案（harness retire 落点，不动任何约束文件）', async () => {
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { constraint: createConstraintLanding({ fileStore, dataDir }) },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [{
        type: 'constraint', title: '退役过时约束', content: '该约束已无可被违反的未来场景', tags: [],
        change: { action: 'retire', constraintId: 'old-rule' },
      }],
    });
    await service.approve(proposal.id);

    const drafts = await fileStore.readJsonl<Record<string, unknown>>(path.join(dataDir, 'constraint-drafts.jsonl'));
    expect(drafts[0].action).toBe('retire');
    expect(drafts[0].constraintId).toBe('old-rule');
    // retire 草案 = config.yml 退役 YAML（harness retire 落点），不改任何约束文件
    expect(String(drafts[0].ymlSnippet)).toContain('old-rule');
    expect(String(drafts[0].ymlSnippet)).toContain('enabled: false');
  });
});

describe('memory 通道（真实 roleMemoryStore + mock 发卡）', () => {
  it('preference 产物 → studio 系统角色记忆草稿（sourceRefs 指针）+ memory_proposal 卡', async () => {
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { memory: createMemoryLanding({ fileStore }) },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [{ type: 'preference', title: '回复用电报风', content: '砍掉废话', tags: ['style'] }],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);
    expect(knowledgeProducts()).toHaveLength(0);

    // studio 系统角色 = 唯一 profile
    const profiles = await fileStore.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('studio');
    createdRoleIds.push(profiles[0].id);

    const drafts = await roleMemoryStore.readDraft(profiles[0].id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('preference');
    expect(drafts[0].title).toBe('回复用电报风');
    expect(drafts[0].review).toBe('manual');
    expect(drafts[0].sourceRefs?.sort()).toEqual(proposal.materialIds.slice().sort());

    // memory_proposal 卡（#101 通道）
    expect(mockPostMemoryCard).toHaveBeenCalledTimes(1);
    const [entries, ctx] = mockPostMemoryCard.mock.calls[0];
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(drafts[0].id);
    expect(ctx.source).toBe('distill');
  });
});

describe('skill 通道（真实 createSkillLanding + mock store）', () => {
  it('skill 产物 → skillStore draft + proposalStore pending（metadata 带原料指针）+ skill_review_request 卡', async () => {
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { skill: createSkillLanding({ fileStore, companiesDir }) },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [{ type: 'skill', title: '迁移执行法', content: 'Round 分解 → 转换 → 验证', tags: ['migration'] }],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);

    expect(mockSkillCreate).toHaveBeenCalledTimes(1);
    const skillInput = mockSkillCreate.mock.calls[0][0];
    expect(skillInput.companyId).toBe('c1');
    expect(skillInput.status).toBe('draft');
    expect(skillInput.source).toBe('distill');
    const meta = JSON.parse(skillInput.metadata);
    expect(meta.sourceReferences.sort()).toEqual(proposal.materialIds.slice().sort());

    expect(mockProposalCreate).toHaveBeenCalledTimes(1);
    const proposalInput = mockProposalCreate.mock.calls[0][0];
    expect(proposalInput.skillId).toBe('skill-1');
    expect(proposalInput.status).toBe('pending');
    expect(proposalInput.metadata.sourceReferences.sort()).toEqual(proposal.materialIds.slice().sort());

    // 沿用 skills 通道既有人审通知卡
    const cardCalls = mockCreateCardMessage.mock.calls.filter(c => c[3] === 'skill_review_request');
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0][4]).toEqual({ proposalId: 'sp-1', skillId: 'skill-1' });
  });

  it('无可用公司 → 通道返回 null → 回落知识条目', async () => {
    fs.rmSync(companiesDir, { recursive: true, force: true });
    fs.mkdirSync(companiesDir, { recursive: true });
    service = new DistillService({
      store, fileStore, dataDir, eventsFile,
      landings: { skill: createSkillLanding({ fileStore, companiesDir }) },
    });
    const proposal = await propose();

    mockRunJson.mockResolvedValue({
      products: [{ type: 'skill', title: 's', content: 'c', tags: [] }],
    });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);
    expect(mockSkillCreate).not.toHaveBeenCalled();
    expect(knowledgeProducts()).toHaveLength(1);
  });
});
