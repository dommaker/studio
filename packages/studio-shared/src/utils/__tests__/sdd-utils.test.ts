import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
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
  appendChangelog,
  parseTaskDocContractTests,
  parseTaskDocTestFiles,
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

describe('appendChangelog', () => {
  const CL_SLUG = `changelog-test-${Date.now()}`;
  const CL_DIR = join(TEST_SDD_DIR, CL_SLUG);

  afterAll(() => {
    rmSync(CL_DIR, { recursive: true, force: true });
  });

  test('creates new CHANGELOG.md with header when file does not exist', () => {
    appendChangelog(CL_SLUG, 'First entry');
    const content = readFileSync(join(CL_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('# CHANGELOG');
    expect(content).toContain('## ');
    expect(content).toContain('First entry');
  });

  test('entry format: ## <timestamp>\n\n<entry>\n', () => {
    const content = readFileSync(join(CL_DIR, 'CHANGELOG.md'), 'utf-8');
    // Match: ## <ISO timestamp>\n\n<entry text>\n
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\nFirst entry\n/);
  });

  test('multiple entries append (not overwrite)', () => {
    appendChangelog(CL_SLUG, 'Second entry');
    const content = readFileSync(join(CL_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('First entry');
    expect(content).toContain('Second entry');
    // Count ## headers with ISO timestamps (not # CHANGELOG)
    const headerCount = (content.match(/^## \d{4}/gm) || []).length;
    expect(headerCount).toBe(2);
  });

  test('creates directory if it does not exist', () => {
    const newSlug = `changelog-mkdir-${Date.now()}`;
    appendChangelog(newSlug, 'Dir created');
    expect(existsSync(join(TEST_SDD_DIR, newSlug, 'CHANGELOG.md'))).toBe(true);
    rmSync(join(TEST_SDD_DIR, newSlug), { recursive: true, force: true });
  });
});

describe('parseTaskDocContractTests', () => {
  test('parses single contract test', () => {
    const body = [
      '## Contract Tests',
      '',
      '### __tests__/auth-verify.test.ts',
      '```typescript',
      "import { describe, it, expect } from 'vitest';",
      "describe('auth', () => {",
      "  it('verifies token', () => { expect(true).toBe(true); });",
      '});',
      '```',
    ].join('\n');

    const result = parseTaskDocContractTests(body);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('__tests__/auth-verify.test.ts');
    expect(result[0].content).toContain("import { describe, it, expect }");
    expect(result[0].content).toContain('verifies token');
  });

  test('parses multiple contract tests', () => {
    const body = [
      '## Contract Tests',
      '',
      '### src/__tests__/auth.test.ts',
      '```typescript',
      "import { describe, it, expect } from 'vitest';",
      "it('auth test', () => {});",
      '```',
      '',
      '### src/__tests__/middleware.test.ts',
      '```typescript',
      "import { describe, it, expect } from 'vitest';",
      "it('middleware test', () => {});",
      '```',
    ].join('\n');

    const result = parseTaskDocContractTests(body);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('src/__tests__/auth.test.ts');
    expect(result[1].file).toBe('src/__tests__/middleware.test.ts');
    expect(result[1].content).toContain('middleware test');
  });

  test('returns empty array when no Contract Tests section', () => {
    const body = '## Other Section\n\nSome content';
    expect(parseTaskDocContractTests(body)).toEqual([]);
  });

  test('returns empty array for empty body', () => {
    expect(parseTaskDocContractTests('')).toEqual([]);
  });

  test('ignores content outside code blocks', () => {
    const body = [
      '## Contract Tests',
      '',
      '### __tests__/test.ts',
      'This text outside code block should be ignored',
      '```typescript',
      'const x = 1;',
      '```',
      'This trailing text should also be ignored',
    ].join('\n');

    const result = parseTaskDocContractTests(body);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('const x = 1;');
    expect(result[0].content).not.toContain('outside code block');
  });

  test('handles Chinese section header', () => {
    const body = [
      '## 契约测试',
      '',
      '### __tests__/test.ts',
      '```typescript',
      'const x = 1;',
      '```',
    ].join('\n');

    const result = parseTaskDocContractTests(body);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('__tests__/test.ts');
  });

  test('stops parsing at next H2 section', () => {
    const body = [
      '## Contract Tests',
      '',
      '### __tests__/first.test.ts',
      '```typescript',
      "it('first', () => {});",
      '```',
      '',
      '## Test Files',
      '',
      '### __tests__/not-a-test.ts',
      '```typescript',
      "it('should not be parsed', () => {});",
      '```',
    ].join('\n');

    const result = parseTaskDocContractTests(body);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('__tests__/first.test.ts');
  });
});

describe('parseTaskDocTestFiles', () => {
  test('parses test file list', () => {
    const body = [
      '## Test Files',
      '',
      '- src/__tests__/auth.test.ts',
      '- src/__tests__/middleware.test.ts',
      '- src/__tests__/session.test.ts',
    ].join('\n');

    const result = parseTaskDocTestFiles(body);
    expect(result).toEqual([
      'src/__tests__/auth.test.ts',
      'src/__tests__/middleware.test.ts',
      'src/__tests__/session.test.ts',
    ]);
  });

  test('returns empty array when no Test Files section', () => {
    const body = '## Other Section\n\nSome content';
    expect(parseTaskDocTestFiles(body)).toEqual([]);
  });

  test('returns empty array for empty body', () => {
    expect(parseTaskDocTestFiles('')).toEqual([]);
  });

  test('handles inline code backticks', () => {
    const body = [
      '## Test Files',
      '',
      '- `src/__tests__/auth.test.ts`',
      '- `src/__tests__/middleware.test.ts`',
    ].join('\n');

    const result = parseTaskDocTestFiles(body);
    expect(result).toEqual([
      'src/__tests__/auth.test.ts',
      'src/__tests__/middleware.test.ts',
    ]);
  });

  test('handles Chinese section header', () => {
    const body = [
      '## 测试文件',
      '',
      '- src/__tests__/auth.test.ts',
    ].join('\n');

    const result = parseTaskDocTestFiles(body);
    expect(result).toEqual(['src/__tests__/auth.test.ts']);
  });

  test('stops at next H2 section', () => {
    const body = [
      '## Test Files',
      '',
      '- src/__tests__/auth.test.ts',
      '',
      '## Other Section',
      '',
      '- not-a-test-file.ts',
    ].join('\n');

    const result = parseTaskDocTestFiles(body);
    expect(result).toEqual(['src/__tests__/auth.test.ts']);
  });

  test('full task.md body with both sections', () => {
    const body = [
      '## Contract Tests',
      '',
      '### __tests__/auth-verify.test.ts',
      '```typescript',
      "it('verifies token', () => {});",
      '```',
      '',
      '## Test Files',
      '',
      '- __tests__/auth.test.ts',
      '- __tests__/middleware.test.ts',
      '',
      '## Implementation Notes',
      '',
      'Some notes here.',
    ].join('\n');

    const tests = parseTaskDocContractTests(body);
    expect(tests).toHaveLength(1);
    expect(tests[0].file).toBe('__tests__/auth-verify.test.ts');

    const files = parseTaskDocTestFiles(body);
    expect(files).toEqual(['__tests__/auth.test.ts', '__tests__/middleware.test.ts']);
  });
});
