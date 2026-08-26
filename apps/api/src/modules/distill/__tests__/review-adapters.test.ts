/**
 * review-adapters (#351) — distill 域三 adapter 配置与卡片内容测试
 *
 * 覆盖自三张旧卡测试（distill-proposal-card/gc-proposal-card/constraint-audit-card）的
 * 内容断言收敛而来（发卡投放本身归 review-proposal/card.test.ts）：
 *   - 注册形态：kind/cardType/storeNamespace（沿用历史文件名）
 *   - renderCardContent：三类卡正文与 cardData 形状（与旧实现逐字段一致）
 *   - onApprove/onReject 委托 effects（审批后动作归 DistillService）
 *   - rejectedGcEntryIds / rejectedAuditConstraintIds 人判保留集
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { clearReviewProposalAdapters, getReviewProposalAdapter } from '../../review-proposal/registry.js';
import {
  registerDistillReviewAdapters,
  rejectedAuditConstraintIds,
  rejectedGcEntryIds,
  type ConstraintAuditProposal,
  type DistillProposal,
  type DistillReviewEffects,
  type GcProposal,
} from '../review-adapters.js';

const distillProposal: DistillProposal = {
  id: 'dp-1',
  createdAt: new Date().toISOString(),
  materialIds: ['ore-1', 'ore-2'],
  materials: [{ id: 'ore-1', title: '[Session Fix] 修复竞态' }, { id: 'ore-2', title: '[Session Fix] 修复超时' }],
  signals: { topicTags: ['session-summary'], manualCount: 2 },
  triggerWorkUnitId: 'wu-1',
};

const gcProposal: GcProposal = {
  id: 'gc-1',
  createdAt: new Date().toISOString(),
  runId: 'run-1',
  candidates: [
    { entryId: 'e-1', title: '过时条目一', zeroRefStreak: 3, zeroRefCycles: ['2026-07-01'], reason: '连续 3 个蒸馏周期零引用' },
    { entryId: 'e-2', title: '过时条目二', zeroRefStreak: 3, zeroRefCycles: ['2026-07-01'], reason: '连续 3 个蒸馏周期零引用' },
  ],
  forced: true,
  mainAreaCount: 205,
};

const auditProposal: ConstraintAuditProposal = {
  id: 'audit-1',
  createdAt: new Date().toISOString(),
  runId: 'run-1',
  suggestions: [
    { constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已删除' },
  ],
  auditedCount: 2,
};

let tmpDir: string;
let effects: DistillReviewEffects & {
  executeDistill: ReturnType<typeof vi.fn>;
  onDistillRejected: ReturnType<typeof vi.fn>;
  executeGc: ReturnType<typeof vi.fn>;
  onGcRejected: ReturnType<typeof vi.fn>;
  executeAudit: ReturnType<typeof vi.fn>;
  onAuditRejected: ReturnType<typeof vi.fn>;
};
let adapters: ReturnType<typeof registerDistillReviewAdapters>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-adapters-'));
  effects = {
    executeDistill: vi.fn(async () => ({ status: 'executed' as const })),
    onDistillRejected: vi.fn(async () => {}),
    executeGc: vi.fn(async () => ({ status: 'executed' as const })),
    onGcRejected: vi.fn(async () => {}),
    executeAudit: vi.fn(async () => ({ status: 'executed' as const })),
    onAuditRejected: vi.fn(async () => {}),
  };
  adapters = registerDistillReviewAdapters({
    fileStore: new FileStore(tmpDir),
    dataDir: tmpDir,
    effects,
  });
});

afterEach(() => {
  clearReviewProposalAdapters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('注册形态', () => {
  it('三个 kind 注册进正本注册表；storeNamespace 沿用历史文件名', async () => {
    expect(getReviewProposalAdapter('distill')).toBe(adapters.distill);
    expect(getReviewProposalAdapter('gc')).toBe(adapters.gc);
    expect(getReviewProposalAdapter('audit')).toBe(adapters.audit);
    expect(adapters.distill.cardType).toBe('distill_proposal');
    expect(adapters.gc.cardType).toBe('gc_proposal');
    expect(adapters.audit.cardType).toBe('constraint_audit_proposal');
    // store 命名空间 → 历史文件名（append-only 历史不动）
    await adapters.distill.store.appendProposal(distillProposal);
    await adapters.gc.store.appendProposal(gcProposal);
    await adapters.audit.store.appendProposal(auditProposal);
    expect(fs.existsSync(path.join(tmpDir, 'proposals.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'gc-proposals.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'constraint-audits.jsonl'))).toBe(true);
  });
});

describe('renderCardContent', () => {
  it('distill：正文含原料/命中信号/预期产出；cardData 带 proposalId + 原料清单 + 信号', () => {
    const { content, cardData } = adapters.distill.renderCardContent(distillProposal);
    expect(content).toContain('知识蒸馏提案');
    expect(content).toContain('原料（2 条）');
    expect(content).toContain('[Session Fix] 修复竞态');
    expect(content).toContain('session-summary');
    expect(content).toContain('manual 过审新条目 2 条');
    expect(content).toContain('预期产出');
    expect(cardData).toEqual({
      proposalId: 'dp-1',
      materials: distillProposal.materials,
      signals: distillProposal.signals,
      workUnitId: 'wu-1',
    });
  });

  it('distill：无 triggerWorkUnitId → cardData.workUnitId = null', () => {
    const { cardData } = adapters.distill.renderCardContent({ ...distillProposal, triggerWorkUnitId: undefined });
    expect(cardData.workUnitId).toBeNull();
  });

  it('gc：正文含强制说明/候选+逐条理由；cardData 带 gcProposalId + 候选清单', () => {
    const { content, cardData } = adapters.gc.renderCardContent(gcProposal);
    expect(content).toContain('知识库 GC 候选清单');
    expect(content).toContain('主区 205 条已超容量上限（200），强制出清单');
    expect(content).toContain('过时条目一');
    expect(content).toContain('连续 3 个蒸馏周期零引用');
    expect(cardData).toEqual({
      gcProposalId: 'gc-1',
      runId: 'run-1',
      candidates: gcProposal.candidates,
      forced: true,
      mainAreaCount: 205,
    });
  });

  it('gc：非强制 → 周期计龄说明', () => {
    const { content } = adapters.gc.renderCardContent({ ...gcProposal, forced: false, mainAreaCount: 42 });
    expect(content).toContain('按蒸馏周期计龄（连续 3 周期零引用）；主区 42 条');
  });

  it('audit：正文含审计条数/建议+判据标签；cardData 带 auditProposalId + 建议清单', () => {
    const { content, cardData } = adapters.audit.renderCardContent(auditProposal);
    expect(content).toContain('存量约束退役建议');
    expect(content).toContain('审计存量约束 2 条');
    expect(content).toContain('prisma_schema_needs_migration');
    expect(content).toContain('schema.prisma 已删除');
    expect(cardData).toEqual({
      auditProposalId: 'audit-1',
      runId: 'run-1',
      suggestions: auditProposal.suggestions,
      auditedCount: 2,
    });
  });
});

describe('审批后动作委托 effects', () => {
  it('onApprove/onReject 按 kind 分发到对应 effects 方法', async () => {
    const d = { ...distillProposal, status: 'pending' as const, statusAt: '' };
    const g = { ...gcProposal, status: 'pending' as const, statusAt: '' };
    const a = { ...auditProposal, status: 'pending' as const, statusAt: '' };
    await adapters.distill.onApprove(d);
    await adapters.distill.onReject?.(d);
    await adapters.gc.onApprove(g);
    await adapters.gc.onReject?.(g);
    await adapters.audit.onApprove(a);
    await adapters.audit.onReject?.(a);
    expect(effects.executeDistill).toHaveBeenCalledWith(d);
    expect(effects.onDistillRejected).toHaveBeenCalledWith(d);
    expect(effects.executeGc).toHaveBeenCalledWith(g);
    expect(effects.onGcRejected).toHaveBeenCalledWith(g);
    expect(effects.executeAudit).toHaveBeenCalledWith(a);
    expect(effects.onAuditRejected).toHaveBeenCalledWith(a);
  });
});

describe('人判保留集', () => {
  it('rejectedGcEntryIds = 所有 rejected 提案的候选并集', async () => {
    await adapters.gc.store.appendProposal(gcProposal);
    await adapters.gc.store.appendStatus('gc-1', 'rejected');
    await adapters.gc.store.appendProposal({ ...gcProposal, id: 'gc-2' }); // pending 不计
    expect([...(await rejectedGcEntryIds(adapters.gc.store))].sort()).toEqual(['e-1', 'e-2']);
  });

  it('rejectedAuditConstraintIds = 所有 rejected 提案的建议并集', async () => {
    await adapters.audit.store.appendProposal(auditProposal);
    await adapters.audit.store.appendStatus('audit-1', 'rejected');
    expect([...(await rejectedAuditConstraintIds(adapters.audit.store))]).toEqual(['prisma_schema_needs_migration']);
  });
});
