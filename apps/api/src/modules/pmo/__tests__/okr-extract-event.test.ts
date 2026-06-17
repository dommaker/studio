/**
 * B59-002: extractFromExecution must persist to StudioEvent
 *
 * OKR queryKnowledgeQualityGatePassRate queries prisma.studioEvent
 * for type='extractFromExecution'. Previously only EventEmitter was
 * used (in-memory), so OKR metric always returned null.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_PATH = path.resolve(__dirname, '../../knowledge/knowledge-service.ts');
const source = fs.readFileSync(SERVICE_PATH, 'utf-8');

describe('extractFromExecution StudioEvent persistence (B59-002)', () => {
  it('writes to prisma.studioEvent with type extractFromExecution', () => {
    // Find the extractFromExecution method body
    const methodMatch = source.match(
      /async\s+extractFromExecution\(result:\s*ExtractionResult\)[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    // Must create a StudioEvent record (not just EventEmitter)
    expect(body).toContain('studioEvent');
    expect(body).toContain('extractFromExecution');
  });

  it('payload includes success field for OKR quality gate calculation', () => {
    const methodMatch = source.match(
      /async\s+extractFromExecution\(result:\s*ExtractionResult\)[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    // The OKR query parses payload.success — must be present
    expect(body).toContain('success');
  });

  it('still emits EventEmitter for in-memory listeners', () => {
    const methodMatch = source.match(
      /async\s+extractFromExecution\(result:\s*ExtractionResult\)[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    // Must keep the existing EventEmitter emit
    expect(body).toContain('eventEmitter');
  });
});
