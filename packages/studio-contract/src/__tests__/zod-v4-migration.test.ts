import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createWorkUnitBodySchema,
  knowledgeSourceRefSchema,
  paginationSchema,
} from '../index.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function zodRange(relativeManifest: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(root, relativeManifest), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies?.zod;
}

describe('Zod 4 迁移回归', () => {
  it('所有直接消费方使用包含集合校验修复的 Zod 4', () => {
    for (const manifest of ['package.json', 'apps/api/package.json', 'packages/studio-contract/package.json']) {
      const range = zodRange(manifest);
      expect(range, manifest).toMatch(/^\^4\./);
      const [, minor, patch] = range!.slice(1).split('.').map(Number);
      expect(minor > 6 || (minor === 6 && patch >= 6), manifest).toBe(true);
    }
  });

  it('单值 record 迁移后仍接受任意字符串键和未知值', () => {
    expect(knowledgeSourceRefSchema.parse({ source: { nested: true }, count: 2 })).toEqual({
      source: { nested: true },
      count: 2,
    });
  });

  it('superRefine 保留宿主执行字段拒绝与字段路径', () => {
    const result = createWorkUnitBodySchema.safeParse({
      scope: 'task',
      metadata: { worktreePath: '/untrusted' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'custom', path: ['metadata', 'worktreePath'] }),
      ]));
    }
    expect(createWorkUnitBodySchema.safeParse({ scope: 'task', metadata: { note: 'ok' } }).success).toBe(true);
  });

  it('数值约束继续通过公开 issues 返回稳定路径', () => {
    const result = paginationSchema.safeParse({ page: 0, limit: 20, total: 0, totalPages: 0 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['page']);
  });
});
