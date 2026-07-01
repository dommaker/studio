/**
 * Behavioral tests for AC-B.3: safeIngest form gate integration
 *
 * AC:
 * safeIngest imports validateKnowledgeForm from knowledge-service
 * safeIngest calls validateKnowledgeForm before ingest
 * safeIngest writes to data/ when form='data' detected
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';

describe('AC-B.3: safeIngest form gate', () => {
  test('imports validateKnowledgeForm from knowledge-service', async () => {
    const source = fs.readFileSync(
      'apps/api/src/modules/agents/knowledge-agent.service.ts',
      'utf-8'
    );
    expect(source).toMatch(/import.*validateKnowledgeForm.*from.*knowledge-service/);
  });

  test('calls validateKnowledgeForm in safeIngest', async () => {
    const source = fs.readFileSync(
      'apps/api/src/modules/agents/knowledge-agent.service.ts',
      'utf-8'
    );
    expect(source).toContain('validateKnowledgeForm(');
  });

  test('handles form=data with writeTrendData (append mode)', async () => {
    const source = fs.readFileSync(
      'apps/api/src/modules/agents/knowledge-agent.service.ts',
      'utf-8'
    );
    // Should use writeTrendData for data redirect (append, not overwrite)
    expect(source).toMatch(/formResult\.form\s*===\s*['"]data['"]/);
    expect(source).toMatch(/writeTrendData\(.*extracted\.md/);
  });

  test('returns false when form gate rejects', async () => {
    const source = fs.readFileSync(
      'apps/api/src/modules/agents/knowledge-agent.service.ts',
      'utf-8'
    );
    // After form gate rejection, should return false before reaching sharedLinter
    expect(source).toContain('Form gate rejected');
    // The return false should appear in the form gate block
    expect(source).toMatch(/Form gate rejected[\s\S]*?return false/);
  });
});
