/**
 * AC: ac-metadata-types
 *
 * Source-code verification:
 * - WorkUnitMetadata interface has new Agent Loop fields
 * - All new fields are optional
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// 工单 30：WorkUnitMetadata 接口已抽至 workunit.types.ts（service 侧 re-export），此处改指类型定义所在文件
const workunitServiceSrc = fs.readFileSync(
  path.resolve(__dirname, '../workunit.types.ts'),
  'utf-8',
);

// Extract WorkUnitMetadata interface block
const metadataInterfaceMatch = workunitServiceSrc.match(
  /export interface WorkUnitMetadata \{([^}]+)\}/s,
);
const metadataInterfaceBody = metadataInterfaceMatch?.[1] ?? '';

describe('WorkUnitMetadata Agent Loop fields', () => {
  test('has sessionId field (optional string)', () => {
    expect(metadataInterfaceBody).toMatch(/sessionId\?\s*:\s*string/);
  });

  test('has stepCount field (optional number)', () => {
    expect(metadataInterfaceBody).toMatch(/stepCount\?\s*:\s*number/);
  });

  test('has startedAt field (optional string)', () => {
    expect(metadataInterfaceBody).toMatch(/startedAt\?\s*:\s*string/);
  });

  test('has consecutiveStuck field (optional number)', () => {
    expect(metadataInterfaceBody).toMatch(/consecutiveStuck\?\s*:\s*number/);
  });

  test('has sessionResumes field (optional number)', () => {
    expect(metadataInterfaceBody).toMatch(/sessionResumes\?\s*:\s*number/);
  });
});
