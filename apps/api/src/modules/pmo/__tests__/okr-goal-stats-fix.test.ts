/**
 * B59-006: goals/routes.ts stats must use 'succeeded' not 'completed'
 *
 * Goal.status terminal success state is 'succeeded', not 'completed'.
 * The stats endpoint queried status='completed' which never matched,
 * causing completedGoals to always be 0.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROUTES_PATH = path.resolve(__dirname, '../../goals/routes.ts');
const source = fs.readFileSync(ROUTES_PATH, 'utf-8');

describe('Goal stats endpoint uses correct status (B59-006)', () => {
  it('counts completedGoals with status succeeded, not completed', () => {
    // Should use 'succeeded' for Goal status queries
    expect(source).toContain("status: 'succeeded'");
    // Should NOT have status: 'completed' in Goal count queries
    const goalCountMatches = source.match(/prisma\.goal\.count\(\{[^}]*status:\s*'completed'/g);
    expect(goalCountMatches).toBeNull();
  });
});
