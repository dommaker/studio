/**
 * B59-005: reviewScore must be written in all review paths
 *
 * Previously the re-queue path (review not approved, cycles remaining)
 * only wrote reviewCycle, not reviewScore. This caused OKR
 * queryReviewPassRate to undercount (denominator excluded re-queued reviews).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REVIEW_PATH = path.resolve(__dirname, '../../goals/goal-review.ts');
const source = fs.readFileSync(REVIEW_PATH, 'utf-8');

describe('reviewScore written in all review paths (B59-005)', () => {
  it('writes reviewScore in approved path', () => {
    // Count occurrences of reviewScore in context updates
    const matches = source.match(/reviewScore:\s*review\.score/g);
    expect(matches).toBeTruthy();
    // Should appear in at least 3 paths: approved, max-cycles, re-queue
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it('re-queue path includes reviewScore', () => {
    // The re-queue path sets status to 'executing' and updates context
    const requeueMatch = source.match(
      /status:\s*'executing'[\s\S]*?context:\s*\{[^}]*reviewScore/g,
    );
    expect(requeueMatch).toBeTruthy();
  });
});
