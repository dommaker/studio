/**
 * admin 域契约测试：docs-freshness 响应形状 + 响应壳。
 * 正本 = apps/api/src/modules/admin/docs-freshness.routes.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  docsFreshnessResultSchema,
  docsFreshnessResponseSchema,
} from '../admin.js';
import * as contractIndex from '../index.js';

describe('docsFreshnessResultSchema', () => {
  it('fresh/stale/missing 三态；harnessCheck 可选', () => {
    const fresh = {
      status: 'fresh',
      claudeLastModified: '2026-09-01T00:00:00.000Z',
      daysSinceUpdate: 3,
      recentChanges: [],
      sections: [{ section: 'Domain Packages', status: 'ok', detail: 'Section present' }],
      recommendations: [],
      harnessCheck: {
        passed: true,
        details: [{ id: 'capability_sync', passed: true, message: 'In sync' }],
      },
    };
    expect(docsFreshnessResultSchema.parse(fresh)).toEqual(fresh);

    const missing = {
      status: 'missing',
      recentChanges: [],
      sections: [{ section: 'CLAUDE.md', status: 'missing', detail: 'File not found' }],
      recommendations: ['Create CLAUDE.md'],
    };
    expect(docsFreshnessResultSchema.parse(missing)).toEqual(missing);
    expect(() => docsFreshnessResultSchema.parse({ ...fresh, status: 'bogus' })).toThrow();
    expect(() => docsFreshnessResultSchema.parse({ ...fresh, sections: undefined })).toThrow();
  });

  it('响应壳：GET / → { data: DocsFreshnessResult }', () => {
    const body = {
      data: {
        status: 'stale',
        recentChanges: [],
        sections: [],
        recommendations: ['review'],
      },
    };
    expect(docsFreshnessResponseSchema.parse(body).data.status).toBe('stale');
  });
});

describe('index.ts 出口', () => {
  it('admin 域 schema 经 index 导出', () => {
    expect(contractIndex.docsFreshnessResultSchema).toBeDefined();
    expect(contractIndex.docsFreshnessResponseSchema).toBeDefined();
  });
});
