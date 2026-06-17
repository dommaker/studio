/**
 * B59-003: querySkillUsageRate fix
 *
 * Previously depended on knowledge:skill_registered StudioEvent which
 * was never emitted. Now counts published skills from disk directly.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_PATH = path.resolve(__dirname, '../okr.service.ts');
const source = fs.readFileSync(SERVICE_PATH, 'utf-8');

describe('querySkillUsageRate fix (B59-003)', () => {
  it('no longer depends on knowledge:skill_registered StudioEvent', () => {
    const methodMatch = source.match(
      /private\s+async\s+querySkillUsageRate[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];
    // Must NOT query knowledge:skill_registered anymore
    expect(body).not.toContain('knowledge:skill_registered');
  });

  it('counts published skills from disk for denominator', () => {
    const methodMatch = source.match(
      /private\s+async\s+querySkillUsageRate[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];
    // Must reference skill scanning or file system count
    expect(body).toMatch(/scan|skills|SKILLS_DIR|readdir|existsSync|fs\./i);
  });

  it('still uses knowledge:skill_used for numerator', () => {
    const methodMatch = source.match(
      /private\s+async\s+querySkillUsageRate[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];
    expect(body).toContain('knowledge:skill_used');
  });
});
