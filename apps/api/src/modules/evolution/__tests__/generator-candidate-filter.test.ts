/**
 * (a) 链路候选过滤测试（#624）：四类退役候选各一条的 usage report fixture 下，
 * 只有 high_noise 产 retire 提案，zero_trigger / unevaluable / zero_intercept
 * 全部 report-only 跳过并计数。
 *
 * zero_intercept 走观察名单中间态（ADR-0032），真实 report 需要 90 天观察期状态，
 * 无法用 traces fixture 直接构造候选 —— 故本文件 mock buildConstraintsUsageReport
 * 返回四类候选各一条，专测 generator 的过滤/计数行为。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import type { ConstraintsUsageReport, RetireCandidateKind } from '@dommaker/harness';

vi.mock('@dommaker/harness', async importOriginal => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, buildConstraintsUsageReport: vi.fn() };
});

import { buildConstraintsUsageReport } from '@dommaker/harness';
import { generateEvolutionProposals } from '../generator';
import { resolveEvolutionPaths, type EvolutionPaths } from '../signals';

const mockedReport = vi.mocked(buildConstraintsUsageReport);

let tmpDir: string;
let fileStore: FileStore;
let paths: EvolutionPaths;

function candidate(id: string, kind: RetireCandidateKind, severity: 'error' | 'warning') {
  return {
    id,
    kind,
    stats: { id, severity, total: 30, pass: 2, fail: 25, skip: 3, evaluated: 27, failRate: 0.926 },
    reason: `${kind} 诊断原因（含漂移数字 25/27）`,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-candidate-filter-test-'));
  fileStore = new FileStore(tmpDir);
  paths = resolveEvolutionPaths({
    repoRoot: tmpDir,
    rolesDir: path.join(tmpDir, '.agents', 'roles'),
    eventsDir: path.join(tmpDir, 'events'),
    studioEventsFile: path.join(tmpDir, 'studio-events.jsonl'),
  });
  mockedReport.mockReturnValue({
    traceFileExists: true,
    candidates: [
      candidate('governance_presence', 'zero_trigger', 'warning'),
      candidate('docs_freshness', 'unevaluable', 'error'),
      candidate('no_test_simplification', 'high_noise', 'error'),
      candidate('no_completion_without_verification', 'zero_intercept', 'error'),
    ],
  } as unknown as ConstraintsUsageReport);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('(a) 候选过滤：自动提案只留 high_noise（#624）', () => {
  it('四类候选各一条：仅 high_noise 产 retire 提案，其余三类 report-only 计数', async () => {
    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });

    expect(result.created.length).toBe(1);
    const p = result.created[0];
    expect(p.targetId).toBe('no_test_simplification');
    expect(p.targetType).toBe('iron-law');
    expect(p.constraintChange).toBe('retire');
    expect(result.skipped['report-only-candidate']).toBe(3);
    // 三类 report-only 候选不产任何提案
    const ids = (await fileStore.listEvolutionProposals()).map(x => x.targetId);
    expect(ids).toEqual(['no_test_simplification']);
  });
});
