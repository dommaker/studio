/**
 * entity-types.ts（#685 纯类型入口）测试：锁「运行时零导出」不变量——
 * 本入口只许 type re-export，误加运行时 re-export 会把 Node 依赖漏给
 * contract/web 消费方，此测试即红。
 */

import { describe, it, expect } from 'vitest';
import * as entry from '../entity-types.js';
import type { AgentProfileData, KnowledgeEntry, Resolution } from '../entity-types.js';

describe('entity-types 纯类型入口', () => {
  it('运行时零导出（type-only）', () => {
    expect(Object.keys(entry)).toEqual([]);
  });

  it('实体类型可被 import type 消费（编译期行使）', () => {
    const profile: AgentProfileData = {
      id: 'r1',
      name: 'role',
      description: null,
      channels: '[]',
      status: 'active',
      provider: null,
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    };
    const entry1 = { id: 'ke-1' } as KnowledgeEntry;
    const res = { id: 'res-1' } as Resolution;
    expect(profile.id).toBe('r1');
    expect(entry1.id).toBe('ke-1');
    expect(res.id).toBe('res-1');
  });
});
