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

const PRISMA_DIR = path.resolve(__dirname, '../../../../../../packages/studio-prisma');
const WORKUNIT_DIR = path.resolve(__dirname, '..');

describe('dependsOn cleanup verification', () => {
  it('studio-prisma package removed (Spec 4 AC-6a)', () => {
    // studio-prisma package was deleted entirely
    expect(fs.existsSync(PRISMA_DIR)).toBe(false);
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
