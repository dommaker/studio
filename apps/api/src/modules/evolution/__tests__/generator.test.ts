/**
 * Evolution generator 单元测试（E1 约束进化）。
 *
 * 覆盖生成链路：
 *   (a) constraints usage report 退役候选 → retire 提案（#602 D1，harness 公共导出
 *       buildConstraintsUsageReport 消费；落点 = .harness/config.yml enabled:false）；
 *       自动提案只留 high_noise，zero_trigger/unevaluable/zero_intercept report-only（#624）
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
    rolesDir: path.join(tmpDir, '.agents', 'roles'),
    eventsDir: path.join(tmpDir, 'events'),
    studioEventsFile: path.join(tmpDir, 'studio-events.jsonl'),
  });
});

// #646：traces 落点固定为 harness 正本（readProjectTraces 读 <repoRoot>/.harness/logs/traces.log）
const traceFile = (): string => path.join(tmpDir, '.harness', 'logs', 'traces.log');

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateEvolutionProposals (E1)', () => {
  it('quiet when signals are thin: zero proposals, no files written', async () => {
    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.created).toEqual([]);
    expect(result.scanned).toEqual({ constraintTraces: 0, toolCalls: 0, outcomes: 0, incidents: 0 });
    expect(await fileStore.listEvolutionProposals()).toEqual([]);
    // 未写任何目标文件（绝不自动生效）
    expect(fs.existsSync(path.join(tmpDir, '.harness', 'config.yml'))).toBe(false);
  });

  it('(a) 自动提案只留 high_noise（#624）：高噪候选产 retire 提案，零触发/不可评估 report-only', async () => {
    // no_test_simplification：25 次评估 21 次 fail（failRate 0.84 > 0.8，evaluated ≥ 20）→ high_noise；
    // docs_freshness：全部 skip → unevaluable；其余内置约束零触发 → zero_trigger。
    writeJsonl(traceFile(), [
      ...Array.from({ length: 25 }, (_, i) => ({
        constraintId: 'no_test_simplification',
        timestamp: NOW - 3600_000 + i * 1000,
        result: i < 21 ? 'fail' : 'pass',
        operation: 'code_implementation',
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        constraintId: 'docs_freshness',
        timestamp: NOW - 3600_000 + i * 1000,
        result: 'skip',
        operation: 'code_implementation',
      })),
    ]);

    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    const constraintProps = result.created.filter(p => p.constraintChange === 'retire');
    // 仅 high_noise 产提案，且只有 1 个
    expect(constraintProps.length).toBe(1);
    const p = constraintProps[0];
    expect(p.targetId).toBe('no_test_simplification');
    expect(p.source).toBe('harness:usage-report');
    expect(p.action).toBe('amend');
    expect(['iron-law', 'guideline']).toContain(p.targetType);
    expect(p.rationale).toContain('usage report');
    // 统计数字只进 evidence，不进 proposedText/rationale（#624：抑重键不受数字漂移影响）
    expect(p.evidence.eventCounts).toMatchObject({ total: 25, evaluated: 25, fail: 21 });
    expect(p.proposedText).not.toMatch(/\d/);
    // zero_trigger（其余内置约束）+ unevaluable（docs_freshness）全部 report-only 跳过
    expect(result.skipped['report-only-candidate']).toBeGreaterThanOrEqual(6);
  });

  it('(a) rejected 后同目标不重提：抑重键按 constraintChange，不受 proposedText 数字漂移影响（#624）', async () => {
    writeJsonl(traceFile(), Array.from({ length: 25 }, (_, i) => ({
      constraintId: 'no_test_simplification',
      timestamp: NOW - 3600_000 + i * 1000,
      result: i < 21 ? 'fail' : 'pass',
      operation: 'code_implementation',
    })));
    const first = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(first.created.length).toBe(1);
    // 人审拒绝，且拟被拒绝的是旧格式提案（proposedText 内嵌统计数字——修复前形态）
    await fileStore.updateEvolutionProposal(first.created[0].id, {
      status: 'rejected',
      proposedText: '退役（高噪）：fail 率 84%（21/25），疑似误报源',
    });
    // 下一轮统计数字漂移（fail 数变化，仍是 high_noise）——旧抑重键（拼 proposedText）会放行重提
    writeJsonl(traceFile(), Array.from({ length: 30 }, (_, i) => ({
      constraintId: 'no_test_simplification',
      timestamp: NOW - 1800_000 + i * 1000,
      result: i < 27 ? 'fail' : 'pass',
      operation: 'code_implementation',
    })));

    const second = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(second.created).toEqual([]);
    expect(second.skipped['duplicate']).toBe(1);
  });

  it('(a) 信号稀薄（traces 不存在）时零提案，不报错', async () => {
    const result = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(result.created.filter(p => p.constraintChange === 'retire')).toEqual([]);
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

  it('TTL: expired open proposal is swept to stale and the same target can be re-proposed (#602)', async () => {
    // EP-0002 自锁场景：pending 超期未审（人为老化到 20 天前，TTL=14d）→ 转 stale 放行
    writeOutcomeEvents(paths.studioEventsFile);
    const first = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(first.created.length).toBe(1);
    const id = first.created[0].id;
    await fileStore.updateEvolutionProposal(id, {
      createdAt: new Date(NOW - 20 * 24 * 3600_000).toISOString(),
    });

    const second = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(second.staled).toEqual([id]);
    const old = await fileStore.getEvolutionProposal(id);
    expect(old?.status).toBe('stale');
    expect(old?.staledAt).toBeTruthy();
    // stale 不算 open（不触发 open-exists），也不算 duplicate（从未人审，允许同文案重提）
    expect(second.created.length).toBe(1);
    expect(second.created[0].id).not.toBe(id);
  });

  it('TTL: expired approved proposal (apply stuck) is also swept to stale', async () => {
    writeOutcomeEvents(paths.studioEventsFile);
    const first = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    const id = first.created[0].id;
    await fileStore.updateEvolutionProposal(id, {
      status: 'approved',
      createdAt: new Date(NOW - 30 * 24 * 3600_000).toISOString(),
    });

    const second = await generateEvolutionProposals({ fileStore, paths, windowHours: 24 });
    expect(second.staled).toEqual([id]);
    expect(second.created.length).toBe(1);
  });
});
