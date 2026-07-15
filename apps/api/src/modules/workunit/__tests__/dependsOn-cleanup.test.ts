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
  it('schema.prisma WorkUnit model removed (migrated to FileStore)', () => {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    // WorkUnit model was deleted from schema.prisma (migrated to FileStore)
    expect(content).not.toMatch(/model WorkUnit\s*\{/);
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
