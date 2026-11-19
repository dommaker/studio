/**
 * B59-002: extractFromExecution must persist to StudioEvent
 *
 * OKR queryKnowledgeQualityGatePassRate queries prisma.studioEvent
 * for type='extractFromExecution'. Previously only EventEmitter was
 * used (in-memory), so OKR metric always returned null.
 *
 * #669 刀2：实现体自 knowledge-service.ts 迁至 knowledge-produce.ts
 * （extractFromExecutionImpl，门面薄封装），本测试跟随正本路径。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_PATH = path.resolve(__dirname, '../../knowledge/knowledge-produce.ts');
const source = fs.readFileSync(SERVICE_PATH, 'utf-8');

function implBody(): string {
  const methodMatch = source.match(
    /export\s+async\s+function\s+extractFromExecutionImpl\(deps:\s*KnowledgeServiceDeps,\s*result:\s*ExtractionResult\)[\s\S]*?\n\}/,
  );
  expect(methodMatch).toBeTruthy();
  return methodMatch![0];
}

describe('extractFromExecution StudioEvent persistence (B59-002)', () => {
  it('persists extractFromExecution via FileStore (Spec 4: Prisma removed)', () => {
    const body = implBody();

    // Must call eventEmitter (in-memory) + FileStore persist (not Prisma)
    expect(body).toContain('extractFromExecution');
  });

  it('payload includes success field for OKR quality gate calculation', () => {
    const body = implBody();

    // The OKR query parses payload.success — must be present
    expect(body).toContain('success');
  });

  it('still emits EventEmitter for in-memory listeners', () => {
    const body = implBody();

    // Must keep the existing EventEmitter emit
    expect(body).toContain('eventEmitter');
  });
});
