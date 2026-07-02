/**
 * AC: ac-dependson-cleanup
 *
 * Source-code verification:
 * - schema.prisma WorkUnit model has no dependsOn field
 * - workunit.service.ts has no dependsOn handling
 * - workunit.routes.ts has no dependsOn parameter
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_PATH = path.resolve(__dirname, '../../../../../../packages/studio-prisma/prisma/schema.prisma');
const WORKUNIT_DIR = path.resolve(__dirname, '..');

describe('dependsOn cleanup verification', () => {
  it('schema.prisma WorkUnit model has no dependsOn field', () => {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    // Find WorkUnit model start, then find matching closing brace
    const wuStart = content.indexOf('model WorkUnit {');
    expect(wuStart).toBeGreaterThan(-1);
    // Find the closing brace at the same indentation level
    let depth = 0;
    let wuEnd = -1;
    for (let i = wuStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') {
        depth--;
        if (depth === 0) { wuEnd = i; break; }
      }
    }
    const wuBlock = content.substring(wuStart, wuEnd);
    expect(wuBlock).not.toMatch(/\bdependsOn\b/);
  });

  it('workunit.service.ts CreateWorkUnitInput has no dependsOn', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.service.ts'), 'utf-8');
    expect(content).not.toMatch(/dependsOn/);
  });

  it('workunit.routes.ts has no dependsOn parameter handling', () => {
    const content = fs.readFileSync(path.join(WORKUNIT_DIR, 'workunit.routes.ts'), 'utf-8');
    expect(content).not.toMatch(/dependsOn/);
  });
});
