/**
 * Evolution generator 单元测试（E1 约束进化）。
 *
 * 覆盖生成链路：
 *   (a) 【挂起 — harness 0.17.0 删除 autoEvolve】约束 traces 不再产生提案，
 *       等待改吃 constraints report 候选数据（飞轮修复立项 ①）
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

  it('(a) suspended since harness 0.17.0: constraint traces alone yield no proposals', async () => {
    // autoEvolve 已删除，(a) 链路等待改吃 constraints report 候选数据（飞轮修复立项 ①）。
    // traces 仍被扫描计数，但不产生任何 iron-law/guideline 提案。
    writeJsonl(paths.traceFile, Array.from({ length: 10 }, (_, i) => ({
      constraintId: 'c-x',
      level: 'guideline',
      timestamp: NOW - 3600_000 + i * 1000,
      result: 'fail',
      operation: 'code_implementation',
    })));

    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.scanned.constraintTraces).toBe(10);
    expect(result.created).toEqual([]);
    expect(await fileStore.listEvolutionProposals()).toEqual([]);
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
