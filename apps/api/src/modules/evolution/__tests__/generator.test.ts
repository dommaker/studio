/**
 * Evolution generator 单元测试（E1 约束进化）。
 *
 * 覆盖三条生成链路（真实 autoEvolve 纯计算，无 LLM）：
 *   (a) harness 约束 traces 异常 → iron-law/guideline 提案（message / exception 映射）
 *   (b) 注入知识仍高失败 → prompt-template 提案（保守阈值）
 *   (c) 角色 caller 高频工具失败 → role-preset 提案
 * 以及：信号稀薄时零提案（默认安静）、去重（open-exists / duplicate）、绝不自动生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { generateEvolutionProposals } from '../generator';
import { resolveEvolutionPaths, type EvolutionPaths } from '../signals';

let tmpDir: string;
let fileStore: FileStore;
let paths: EvolutionPaths;

const NOW = Date.now();

/** guideline 约束：6 bypass / 10 → bypassRate 0.6 > 0.3 → high_bypass_rate → add_exception */
const BYPASSED_TRACES = Array.from({ length: 10 }, (_, i) => ({
  constraintId: 'no_any_type',
  level: 'guideline',
  timestamp: NOW - 3600_000 + i * 1000,
  result: i < 4 ? 'pass' : 'bypassed',
  operation: 'code_implementation',
}));

/** guideline 约束：12 traces，failRate 7/12 ≈ 0.583 > 0.5，前半全 fail 后半 pass 回升 → trend rising */
const FAILING_TRACES = [
  ...Array.from({ length: 6 }, (_, i) => ({ result: 'fail', i })),
  { result: 'fail', i: 6 },
  ...Array.from({ length: 5 }, (_, i) => ({ result: 'pass', i: 7 + i })),
].map(({ result, i }) => ({
  constraintId: 'no_hardcoded_credentials',
  level: 'guideline',
  timestamp: NOW - 3600_000 + i * 1000,
  result,
  operation: 'code_implementation',
}));

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function writeOutcomeEvents(file: string): void {
  const rows = [
    // 6 失败（3 个注入了知识）+ 2 成功 → failRate 0.75，injectedFailures 3
    ...Array.from({ length: 3 }, (_, i) => ({ success: false, consumedKnowledge: [`k-${i}`] })),
    ...Array.from({ length: 3 }, () => ({ success: false, consumedKnowledge: [] })),
    ...Array.from({ length: 2 }, () => ({ success: true, consumedKnowledge: ['k-9'] })),
  ].map(p => ({
    type: `knowledge:outcome:${p.success ? 'success' : 'failure'}`,
    source: 'claude',
    payload: JSON.stringify({ executionId: 'wu-x', agentType: 'claude', success: p.success, consumedKnowledge: p.consumedKnowledge }),
    createdAt: new Date(NOW - 1800_000).toISOString(),
  }));
  writeJsonl(file, rows);
}

function writeToolCallEvents(file: string): void {
  const rows = [
    // developer：7 次调用 5 次失败（failRate 0.71 ≥ 0.3，failures ≥ 5）→ role-preset 提案
    ...Array.from({ length: 5 }, () => ({ caller: 'developer', tool: 'bash', success: false })),
    ...Array.from({ length: 2 }, () => ({ caller: 'developer', tool: 'read', success: true })),
    // 非角色 caller：全失败也不应产生 role 提案
    ...Array.from({ length: 6 }, () => ({ caller: 'random-agent', tool: 'bash', success: false })),
  ].map((e, i) => ({ type: 'tool:call', timestamp: NOW - 1800_000 + i * 1000, durationMs: 10, ...e }));
  writeJsonl(file, rows);
}

const ROLE_YAML = `id: developer
name: Developer
persona: |
  你是开发者。职责是按 SDD 实现代码。
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-generator-test-'));
  fileStore = new FileStore(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.agents', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.agents', 'roles', 'developer.yaml'), ROLE_YAML, 'utf-8');
  paths = resolveEvolutionPaths({
    repoRoot: tmpDir,
    constraintsFile: path.join(tmpDir, '.harness', 'custom-constraints.yml'),
    traceFile: path.join(tmpDir, '.harness', 'logs', 'traces.log'),
    rolesDir: path.join(tmpDir, '.agents', 'roles'),
    eventsDir: path.join(tmpDir, 'events'),
    studioEventsFile: path.join(tmpDir, 'studio-events.jsonl'),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateEvolutionProposals (E1)', () => {
  it('quiet when signals are thin: zero proposals, no files written', async () => {
    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.created).toEqual([]);
    expect(result.scanned).toEqual({ constraintTraces: 0, toolCalls: 0, outcomes: 0 });
    expect(await fileStore.listEvolutionProposals()).toEqual([]);
    // 未写任何目标文件（绝不自动生效）
    expect(fs.existsSync(paths.constraintsFile)).toBe(false);
  });

  it('(a) maps autoEvolve proposals: high bypass → exception; rising fail rate → message', async () => {
    writeJsonl(paths.traceFile, [...BYPASSED_TRACES, ...FAILING_TRACES]);

    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.scanned.constraintTraces).toBe(22);

    const byTarget = new Map(result.created.map(p => [p.targetId, p]));
    // add_exception → EP exception 提案（extend-only shadow 路径）
    const exception = byTarget.get('no_any_type');
    expect(exception).toBeDefined();
    expect(exception!.targetType).toBe('guideline');
    expect(exception!.constraintChange).toBe('exception');
    expect(exception!.action).toBe('add');
    expect(exception!.status).toBe('pending');
    expect(exception!.source).toBe('harness-autoEvolve');
    expect(exception!.evidence.eventCounts.constraintTraces).toBe(22);
    // modify_message → EP message 提案
    const message = byTarget.get('no_hardcoded_credentials');
    expect(message).toBeDefined();
    expect(message!.constraintChange).toBe('message');
    expect(message!.proposedText.length).toBeGreaterThan(0);

    // 持久化为 pending；constraints 目标文件未被触碰（不自动生效）
    const stored = await fileStore.listEvolutionProposals();
    expect(stored.length).toBe(result.created.length);
    expect(stored.every(p => p.status === 'pending')).toBe(true);
    expect(fs.existsSync(paths.constraintsFile)).toBe(false);
  });

  it('(b) high failure rate despite injected knowledge → one prompt-template proposal', async () => {
    writeOutcomeEvents(paths.studioEventsFile);

    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.created.length).toBe(1);
    const p = result.created[0];
    expect(p.targetType).toBe('prompt-template');
    expect(p.targetId).toBe('knowledge.rules-section');
    expect(p.action).toBe('amend');
    expect(p.source).toBe('heuristic:prompt-failure');
    expect(p.proposedText).toContain('{content}');
    expect(p.evidence.eventCounts.injectedFailures).toBe(3);
  });

  it('(b) stays quiet when failures are below thresholds', async () => {
    // 只有 2 个失败 → 低于 MIN_OUTCOME_FAILURES
    writeJsonl(paths.studioEventsFile, [
      { type: 'knowledge:outcome:failure', payload: JSON.stringify({ success: false, consumedKnowledge: ['k'] }), createdAt: new Date(NOW - 1000).toISOString() },
      { type: 'knowledge:outcome:failure', payload: JSON.stringify({ success: false, consumedKnowledge: ['k'] }), createdAt: new Date(NOW - 1000).toISOString() },
    ]);
    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.created).toEqual([]);
  });

  it('(c) role caller with repeated tool failures → role-preset proposal; non-role callers ignored', async () => {
    // D18: tool:call 与 outcome 同一统一事件文件
    writeToolCallEvents(paths.studioEventsFile);

    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.created.length).toBe(1);
    const p = result.created[0];
    expect(p.targetType).toBe('role-preset');
    expect(p.targetId).toBe('developer');
    expect(p.action).toBe('amend');
    expect(p.currentText).toContain('你是开发者');
    expect(p.proposedText).toContain('你是开发者');      // 保留原 persona
    expect(p.proposedText).toContain('bash');            // 追加高频失败工具警示
    expect(p.evidence.eventCounts.failures).toBe(5);
  });

  it('dedupes: second run with an open proposal for the same target creates nothing', async () => {
    writeOutcomeEvents(paths.studioEventsFile);
    const first = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(first.created.length).toBe(1);

    const second = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(second.created).toEqual([]);
    expect(second.skipped['open-exists']).toBe(1);
  });

  it('dedupes exact repeats against rejected proposals (duplicate)', async () => {
    writeOutcomeEvents(paths.studioEventsFile);
    const first = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    await fileStore.updateEvolutionProposal(first.created[0].id, { status: 'rejected' });

    const second = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(second.created).toEqual([]);
    expect(second.skipped['duplicate']).toBe(1);
  });
});
