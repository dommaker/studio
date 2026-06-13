/**
 * Tests for migrate-sdd-from-db.ts — slug resolution logic
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_SDD = join(__dirname, '.test-sdd-migrate');

beforeEach(() => { mkdirSync(TEST_SDD, { recursive: true }); });
afterEach(() => { rmSync(TEST_SDD, { recursive: true, force: true }); });

// Inline the slug resolution logic for testing (script is CLI, not importable)
function resolveSlug(baseSlug: string, goalId: string | null, sddDir: string): string {
  const dirPath = join(sddDir, baseSlug);
  if (!existsSync(dirPath)) return baseSlug;
  // Check existing frontmatter goalId
  const reqPath = join(dirPath, 'requirement.md');
  if (!existsSync(reqPath)) return baseSlug;
  const content = require('fs').readFileSync(reqPath, 'utf-8');
  const match = content.match(/goalId:\s*(.+)/);
  const existingGoalId = match ? match[1].trim() : null;
  if (existingGoalId === goalId) return baseSlug;
  const suffix = goalId ? goalId.slice(-4) : 'xxxx';
  return `${baseSlug}-${suffix}`;
}

describe('migrate-sdd-from-db', () => {
  it('returns baseSlug when dir does not exist', () => {
    expect(resolveSlug('my-slug', 'g1', TEST_SDD)).toBe('my-slug');
  });

  it('returns baseSlug when existing goalId matches', () => {
    const dir = join(TEST_SDD, 'my-slug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'requirement.md'), '---\ngoalId: g1\n---\nbody');
    expect(resolveSlug('my-slug', 'g1', TEST_SDD)).toBe('my-slug');
  });

  it('appends suffix when goalId conflicts', () => {
    const dir = join(TEST_SDD, 'my-slug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'requirement.md'), '---\ngoalId: other\n---\nbody');
    expect(resolveSlug('my-slug', 'g1234', TEST_SDD)).toBe('my-slug-1234');
  });

  it('uses xxxx suffix when goalId is null', () => {
    const dir = join(TEST_SDD, 'my-slug');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'requirement.md'), '---\ngoalId: other\n---\nbody');
    expect(resolveSlug('my-slug', null, TEST_SDD)).toBe('my-slug-xxxx');
  });
});
