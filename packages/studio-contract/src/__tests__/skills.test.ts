/**
 * skills 域契约测试：实体/请求/响应 schema 的接受-拒绝边界。
 * schema 即正本（类型同源由编译期断言锚定）。
 *
 * P4.3（2026-10-17）：随 16 条孤儿端点删除的 schema 测试同步移除，
 * 本文件只覆盖存活端点（GET /、GET /manifest、POST /:id/retract/decide）的契约。
 */

import { describe, it, expect } from 'vitest';
import {
  skillSchema,
  type Skill,
  skillListItemSchema,
  skillManifestEntrySchema,
  type SkillManifestEntry,
  listSkillsQuerySchema,
  skillIdParamsSchema,
  retractDecideBodySchema,
  skillListResponseSchema,
  skillManifestResponseSchema,
  skillResponseSchema,
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

  it('必填字段删除即拒', () => {
    for (const key of Object.keys(skillRow)) {
      const { [key]: _drop, ...rest } = skillRow as unknown as Record<string, unknown>;
      expect(skillSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('派生读形状', () => {
  it('list 行 = Skill + proposals[{id}]', () => {
    expect(skillListItemSchema.parse({ ...skillRow, proposals: [{ id: 'p1' }] })).toBeTruthy();
    expect(skillListItemSchema.safeParse({ ...skillRow, proposals: [{}] }).success).toBe(false);
  });
});

describe('SkillManifestEntry', () => {
  it('agentTypes/triggers 等必填字段删除即拒', () => {
    expect(skillManifestEntrySchema.parse(manifestEntryRow)).toEqual(manifestEntryRow);
    for (const key of Object.keys(manifestEntryRow)) {
      const { [key]: _drop, ...rest } = manifestEntryRow as unknown as Record<string, unknown>;
      expect(skillManifestEntrySchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('请求 schema', () => {
  it('query/params 边界', () => {
    expect(listSkillsQuerySchema.parse({ page: '1', limit: '20' })).toEqual({ page: '1', limit: '20' });
    expect(skillIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('retract/decide：decision 词表（原手写 guard）', () => {
    expect(retractDecideBodySchema.parse({ decision: 'confirm' })).toEqual({ decision: 'confirm' });
    expect(retractDecideBodySchema.parse({ decision: 'reject', messageId: 'm', channelId: 'c' })).toBeTruthy();
    expect(retractDecideBodySchema.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(retractDecideBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('响应 schema（统一 { data } / 分页壳）', () => {
  it('list 为分页壳；manifest / retract-decide 为 { data }', () => {
    expect(skillListResponseSchema.parse({
      data: [{ ...skillRow, proposals: [] }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })).toBeTruthy();
    expect(skillManifestResponseSchema.parse({ data: [manifestEntryRow] })).toBeTruthy();
    expect(skillResponseSchema.parse({ data: skillRow })).toBeTruthy();
  });

  it('index.ts 出口包含 skills 域 schema', () => {
    expect(contractIndex.skillSchema).toBe(skillSchema);
    expect(contractIndex.skillManifestEntrySchema).toBe(skillManifestEntrySchema);
  });
});
