/**
 * migrate-spec3-to-files.ts — smoke test
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('migrate-spec3-to-files', () => {
  const scriptPath = path.resolve(__dirname, '..', 'migrate-spec3-to-files.ts');

  it('script file exists', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('has all 3 migration functions', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    const expectedFunctions = ['migrateProjects', 'migrateTasks', 'migrateSpecReviews'];
    for (const fn of expectedFunctions) {
      expect(content).toContain(`async function ${fn}`);
    }
  });

  it('has --dry-run support', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('--dry-run');
  });

  it('skips Document table (content already in filesystem)', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('Skipping Document');
  });

  it('target paths are correct', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('projects');
    expect(content).toContain('tasks.jsonl');
    expect(content).toContain('spec-reviews');
  });

  it('exports SpecReview with embedded approvals', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('specReviewApprovals');
  });
});
