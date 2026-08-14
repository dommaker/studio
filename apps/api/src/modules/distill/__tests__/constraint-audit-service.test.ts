/**
 * constraint-audit-service (#146) — 存量约束审计挂蒸馏事件测试（对应 #146 AC）
 *
 * 覆盖：
 *   - 触发：蒸馏运行产出新约束（landings.constraint 非空）→ 审计 → 退役建议人审卡
 *   - 不触发：蒸馏未产出新约束 → 不跑审计（零 LLM 调用、零提案）
 *   - approve → 走 retire 执行（custom-constraints.yml 条目内 retired 段，规则原文保留，
 *     可恢复）；reject → 零副作用（文件不动）且人判保留不再提案
 *   - 防再引入保护：LLM 以白名单外理由建议退役防再引入型约束 → 被闸门丢弃，不出卡
 *   - 降级：LLM 失败永不抛；预算耗尽跳过审计；无 constraintsFile 跳过；pending 去重
 *
 * mock 点同 distill-service.test：getSystemExecutor（LLM seam）+ channelMessageService；
 * 约束文件与 package.json 走临时目录（deps.constraintsFile / deps.packageJsonFile）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
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

import { DistillService } from '../distill-service.js';
import type { DistillRun } from '../distill-store.js';

let tmpDir: string;
let fileStore: FileStore;
let store: FileKnowledgeStore;
let dataDir: string;
let eventsFile: string;
let constraintsFile: string;
let packageJsonFile: string;
let service: DistillService;

const CONSTRAINTS_YML = `custom_constraints:
  no_redis_import:
    id: no_redis_import
    level: iron_law
    rule: "NO REDIS/IREDIS IMPORTS"
    message: "禁止引入 Redis/ioredis 依赖。项目使用 MemoryStore 替代"
  prisma_schema_needs_migration:
    id: prisma_schema_needs_migration
    level: iron_law
    message: "修改 schema.prisma 必须同时创建 migration 文件"
`;

let oreSeq = 0;
function seedOre(): KnowledgeEntry {
  oreSeq += 1;
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: `ore-${oreSeq}`,
    type: 'guideline',
    title: `[Session Fix] ore ${oreSeq}`,
    content: `Commit: abc${oreSeq}\nMessage: fix\nFiles: a.ts`,
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
  };
  store.save(entry);
  return entry;
}

/** 造一条「产出新约束」的蒸馏运行（approve 链路外直驱 runConstraintAudit 用） */
function makeConstraintRun(id = 'run-c1'): DistillRun {
  return {
    id,
    proposalId: 'dp-x',
    executedAt: new Date().toISOString(),
    outcome: 'executed',
    signals: { topicTags: [], manualCount: 0 },
    materialIds: ['ore-x'],
    productIds: ['draft-1'],
    landings: { knowledge: [], skill: [], constraint: ['draft-1'], memory: [] },
  };
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constraint-audit-svc-'));
  dataDir = path.join(tmpDir, 'distill');
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  constraintsFile = path.join(tmpDir, 'custom-constraints.yml');
  packageJsonFile = path.join(tmpDir, 'package.json');
  fs.writeFileSync(constraintsFile, CONSTRAINTS_YML, 'utf-8');
  fs.writeFileSync(packageJsonFile, JSON.stringify({ dependencies: { express: '^4' } }), 'utf-8');
  fileStore = new FileStore(tmpDir);
  store = new FileKnowledgeStore({ baseDir: path.join(tmpDir, 'knowledge') });
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-system', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null, discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  eventBus.unsubscribeAll?.('workunit.status_changed');
  service = new DistillService({
    store, fileStore, dataDir, eventsFile,
    constraintsFile,
    packageJsonFile,
    landings: { constraint: async () => 'draft-1' },
  });
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  resetDailyTokenBudgetState();
  delete process.env.STUDIO_TOKEN_BUDGET_GUARD;
  delete process.env.STUDIO_DAILY_TOKEN_BUDGET;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('触发：蒸馏产出新约束 → 存量审计 → 退役建议人审卡', () => {
  it('端到端：approve 蒸馏（constraint 落地）→ 审计 LLM 出建议 → 提案 + 卡 + 事件', async () => {
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    const proposal = (await service.listProposals())[0];

    mockRunJson
      .mockResolvedValueOnce({ // 蒸馏调用：产出一条约束产物
        products: [{ type: 'constraint', title: '新约束', content: '边界', tags: [], change: { action: 'add', constraintId: 'new_rule', message: 'm' } }],
      })
      .mockResolvedValueOnce({ // 审计调用：prisma 约束作用对象已消失
        suggestions: [{ constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已从代码库删除' }],
      });

    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);
    expect(mockRunJson).toHaveBeenCalledTimes(2);

    // 审计提案落盘 + 发卡（第二张卡 = constraint_audit_proposal）
    const audits = await service.listAuditProposals();
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('pending');
    expect(audits[0].suggestions).toEqual([
      { constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已从代码库删除' },
    ]);
    expect(audits[0].auditedCount).toBe(2);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(2);
    expect(mockCreateCardMessage.mock.calls[1][3]).toBe('constraint_audit_proposal');
    expect(mockCreateCardMessage.mock.calls[1][4].auditProposalId).toBe(audits[0].id);
    expect(eventStages(await readEvents())).toContain('audit-proposal-posted');
  });

  it('直驱 runConstraintAudit：零建议 → 不出卡不落事件（零噪音口径）', async () => {
    mockRunJson.mockResolvedValue({ suggestions: [] });
    await service.runConstraintAudit(makeConstraintRun());
    expect(await service.listAuditProposals()).toHaveLength(0);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
    expect(eventStages(await readEvents())).not.toContain('audit-proposal-posted');
  });
});

describe('不触发：蒸馏未产出新约束 → 不跑审计', () => {
  it('蒸馏产物全是 knowledge → 无审计 LLM 调用、无审计提案', async () => {
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    const proposal = (await service.listProposals())[0];

    mockRunJson.mockResolvedValue({ products: [{ title: 'P', content: 'C', tags: [] }] });
    const result = await service.approve(proposal.id);
    expect(result.ok).toBe(true);
    expect(mockRunJson).toHaveBeenCalledTimes(1); // 只有蒸馏调用
    expect(await service.listAuditProposals()).toHaveLength(0);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1); // 只有 distill_proposal 卡
  });

  it('蒸馏运行失败 → 不触发审计', async () => {
    seedOre(); seedOre(); seedOre();
    await service.maybePropose({});
    const proposal = (await service.listProposals())[0];
    mockRunJson.mockRejectedValue(new Error('provider down'));
    await service.approve(proposal.id);
    expect(mockRunJson).toHaveBeenCalledTimes(1);
    expect(await service.listAuditProposals()).toHaveLength(0);
  });
});

describe('approve：走 retire 执行（retired 元数据段，规则原文保留）', () => {
  async function seedPendingAudit(): Promise<string> {
    mockRunJson.mockResolvedValue({
      suggestions: [{ constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已从代码库删除' }],
    });
    await service.runConstraintAudit(makeConstraintRun());
    const audits = await service.listAuditProposals();
    expect(audits).toHaveLength(1);
    return audits[0].id;
  }

  it('approve → custom-constraints.yml 条目内追加 retired 段（原文保留），提案 executed + 事件', async () => {
    const auditId = await seedPendingAudit();

    const result = await service.approveAudit(auditId);
    expect(result.ok).toBe(true);
    expect(result.retiredIds).toEqual(['prisma_schema_needs_migration']);

    // 落盘形态：retired 元数据段（at/reason 含判据），规则原文保留
    const raw = yaml.load(fs.readFileSync(constraintsFile, 'utf-8')) as {
      custom_constraints: Record<string, { message?: string; retired?: { at: string; reason: string } }>;
    };
    const entry = raw.custom_constraints.prisma_schema_needs_migration;
    expect(entry.retired?.reason).toContain('target-gone');
    expect(entry.retired?.reason).toContain('schema.prisma 已从代码库删除');
    expect(entry.message).toContain('schema.prisma'); // 原文保留（可恢复）
    expect(raw.custom_constraints.no_redis_import.retired).toBeUndefined(); // 未建议的不动

    expect((await service.getAuditProposal(auditId))?.status).toBe('executed');
    expect(eventStages(await readEvents())).toContain('audit-executed');
  });

  it('人审期间条目已被其它路径退役 → 跳过（幂等），提案仍 executed', async () => {
    const auditId = await seedPendingAudit();
    // 模拟人审期间另一条路径已退役该约束
    fs.writeFileSync(constraintsFile, `${CONSTRAINTS_YML}`.replace(
      '    message: "修改 schema.prisma 必须同时创建 migration 文件"',
      '    message: "修改 schema.prisma 必须同时创建 migration 文件"\n    retired:\n      at: "2026-08-14T00:00:00.000Z"\n      reason: "其它路径已退役"',
    ), 'utf-8');

    const result = await service.approveAudit(auditId);
    expect(result.ok).toBe(true);
    expect(result.retiredIds).toEqual([]);
    expect(result.skippedIds).toEqual(['prisma_schema_needs_migration']); // 跳过名单人审可见
    expect((await service.getAuditProposal(auditId))?.status).toBe('executed');
  });

  it('已终态提案重复 approve → 拒绝', async () => {
    const auditId = await seedPendingAudit();
    await service.approveAudit(auditId);
    expect((await service.approveAudit(auditId)).ok).toBe(false);
    expect((await service.approveAudit('nope')).ok).toBe(false);
  });
});

describe('reject：零副作用 + 人判保留不再提案', () => {
  it('reject → 约束文件不动、提案 rejected + 事件；同约束后续不再进审计输入', async () => {
    const before = fs.readFileSync(constraintsFile, 'utf-8');
    mockRunJson.mockResolvedValue({
      suggestions: [{ constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: '对象消失' }],
    });
    await service.runConstraintAudit(makeConstraintRun());
    const auditId = (await service.listAuditProposals())[0].id;

    const result = await service.rejectAudit(auditId);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(constraintsFile, 'utf-8')).toBe(before); // 零副作用
    expect((await service.getAuditProposal(auditId))?.status).toBe('rejected');
    expect(eventStages(await readEvents())).toContain('audit-rejected');

    // 人判保留：后续运行即使 LLM 再建议该约束，也被剔除出审计输入 → 不出卡
    vi.clearAllMocks();
    mockRunJson.mockResolvedValue({
      suggestions: [{ constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: '对象消失' }],
    });
    await service.runConstraintAudit(makeConstraintRun('run-c2'));
    // LLM 收到的审计输入应只剩 no_redis_import（prisma 已人判保留）
    const auditPrompt = mockRunJson.mock.calls[0]?.[0] as string;
    expect(auditPrompt).not.toContain('prisma_schema_needs_migration');
    expect(await service.listAuditProposals()).toHaveLength(1);
  });
});

describe('防再引入保护（#139 草案判据）', () => {
  it('LLM 以「技术存量清零」建议退役 no_redis_import → 白名单闸门丢弃，不出卡', async () => {
    mockRunJson.mockResolvedValue({
      suggestions: [
        { constraintId: 'no_redis_import', category: 'tech-absent', rationale: 'package.json 已无 redis 依赖' },
        { constraintId: 'no_redis_import', category: 'zero-violations', rationale: '长期零违规' },
      ],
    });
    await service.runConstraintAudit(makeConstraintRun());
    expect(await service.listAuditProposals()).toHaveLength(0);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });
});

describe('降级与去重', () => {
  it('LLM 异常 → 永不抛、无提案、不出卡', async () => {
    mockRunJson.mockRejectedValue(new Error('provider timeout'));
    await expect(service.runConstraintAudit(makeConstraintRun())).resolves.toBeUndefined();
    expect(await service.listAuditProposals()).toHaveLength(0);
  });

  it('预算耗尽 → 跳过审计（零 LLM 调用）', async () => {
    process.env.STUDIO_TOKEN_BUDGET_GUARD = 'on';
    process.env.STUDIO_DAILY_TOKEN_BUDGET = '100';
    await fileStore.appendJsonl(eventsFile, {
      type: 'workunit:tokens', source: 'test',
      payload: JSON.stringify({ billedTokens: 200 }),
      createdAt: new Date().toISOString(),
    });
    await service.runConstraintAudit(makeConstraintRun());
    expect(mockRunJson).not.toHaveBeenCalled();
    expect(await service.listAuditProposals()).toHaveLength(0);
  });

  it('未装配 constraintsFile → 跳过审计（零 LLM 调用）', async () => {
    const svc = new DistillService({ store, fileStore, dataDir, eventsFile });
    await svc.runConstraintAudit(makeConstraintRun());
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it('已有 pending 审计提案 → 不重复审计发卡', async () => {
    mockRunJson.mockResolvedValue({
      suggestions: [{ constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: '对象消失' }],
    });
    await service.runConstraintAudit(makeConstraintRun());
    await service.runConstraintAudit(makeConstraintRun('run-c2'));
    expect(await service.listAuditProposals()).toHaveLength(1);
    expect(mockRunJson).toHaveBeenCalledTimes(1); // 第二次不进 LLM
  });

  it('发卡失败 → 提案 card-failed + 事件，不阻塞后续审计', async () => {
    mockCreateCardMessage.mockRejectedValue(new Error('channel write failed'));
    mockRunJson.mockResolvedValue({
      suggestions: [{ constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: '对象消失' }],
    });
    await service.runConstraintAudit(makeConstraintRun());
    const audits = await service.listAuditProposals();
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe('card-failed');
    expect(eventStages(await readEvents())).toContain('audit-card-failed');
  });
});
