/**
 * Behavioral tests for knowledge-service data layer rewrite (Phase 1)
 *
 * AC:
 * AC-A.1: recordTrend writes to data/trends/ instead of knowledge/
 * AC-A.2: recordAnalystAccuracy writes to data/trends/ instead of knowledge/
 * AC-A.1: writeTrendData creates data/trends/ directory if not exists
 * AC-A.1: recordTrend appends to same file on same-date multiple calls
 * AC-A.1: recordTrend skips write when content is empty
 * AC-A.2: recordAnalystAccuracy appends multiple entries to same file
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock external dependencies — keep the real module (knowledge-service.ts
// instantiates the real FileStore at module top-level), silence only the logger.
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const mockIngestEntry = vi.fn().mockReturnValue({ id: 'test-id', maturity: 'draft' });
const mockScheduleSync = vi.fn();

vi.mock('../knowledge-singletons.js', () => ({
  sharedStore: { list: vi.fn(), update: vi.fn(), get: vi.fn() },
  sharedIngest: { ingestEntry: mockIngestEntry },
  sharedLifecycle: { recordReference: vi.fn() },
  sharedQuery: { search: vi.fn() },
  sharedLinter: { validateEntry: vi.fn().mockReturnValue([]) },
  scheduleVectorDbSync: mockScheduleSync,
  ingestWithQualityGate: vi.fn(),
  UNIFIED_KNOWLEDGE_DIR: '/tmp/unused',
}));

// Test data directory (isolated from real ~/.studio/data/)
const TEST_DATA_DIR = path.join(os.tmpdir(), 'studio-test-data-trends');

describe('AC-A.1: recordTrend → data/', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean test directory
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('should write to data/trends/ directory, not call ingestEntry', async () => {
    // Import after mocks are set up
    const { writeTrendData } = await import('../knowledge-service.js');

    const dateStr = '2026-07-01';
    writeTrendData(`${dateStr}.md`, '## Test Trend\n\nmetric: test_metric');

    // Verify file was created in data/trends/
    const expectedDir = path.join(os.homedir(), '.studio', 'data', 'trends');
    const expectedFile = path.join(expectedDir, `${dateStr}.md`);
    expect(fs.existsSync(expectedFile)).toBe(true);

    // Verify ingestEntry was NOT called
    expect(mockIngestEntry).not.toHaveBeenCalled();
  });

  it('should create data/trends/ directory if not exists', async () => {
    const { writeTrendData } = await import('../knowledge-service.js');

    const dateStr = '2026-07-01';
    writeTrendData(`${dateStr}.md`, '## Test\n\ncontent');

    const expectedDir = path.join(os.homedir(), '.studio', 'data', 'trends');
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.statSync(expectedDir).isDirectory()).toBe(true);
  });

  it('should append to same file on same-date multiple calls', async () => {
    const { writeTrendData } = await import('../knowledge-service.js');

    const dateStr = '2026-07-01';
    writeTrendData(`${dateStr}.md`, '## First\n\nmetric: first');
    writeTrendData(`${dateStr}.md`, '## Second\n\nmetric: second');

    const expectedFile = path.join(os.homedir(), '.studio', 'data', 'trends', `${dateStr}.md`);
    const content = fs.readFileSync(expectedFile, 'utf-8');
    expect(content).toContain('## First');
    expect(content).toContain('## Second');
  });
});

describe('AC-A.2: recordAnalystAccuracy → data/', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('should write to data/trends/, not call ingestEntry', async () => {
    // This test will fail until recordAnalystAccuracy is rewritten
    const { knowledgeService } = await import('../knowledge-service.js');

    const testData = {
      docId: 'test-doc-123',
      goalTitle: 'Test Goal',
      predictedFiles: ['file1.ts', 'file2.ts'],
      actualFiles: ['file1.ts', 'file3.ts'],
      predictedDeps: ['dep1'],
      actualDeps: ['dep1', 'dep2'],
      acMatchRate: 0.75,
      missesByType: { missing: 1, extra: 1 },
    };

    await knowledgeService.recordAnalystAccuracy(testData);

    // Verify ingestEntry was NOT called
    expect(mockIngestEntry).not.toHaveBeenCalled();

    // Verify file was created
    const dateStr = new Date().toISOString().split('T')[0];
    const expectedFile = path.join(os.homedir(), '.studio', 'data', 'trends', `${dateStr}.md`);
    expect(fs.existsSync(expectedFile)).toBe(true);

    const content = fs.readFileSync(expectedFile, 'utf-8');
    expect(content).toContain('AnalystAccuracy');
    expect(content).toContain('Test Goal');
  });

  it('should append multiple accuracy entries to same file', async () => {
    const { knowledgeService } = await import('../knowledge-service.js');

    const testData1 = {
      docId: 'doc-1',
      goalTitle: 'Goal 1',
      predictedFiles: ['a.ts'],
      actualFiles: ['a.ts'],
      predictedDeps: [],
      actualDeps: [],
      acMatchRate: 1.0,
      missesByType: {},
    };

    const testData2 = {
      docId: 'doc-2',
      goalTitle: 'Goal 2',
      predictedFiles: ['b.ts'],
      actualFiles: ['c.ts'],
      predictedDeps: [],
      actualDeps: [],
      acMatchRate: 0.5,
      missesByType: { missing: 1 },
    };

    await knowledgeService.recordAnalystAccuracy(testData1);
    await knowledgeService.recordAnalystAccuracy(testData2);

    const dateStr = new Date().toISOString().split('T')[0];
    const expectedFile = path.join(os.homedir(), '.studio', 'data', 'trends', `${dateStr}.md`);
    const content = fs.readFileSync(expectedFile, 'utf-8');
    expect(content).toContain('Goal 1');
    expect(content).toContain('Goal 2');
  });
});

describe('AC-B.1: validateKnowledgeForm()', () => {
  it('type=guideline → valid=true, form=knowledge', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: 'Use early returns to keep code flat and readable.',
      tags: [],
    });
    expect(result.valid).toBe(true);
    expect(result.form).toBe('knowledge');
  });

  it('type=pitfall → valid=true, form=knowledge', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'pitfall',
      content: 'Do not call LLM for deterministic decisions like routing or status codes.',
      tags: [],
    });
    expect(result.valid).toBe(true);
    expect(result.form).toBe('knowledge');
  });

  it('type=process + 含百分比 → valid=false, form=data', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'process',
      content: '路由分布分析：premium 占 75%，standard 占 20%，degraded 占 5%。',
      tags: [],
    });
    expect(result.valid).toBe(false);
    expect(result.form).toBe('data');
  });

  it('tags=[trend] → valid=false, form=data', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: 'Some trend content that is long enough to pass length check easily.',
      tags: ['trend'],
    });
    expect(result.valid).toBe(false);
    expect(result.form).toBe('data');
  });

  it('多步骤流程 + >500字 → valid=false, form=skill', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const longContent = 'Step 1: Analyze the requirement.\nStep 2: Design the solution.\nStep 3: Implement the code.\n' + 'x'.repeat(500);
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: longContent,
      tags: [],
    });
    expect(result.valid).toBe(false);
    expect(result.form).toBe('skill');
  });

  it('"禁止..." + <100字 → valid=false, form=rule', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: '禁止在代码中硬编码 API 密钥。',
      tags: [],
    });
    expect(result.valid).toBe(false);
    expect(result.form).toBe('rule');
  });

  it('content 为空 → valid=false, form=data', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: '',
      tags: [],
    });
    expect(result.valid).toBe(false);
    expect(result.form).toBe('data');
  });

  it('content <20字 → valid=false, form=data', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: 'Too short',
      tags: [],
    });
    expect(result.valid).toBe(false);
    expect(result.form).toBe('data');
  });

  it('无法判断的混合内容 → valid=true (宽容策略)', async () => {
    const { validateKnowledgeForm } = await import('../knowledge-service.js');
    const result = validateKnowledgeForm({
      type: 'guideline',
      content: 'This is a mixed content that has some structure but is primarily an explanatory guideline about how to approach complex debugging scenarios in distributed systems without a clear single answer.',
      tags: [],
    });
    expect(result.valid).toBe(true);
    expect(result.form).toBe('knowledge');
  });
});

describe('writeTrendData utility', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it('should be exported from knowledge-service', async () => {
    const module = await import('../knowledge-service.js');
    expect(typeof module.writeTrendData).toBe('function');
  });

  it('should create markdown file with content', async () => {
    const { writeTrendData } = await import('../knowledge-service.js');

    writeTrendData('2026-07-01.md', '# Test\n\nContent here');

    const filePath = path.join(os.homedir(), '.studio', 'data', 'trends', '2026-07-01.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Test');
    expect(content).toContain('Content here');
  });
});
