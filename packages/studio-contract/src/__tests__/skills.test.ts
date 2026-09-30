/**
 * skills 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 + Skill/SkillManifestEntry/
 * DemotionProposal parity。正本 = skill-store.ts SkillRecord、skill-demotion.ts
 * DemotionProposal、manifest-loader 投影与 routes 实测 wire 行为。
 */

import { describe, it, expect } from 'vitest';
import {
  skillSchema,
  type Skill,
  skillListItemSchema,
  skillProposalViewSchema,
  skillDetailSchema,
  skillManifestEntrySchema,
  type SkillManifestEntry,
  skillsStatsSchema,
  skillUsageStatsSchema,
  demotionProposalSchema,
  type DemotionProposal,
  savedSkillProposalSchema,
  scanSkillProposalsResultSchema,
  extractSkillProposalResultSchema,
  listSkillsQuerySchema,
  discoverSkillsQuerySchema,
  skillsStatsQuerySchema,
  skillIdParamsSchema,
  listDemotionProposalsQuerySchema,
  demotionProposalIdParamsSchema,
  listSkillProposalsQuerySchema,
  executionIdParamsSchema,
  createSkillBodySchema,
  updateSkillBodySchema,
  retractDecideBodySchema,
  recordSkillUsageBodySchema,
  scanSkillProposalsBodySchema,
  skillListResponseSchema,
  skillDiscoverResponseSchema,
  skillManifestResponseSchema,
  skillDetailResponseSchema,
  skillResponseSchema,
  deleteSkillResponseSchema,
  skillsStatsResponseSchema,
  demotionProposalListResponseSchema,
  reviewDemotionResponseSchema,
  skillProposalListResponseSchema,
  scanSkillProposalsResponseSchema,
  extractSkillProposalResponseSchema,
  retractSkillResponseSchema,
} from '../skills.js';
import * as contractIndex from '../index.js';

/** skill-store.ts SkillRecord 全字段最小合法形状 */
const skillRow: Skill = {
  id: 'sk_1',
  companyId: 'comp-1',
  name: 'tdd-implement',
  source: 'manual',
  status: 'published',
  version: 1,
  autoLoad: false,
  isBuiltin: false,
  usageCount: 3,
  successRate: 0.67,
  avgDuration: 1200,
  extractedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const manifestEntryRow: SkillManifestEntry = {
  name: 'tdd-implement',
  description: '测试先行实现',
  agentTypes: ['implement'],
  triggers: ['实现', '开发'],
};

const demotionRow: DemotionProposal = {
  id: 'dp_1',
  skillName: 'old-skill',
  kind: 'archive',
  status: 'pending',
  reason: '零使用且已存在 40 天（> 30 天）',
  stats: { uses: 0, successRate: null, lastUsedAt: null, exposures: 2, ageDays: 40.1 },
  suggestedStatus: 'archived',
  createdAt: '2026-09-01T00:00:00.000Z',
  reviewedAt: null,
};

describe('skillSchema', () => {
  it('接受 SkillRecord 全字段（含可空 JSON 串字段）', () => {
    expect(skillSchema.parse(skillRow)).toEqual(skillRow);
    const full = skillSchema.parse({
      ...skillRow,
      roleId: 'role-1',
      category: 'code_gen',
      description: 'desc',
      prompt: 'body',
      trigger: '实现',
      agentTypes: '["implement"]',
      tools: '["fs"]',
      required: '[]',
      metadata: '{"k":1}',
    });
    expect(full.name).toBe('tdd-implement');
  });

  // strict:false 仓 z.infer 全字段退化可选 → Skill 是手写 interface；parity 兜漂移
  it('parity：Skill interface fixture 全键 = schema.shape 键且通过校验；必填字段删除即拒', () => {
    const full: Skill = {
      ...skillRow,
      roleId: 'role-1',
      category: 'code_gen',
      description: 'desc',
      prompt: 'body',
      trigger: '实现',
      agentTypes: '["implement"]',
      tools: '["fs"]',
      required: '[]',
      metadata: '{"k":1}',
    };
    expect(skillSchema.parse(full)).toEqual(full);
    expect(Object.keys(skillSchema.shape).sort()).toEqual(Object.keys(full).sort());
    for (const key of Object.keys(skillRow)) {
      const { [key]: _drop, ...rest } = skillRow as Record<string, unknown>;
      expect(skillSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('派生读形状', () => {
  it('list 行 = Skill + proposals[{id}]；detail = Skill + 提案视图', () => {
    expect(skillListItemSchema.parse({ ...skillRow, proposals: [{ id: 'p1' }] })).toBeTruthy();
    expect(skillListItemSchema.safeParse({ ...skillRow, proposals: [{}] }).success).toBe(false);

    const view = {
      id: 'p1',
      skillId: 'sk_1',
      status: 'pending',
      proposedBy: 'system',
      summary: null,
      proposedAt: '2026-09-01T00:00:00.000Z',
      reviewedAt: null,
    };
    expect(skillProposalViewSchema.parse(view)).toEqual(view);
    expect(skillDetailSchema.parse({ ...skillRow, proposals: [view] })).toBeTruthy();
  });

  it('stats 聚合形状（byCategory 记录 + topSkills）', () => {
    const stats = {
      totalSkills: 2,
      publishedSkills: 1,
      totalUsage: 5,
      avgSuccessRate: 0.5,
      avgDuration: 100,
      byCategory: { code_gen: { count: 1, usage: 5 } },
      topSkills: [{ id: 'sk_1', name: 'tdd', usageCount: 5, successRate: 0.5, avgDuration: 100 }],
    };
    expect(skillsStatsSchema.parse(stats)).toEqual(stats);
    expect(skillsStatsSchema.safeParse({ ...stats, byCategory: { x: {} } }).success).toBe(false);
  });
});

describe('SkillManifestEntry', () => {
  it('parity：interface fixture 全键 = schema.shape 键；agentTypes/triggers 必填数组', () => {
    expect(skillManifestEntrySchema.parse(manifestEntryRow)).toEqual(manifestEntryRow);
    expect(Object.keys(skillManifestEntrySchema.shape).sort()).toEqual(Object.keys(manifestEntryRow).sort());
    for (const key of Object.keys(manifestEntryRow)) {
      const { [key]: _drop, ...rest } = manifestEntryRow as Record<string, unknown>;
      expect(skillManifestEntrySchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('DemotionProposal', () => {
  it('parity：interface fixture 全键 = schema.shape 键；kind/status/suggestedStatus 词表', () => {
    expect(demotionProposalSchema.parse(demotionRow)).toEqual(demotionRow);
    expect(Object.keys(demotionProposalSchema.shape).sort()).toEqual(Object.keys(demotionRow).sort());
    for (const key of Object.keys(demotionRow)) {
      const { [key]: _drop, ...rest } = demotionRow as Record<string, unknown>;
      expect(demotionProposalSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
    expect(demotionProposalSchema.safeParse({ ...demotionRow, kind: 'bogus' }).success).toBe(false);
    expect(demotionProposalSchema.safeParse({ ...demotionRow, suggestedStatus: 'draft' }).success).toBe(false);
  });

  it('usage stats：successRate/lastUsedAt 可 null（无终态 WU 不编造）', () => {
    expect(skillUsageStatsSchema.parse({ uses: 0, successRate: null, lastUsedAt: null, exposures: 0 })).toBeTruthy();
    expect(skillUsageStatsSchema.safeParse({ uses: 1, successRate: 0.5, lastUsedAt: 't', exposures: 0 })).toBeTruthy();
  });
});

describe('请求 schema', () => {
  it('query/params 边界', () => {
    expect(listSkillsQuerySchema.parse({ page: '1', limit: '20' })).toEqual({ page: '1', limit: '20' });
    expect(discoverSkillsQuerySchema.parse({ q: 'tdd' })).toEqual({ q: 'tdd' });
    expect(skillsStatsQuerySchema.parse({ company_id: 'c1' })).toEqual({ company_id: 'c1' });
    expect(skillIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(listDemotionProposalsQuerySchema.parse({ scan: 'true', status: 'pending' })).toEqual({ scan: 'true', status: 'pending' });
    expect(demotionProposalIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(executionIdParamsSchema.safeParse({ executionId: '' }).success).toBe(false);
  });

  it('GET /proposals companyId 必填（原 VALIDATION 手写校验）', () => {
    expect(listSkillProposalsQuerySchema.parse({ companyId: 'c1' })).toEqual({ companyId: 'c1' });
    expect(listSkillProposalsQuerySchema.safeParse({}).success).toBe(false);
    expect(listSkillProposalsQuerySchema.safeParse({ companyId: '' }).success).toBe(false);
  });

  it('create/update body：companyId/name 必填，metadata 任意 JSON', () => {
    expect(createSkillBodySchema.parse({ companyId: 'c1', name: 'n' })).toEqual({ companyId: 'c1', name: 'n' });
    expect(createSkillBodySchema.safeParse({ name: 'n' }).success).toBe(false);
    expect(createSkillBodySchema.safeParse({ companyId: 'c1' }).success).toBe(false);
    expect(createSkillBodySchema.parse({ companyId: 'c1', name: 'n', metadata: { a: 1 } })).toBeTruthy();
    expect(updateSkillBodySchema.parse({})).toEqual({});
    expect(updateSkillBodySchema.parse({ name: 'x', roleId: 'r' })).toEqual({ name: 'x', roleId: 'r' });
  });

  it('retract/decide：decision 词表（原手写 guard）', () => {
    expect(retractDecideBodySchema.parse({ decision: 'confirm' })).toEqual({ decision: 'confirm' });
    expect(retractDecideBodySchema.parse({ decision: 'reject', messageId: 'm', channelId: 'c' })).toBeTruthy();
    expect(retractDecideBodySchema.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(retractDecideBodySchema.safeParse({}).success).toBe(false);
  });

  it('usage：success 收紧 boolean（原 truthy 消费）', () => {
    expect(recordSkillUsageBodySchema.parse({ success: true, durationMs: 100 })).toEqual({ success: true, durationMs: 100 });
    expect(recordSkillUsageBodySchema.parse({})).toEqual({});
    expect(recordSkillUsageBodySchema.safeParse({ success: 'yes' }).success).toBe(false);
  });

  it('proposals/scan body：companyId 必填', () => {
    expect(scanSkillProposalsBodySchema.parse({ companyId: 'c1' })).toEqual({ companyId: 'c1' });
    expect(scanSkillProposalsBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('响应 schema（统一 { data } / 分页壳）', () => {
  it('list 为分页壳；其余 { data }', () => {
    expect(skillListResponseSchema.parse({
      data: [{ ...skillRow, proposals: [] }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })).toBeTruthy();
    expect(skillDiscoverResponseSchema.parse({ data: [skillRow] })).toBeTruthy();
    expect(skillManifestResponseSchema.parse({ data: [manifestEntryRow] })).toBeTruthy();
    expect(skillDetailResponseSchema.parse({ data: { ...skillRow, proposals: [] } })).toBeTruthy();
    expect(skillResponseSchema.parse({ data: skillRow })).toBeTruthy();
    expect(deleteSkillResponseSchema.parse({ data: { success: true } })).toBeTruthy();
    expect(demotionProposalListResponseSchema.parse({ data: [demotionRow] })).toBeTruthy();
    expect(reviewDemotionResponseSchema.parse({ data: { success: true, status: 'approved' } })).toBeTruthy();
    expect(reviewDemotionResponseSchema.safeParse({ data: { success: true, status: 'bogus' } }).success).toBe(false);
    expect(skillProposalListResponseSchema.parse({ data: [{ id: 'p1' }] })).toBeTruthy();
    expect(scanSkillProposalsResponseSchema.parse({
      data: { scanned: 2, saved: 1, proposals: [{ skillId: 's', proposalId: 'p', autoPublished: true }] },
    })).toBeTruthy();
    expect(extractSkillProposalResponseSchema.parse({ data: { extracted: false, message: 'No reusable pattern found' } })).toBeTruthy();
    expect(extractSkillProposalResponseSchema.parse({
      data: { extracted: true, skillId: 's', proposalId: 'p', autoPublished: false, proposal: { name: 'x' } },
    })).toBeTruthy();
    expect(retractSkillResponseSchema.parse({ data: { success: true, status: 'under_review' } })).toBeTruthy();
    expect(skillsStatsResponseSchema.parse({
      data: {
        totalSkills: 0, publishedSkills: 0, totalUsage: 0, avgSuccessRate: 0, avgDuration: 0,
        byCategory: {}, topSkills: [],
      },
    })).toBeTruthy();
  });

  it('savedSkillProposal / 结果形状拒绝缺键', () => {
    expect(savedSkillProposalSchema.safeParse({ skillId: 's' }).success).toBe(false);
    expect(scanSkillProposalsResultSchema.safeParse({ scanned: 1 }).success).toBe(false);
    expect(extractSkillProposalResultSchema.safeParse({}).success).toBe(false);
  });

  it('index.ts 出口包含 skills 域 schema', () => {
    expect(contractIndex.skillSchema).toBe(skillSchema);
    expect(contractIndex.skillManifestEntrySchema).toBe(skillManifestEntrySchema);
    expect(contractIndex.demotionProposalSchema).toBe(demotionProposalSchema);
  });
});
