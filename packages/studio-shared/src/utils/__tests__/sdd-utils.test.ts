import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  findSddDocById,
  findSddDocByGoalId,
  readSddDocByGoalId,
  writeSddDoc,
  toKebab,
  parseSddFrontmatter,
  stringifySddFrontmatter,
  listSddDocs,
  readSddDoc,
} from '../sdd-utils';

const TEST_SDD_DIR = join('/tmp', `sdd-utils-test-${Date.now()}`);

// Override SDD_DIR for tests
const origEnv = process.env.SDD_DIR;

beforeAll(() => {
  process.env.SDD_DIR = TEST_SDD_DIR;
  mkdirSync(TEST_SDD_DIR, { recursive: true });

  // Create test docs
  writeSddDoc('test-doc-1', 'requirement', {
    id: 'doc-aaa-111',
    goalId: 'goal-xxx-001',
    slug: 'test-doc-1',
    title: 'Test Doc 1',
    status: 'draft',
    tier: 'standard',
    version: 1,
    requirementVersion: 1,
    designVersion: 1,
    taskVersion: 1,
    tags: ['test'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }, '## Requirement\n\nSome content');

  writeSddDoc('test-doc-2', 'requirement', {
    id: 'doc-bbb-222',
    slug: 'test-doc-2',
    title: 'Test Doc 2',
    status: 'draft',
    tier: 'fast',
    version: 1,
    requirementVersion: 1,
    designVersion: 1,
    taskVersion: 1,
    tags: ['test'],
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }, '## Requirement\n\nOther content');
});

afterAll(() => {
  process.env.SDD_DIR = origEnv;
  rmSync(TEST_SDD_DIR, { recursive: true, force: true });
});

describe('toKebab', () => {
  test('converts Chinese title to kebab', () => {
    expect(toKebab('添加 JWT 验证')).toBe('add-jwt-auth');
  });

  test('converts English title to kebab', () => {
    expect(toKebab('SDD Knowledge Architecture')).toBe('sdd-knowledge-architecture');
  });

  test('handles empty input', () => {
    const result = toKebab('');
    expect(result).toMatch(/^doc-\d+$/);
  });
});

describe('parseSddFrontmatter', () => {
  test('parses valid frontmatter', () => {
    const content = '---\nid: "abc"\ntitle: "Test"\ntags: ["a", "b"]\n---\n\nBody here';
    const result = parseSddFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.meta.id).toBe('abc');
    expect(result!.meta.title).toBe('Test');
    expect(result!.meta.tags).toEqual(['a', 'b']);
    expect(result!.body).toBe('Body here');
  });

  test('returns null for no frontmatter', () => {
    expect(parseSddFrontmatter('no frontmatter')).toBeNull();
  });
});

describe('stringifySddFrontmatter', () => {
  test('serializes frontmatter', () => {
    const result = stringifySddFrontmatter({
      id: 'abc',
      title: 'Test',
      tags: ['a'],
      version: 1,
    });
    expect(result).toContain('id: "abc"');
    expect(result).toContain('title: "Test"');
    expect(result).toContain('version: 1');
    expect(result).toContain('tags: ["a"]');
  });
});

describe('findSddDocById', () => {
  test('finds slug by doc id', () => {
    expect(findSddDocById('doc-aaa-111')).toBe('test-doc-1');
  });

  test('finds second doc by id', () => {
    expect(findSddDocById('doc-bbb-222')).toBe('test-doc-2');
  });

  test('returns null for non-existent id', () => {
    expect(findSddDocById('doc-nonexistent')).toBeNull();
  });
});

describe('findSddDocByGoalId', () => {
  test('finds slug by goal id', () => {
    expect(findSddDocByGoalId('goal-xxx-001')).toBe('test-doc-1');
  });

  test('returns null for non-existent goal id', () => {
    expect(findSddDocByGoalId('goal-nonexistent')).toBeNull();
  });

  test('returns null when doc has no goalId', () => {
    // test-doc-2 has no goalId
    expect(findSddDocByGoalId('goal-yyy-002')).toBeNull();
  });
});

describe('readSddDocByGoalId', () => {
  test('reads requirement layer by goal id', () => {
    const result = readSddDocByGoalId('goal-xxx-001', 'requirement');
    expect(result).not.toBeNull();
    expect(result!.meta.id).toBe('doc-aaa-111');
    expect(result!.body).toContain('Some content');
  });

  test('returns null for non-existent goal', () => {
    expect(readSddDocByGoalId('goal-nonexistent', 'requirement')).toBeNull();
  });
});

describe('listSddDocs', () => {
  test('lists all doc directories', () => {
    const docs = listSddDocs();
    expect(docs).toContain('test-doc-1');
    expect(docs).toContain('test-doc-2');
  });
});

describe('readSddDoc', () => {
  test('reads existing doc', () => {
    const result = readSddDoc('test-doc-1', 'requirement');
    expect(result).not.toBeNull();
    expect(result!.meta.title).toBe('Test Doc 1');
  });

  test('returns null for non-existent doc', () => {
    expect(readSddDoc('nonexistent', 'requirement')).toBeNull();
  });
});
