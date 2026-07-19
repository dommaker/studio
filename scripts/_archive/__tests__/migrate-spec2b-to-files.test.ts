/**
 * migrate-spec2b-to-files.ts — smoke test
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('migrate-spec2b-to-files', () => {
  const scriptPath = path.resolve(__dirname, '..', 'migrate-spec2b-to-files.ts');

  it('script file exists', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('has all 13 table migration functions', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    const expectedFunctions = [
      'migrateAuditLog', 'migrateStudioEvent', 'migrateExecution',
      'migrateNotification', 'migrateIncident', 'migrateEnvironmentSnapshot',
      'migrateKRHistory', 'migrateOKR', 'migrateEnvironment',
      'migrateAgent', 'migrateAgentConfigVersion', 'migrateCapability',
      'migrateResolution',
    ];
    for (const fn of expectedFunctions) {
      expect(content).toContain(`async function ${fn}`);
    }
  });

  it('has --dry-run support', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('--dry-run');
  });

  it('has database backup logic', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('.bak');
  });
});
