/**
 * constraint-audit (#146) — 存量约束审计纯函数测试
 *
 * 覆盖（对应 #146 AC 的判据层）：
 *   - loadActiveCustomConstraints：解析 yml、跳过 retired 段、缺文件/坏文件 → []
 *   - normalizeAuditSuggestions：判据白名单闸门（防再引入型不误判退役——
 *     技术存量清零/长期零违规等白名单外理由一律丢弃）、幻觉 id 防护、去重、封顶
 *   - readPackageDeps：dependencies + devDependencies 合并排序
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadActiveCustomConstraints,
  normalizeAuditSuggestions,
  readPackageDeps,
  buildConstraintAuditPrompt,
  AUDIT_MAX_SUGGESTIONS,
} from '../constraint-audit.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constraint-audit-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConstraints(content: string): string {
  const file = path.join(tmpDir, 'custom-constraints.yml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

const SAMPLE_YML = `# 自定义约束配置
custom_constraints:
  no_redis_import:
    id: no_redis_import
    level: iron_law
    rule: "NO REDIS/IREDIS IMPORTS"
    message: "禁止引入 Redis/ioredis 依赖"
    description: "B0-002 已完成迁移"
  prisma_schema_needs_migration:
    id: prisma_schema_needs_migration
    level: iron_law
    message: "修改 schema.prisma 必须同时创建 migration 文件"
  already_retired:
    id: already_retired
    level: guideline
    message: "已退役的约束"
    retired:
      at: "2026-08-01T00:00:00.000Z"
      reason: "作用对象消失"
`;

describe('loadActiveCustomConstraints', () => {
  it('解析 active 条目（跳过含 retired 段的已退役条目），按 id 排序', () => {
    const file = writeConstraints(SAMPLE_YML);
    const list = loadActiveCustomConstraints(file);
    expect(list.map(c => c.id)).toEqual(['no_redis_import', 'prisma_schema_needs_migration']);
    expect(list[0]).toMatchObject({ level: 'iron_law', rule: 'NO REDIS/IREDIS IMPORTS' });
  });

  it('文件缺失 → []', () => {
    expect(loadActiveCustomConstraints(path.join(tmpDir, 'nope.yml'))).toEqual([]);
  });

  it('坏 YAML / 无 custom_constraints 段 → []', () => {
    expect(loadActiveCustomConstraints(writeConstraints(':\n  - [broken'))).toEqual([]);
    expect(loadActiveCustomConstraints(writeConstraints('foo: bar\n'))).toEqual([]);
  });
});

describe('normalizeAuditSuggestions', () => {
  const auditable = new Set(['no_redis_import', 'prisma_schema_needs_migration']);

  it('白名单判据（target-gone / reintroduction-sealed）保留', () => {
    const out = normalizeAuditSuggestions({
      suggestions: [
        { constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: 'schema.prisma 已从代码库删除' },
        { constraintId: 'no_redis_import', category: 'reintroduction-sealed', rationale: '依赖审计已封死 redis 引入路径' },
      ],
    }, auditable);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ constraintId: 'prisma_schema_needs_migration', category: 'target-gone' });
  });

  it('防再引入保护：技术存量清零（tech-absent）不是合法退役理由 → 丢弃', () => {
    const out = normalizeAuditSuggestions({
      suggestions: [
        { constraintId: 'no_redis_import', category: 'tech-absent', rationale: '依赖里已无 redis' },
      ],
    }, auditable);
    expect(out).toEqual([]);
  });

  it('防再引入保护：长期零违规（zero-violations）不是合法退役理由 → 丢弃', () => {
    const out = normalizeAuditSuggestions({
      suggestions: [
        { constraintId: 'no_redis_import', category: 'zero-violations', rationale: '长期零违规' },
        { constraintId: 'prisma_schema_needs_migration', rationale: '缺 category' },
        { constraintId: 'prisma_schema_needs_migration', category: 'target-gone', rationale: '  ' },
      ],
    }, auditable);
    expect(out).toEqual([]);
  });

  it('幻觉防护：不在审计集合内的 constraintId 丢弃', () => {
    const out = normalizeAuditSuggestions({
      suggestions: [
        { constraintId: 'ghost_constraint', category: 'target-gone', rationale: '不存在的约束' },
      ],
    }, auditable);
    expect(out).toEqual([]);
  });

  it('同 id 去重（先出优先）+ 总量封顶', () => {
    const suggestions = [
      { constraintId: 'no_redis_import', category: 'reintroduction-sealed', rationale: '第一条' },
      { constraintId: 'no_redis_import', category: 'target-gone', rationale: '重复丢弃' },
      ...Array.from({ length: AUDIT_MAX_SUGGESTIONS + 2 }, (_, i) => ({
        constraintId: `c-${i}`, category: 'target-gone', rationale: `r${i}`,
      })),
    ];
    const big = new Set([...auditable, ...suggestions.map(s => s.constraintId)]);
    const out = normalizeAuditSuggestions({ suggestions }, big);
    expect(out).toHaveLength(AUDIT_MAX_SUGGESTIONS);
    expect(out.find(s => s.constraintId === 'no_redis_import')?.rationale).toBe('第一条');
  });

  it('非数组/缺字段输入 → []', () => {
    expect(normalizeAuditSuggestions({}, auditable)).toEqual([]);
    expect(normalizeAuditSuggestions({ suggestions: 'nope' }, auditable)).toEqual([]);
    expect(normalizeAuditSuggestions({ suggestions: [null, 42, 'x'] }, auditable)).toEqual([]);
  });
});

describe('readPackageDeps', () => {
  it('dependencies + devDependencies 合并排序；缺失 → []', () => {
    const pkg = path.join(tmpDir, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({
      dependencies: { express: '^4', react: '^18' },
      devDependencies: { vitest: '^3', express: '^4' },
    }), 'utf-8');
    expect(readPackageDeps(pkg)).toEqual(['express', 'react', 'vitest']);
    expect(readPackageDeps(path.join(tmpDir, 'nope.json'))).toEqual([]);
  });
});

describe('buildConstraintAuditPrompt', () => {
  it('约束 id 与依赖清单进 prompt；依赖缺省时有降级说明', () => {
    const prompt = buildConstraintAuditPrompt(
      [{ id: 'no_redis_import', level: 'iron_law', message: '禁止引入 Redis' }],
      { packageDeps: ['express'] },
    );
    expect(prompt).toContain('no_redis_import');
    expect(prompt).toContain('禁止引入 Redis');
    expect(prompt).toContain('express');

    const noDeps = buildConstraintAuditPrompt([{ id: 'x' }]);
    expect(noDeps).toContain('不可用');
  });
});
