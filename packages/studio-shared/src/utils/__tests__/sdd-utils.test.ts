import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { FileStore } from '../../file-store';
import {
  findSddDocById,
  findSddDocByWorkUnitId,
  readSddDocByWorkUnitId,
  listSddDocs,
  readSddDoc,
  appendChangelog,
  updateSddFrontmatter,
} from '../sdd-utils';

const TEST_SDD_DIR = join('/tmp', `sdd-utils-test-${Date.now()}`);
const store = new FileStore();

const origEnv = process.env.SDD_DIR;

beforeAll(async () => {
  process.env.SDD_DIR = TEST_SDD_DIR;
  mkdirSync(TEST_SDD_DIR, { recursive: true });

  // Create test docs（writeSddDoc 已随 #155 删除，fixture 直接走 FileStore.writeDoc）
  await store.writeDoc(TEST_SDD_DIR, 'test-doc-1/requirement', {
    id: 'doc-aaa-111',
    workUnitId: 'goal-xxx-001',
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

  await store.writeDoc(TEST_SDD_DIR, 'test-doc-2/requirement', {
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

describe('findSddDocById', () => {
  test('finds slug by doc id', async () => {
    await expect(findSddDocById('doc-aaa-111')).resolves.toBe('test-doc-1');
  });

  test('finds second doc by id', async () => {
    await expect(findSddDocById('doc-bbb-222')).resolves.toBe('test-doc-2');
  });

  test('returns null for non-existent id', async () => {
    await expect(findSddDocById('doc-nonexistent')).resolves.toBeNull();
  });
});

describe('findSddDocByWorkUnitId', () => {
  test('finds slug by workUnitId', async () => {
    await expect(findSddDocByWorkUnitId('goal-xxx-001')).resolves.toBe('test-doc-1');
  });

  test('returns null for non-existent workUnitId', async () => {
    await expect(findSddDocByWorkUnitId('goal-nonexistent')).resolves.toBeNull();
  });

  test('returns null when doc has no workUnitId', async () => {
    // test-doc-2 has no workUnitId
    await expect(findSddDocByWorkUnitId('goal-yyy-002')).resolves.toBeNull();
  });
});

describe('readSddDocByWorkUnitId', () => {
  test('reads requirement layer by workUnitId', async () => {
    const result = await readSddDocByWorkUnitId('goal-xxx-001', 'requirement');
    expect(result).not.toBeNull();
    expect(result!.meta.id).toBe('doc-aaa-111');
    expect(result!.body).toContain('Some content');
  });

  test('returns null for non-existent workUnitId', async () => {
    await expect(readSddDocByWorkUnitId('goal-nonexistent', 'requirement')).resolves.toBeNull();
  });
});

describe('listSddDocs', () => {
  test('lists all doc directories', async () => {
    const docs = await listSddDocs();
    expect(docs).toContain('test-doc-1');
    expect(docs).toContain('test-doc-2');
  });
});

describe('readSddDoc', () => {
  test('reads existing doc', async () => {
    const result = await readSddDoc('test-doc-1', 'requirement');
    expect(result).not.toBeNull();
    expect(result!.meta.title).toBe('Test Doc 1');
  });

  test('returns null for non-existent doc', async () => {
    await expect(readSddDoc('nonexistent', 'requirement')).resolves.toBeNull();
  });
});

describe('appendChangelog', () => {
  const CL_SLUG = `changelog-test-${Date.now()}`;
  const CL_DIR = join(TEST_SDD_DIR, CL_SLUG);

  afterAll(() => {
    rmSync(CL_DIR, { recursive: true, force: true });
  });

  test('creates new CHANGELOG.md with header when file does not exist', async () => {
    await appendChangelog(CL_SLUG, 'First entry');
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

  test('multiple entries append (not overwrite)', async () => {
    await appendChangelog(CL_SLUG, 'Second entry');
    const content = readFileSync(join(CL_DIR, 'CHANGELOG.md'), 'utf-8');
    expect(content).toContain('First entry');
    expect(content).toContain('Second entry');
    // Count ## headers with ISO timestamps (not # CHANGELOG)
    const headerCount = (content.match(/^## \d{4}/gm) || []).length;
    expect(headerCount).toBe(2);
  });

  test('creates directory if it does not exist', async () => {
    const newSlug = `changelog-mkdir-${Date.now()}`;
    await appendChangelog(newSlug, 'Dir created');
    expect(existsSync(join(TEST_SDD_DIR, newSlug, 'CHANGELOG.md'))).toBe(true);
    rmSync(join(TEST_SDD_DIR, newSlug), { recursive: true, force: true });
  });
});

describe('updateSddFrontmatter', () => {
  const UPDATE_SLUG = `update-test-${Date.now()}`;

  beforeAll(async () => {
    await store.writeDoc(TEST_SDD_DIR, `${UPDATE_SLUG}/requirement`, {
      id: 'doc-update-001',
      slug: UPDATE_SLUG,
      title: 'Update Test Doc',
      status: 'draft',
      tier: 'standard',
      version: 1,
      requirementVersion: 1,
      designVersion: 1,
      taskVersion: 1,
      tags: ['test'],
      createdAt: '2026-06-13T00:00:00Z',
      updatedAt: '2026-06-13T00:00:00Z',
    }, '## Requirement\n\nOriginal body content');
  });

  afterAll(() => {
    const dir = join(TEST_SDD_DIR, UPDATE_SLUG);
    rmSync(dir, { recursive: true, force: true });
  });

  test('merges patch into existing frontmatter', async () => {
    await updateSddFrontmatter(UPDATE_SLUG, { status: 'confirmed', title: 'Updated Title' });

    const doc = await readSddDoc(UPDATE_SLUG, 'requirement');
    expect(doc).not.toBeNull();
    expect(doc!.meta.status).toBe('confirmed');
    expect(doc!.meta.title).toBe('Updated Title');
    // Unchanged fields preserved
    expect(doc!.meta.id).toBe('doc-update-001');
    expect(doc!.meta.tier).toBe('standard');
  });

  test('preserves body content after update', async () => {
    const doc = await readSddDoc(UPDATE_SLUG, 'requirement');
    expect(doc).not.toBeNull();
    expect(doc!.body).toContain('Original body content');
  });

  test('updates numeric fields', async () => {
    await updateSddFrontmatter(UPDATE_SLUG, { version: 2, requirementVersion: 2 });

    const doc = await readSddDoc(UPDATE_SLUG, 'requirement');
    expect(doc!.meta.version).toBe(2);
    expect(doc!.meta.requirementVersion).toBe(2);
    // Other fields unchanged
    expect(doc!.meta.status).toBe('confirmed');
  });

  test('throws for non-existent slug', async () => {
    await expect(updateSddFrontmatter('nonexistent-slug', { status: 'done' }))
      .rejects.toThrow('SDD doc not found');
  });

  test('throws for file without frontmatter', async () => {
    const badSlug = `bad-frontmatter-${Date.now()}`;
    const dir = join(TEST_SDD_DIR, badSlug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'requirement.md'), 'No frontmatter here', 'utf-8');

    await expect(updateSddFrontmatter(badSlug, { status: 'done' }))
      .rejects.toThrow('Invalid frontmatter');

    rmSync(dir, { recursive: true, force: true });
  });
});
