/**
 * dependsOn 环检测测试 — AS-025 Phase 2 Step 2
 *
 * 含 Pipeline 9 阶段线性依赖 smoke test。
 */
import { describe, it, expect } from 'vitest';
import { hasCycle, validateNoCycle } from '../cycle-detection.js';

describe('hasCycle', () => {
  it('empty graph has no cycle', () => {
    expect(hasCycle(new Map())).toBe(false);
  });

  it('single node no deps has no cycle', () => {
    expect(hasCycle(new Map([['a', []]]))).toBe(false);
  });

  it('linear chain has no cycle', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(hasCycle(edges)).toBe(false);
  });

  it('self-loop is a cycle', () => {
    const edges = new Map([['a', ['a']]]);
    expect(hasCycle(edges)).toBe(true);
  });

  it('two-node cycle', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    expect(hasCycle(edges)).toBe(true);
  });

  it('three-node cycle', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    expect(hasCycle(edges)).toBe(true);
  });

  it('diamond (no cycle)', () => {
    // a → b, a → c, b → d, c → d
    const edges = new Map([
      ['a', ['b', 'c']],
      ['b', ['d']],
      ['c', ['d']],
      ['d', []],
    ]);
    expect(hasCycle(edges)).toBe(false);
  });

  it('disconnected components', () => {
    const edges = new Map([
      ['a', ['b']],
      ['b', []],
      ['c', ['d']],
      ['d', ['c']], // cycle in second component
    ]);
    expect(hasCycle(edges)).toBe(true);
  });
});

describe('validateNoCycle', () => {
  it('no existing edges, no cycle', () => {
    expect(() => validateNoCycle('a', ['b'], new Map())).not.toThrow();
  });

  it('adding edge that creates cycle throws', () => {
    // existing: b → a
    const existing = new Map([['b', ['a']]]);
    expect(() => validateNoCycle('a', ['b'], existing)).toThrow(/Cycle detected/);
  });

  it('adding edge that does not create cycle passes', () => {
    // existing: b → c
    const existing = new Map([['b', ['c']]]);
    expect(() => validateNoCycle('a', ['b'], existing)).not.toThrow();
  });
});

describe('Pipeline 9-stage smoke test', () => {
  /**
   * 验证 WorkUnit + dependsOn 能建模 Pipeline 9 阶段线性序列。
   * 这是 agent-network-migration.md §3.3 要求的 Pipeline 表达能力验证。
   *
   * Pipeline 9 阶段: Analyst → Decomposition → Planner → Executor →
   *                   TDD-Red → TDD-Green → TDD-Refactor → Reviewer → Deploy
   */
  it('9-stage linear pipeline has no cycle', () => {
    const stages = [
      'analyst',
      'decomposition',
      'planner',
      'executor',
      'tdd-red',
      'tdd-green',
      'tdd-refactor',
      'reviewer',
      'deploy',
    ];

    // Each stage depends on the previous one
    const edges = new Map<string, string[]>();
    edges.set(stages[0], []); // first stage has no deps
    for (let i = 1; i < stages.length; i++) {
      edges.set(stages[i], [stages[i - 1]]);
    }

    expect(hasCycle(edges)).toBe(false);
  });

  it('adding reverse dependency creates cycle', () => {
    const stages = ['a', 'b', 'c'];
    const edges = new Map<string, string[]>();
    edges.set('a', []);
    edges.set('b', ['a']);
    edges.set('c', ['b']);

    // Adding c → a would create cycle
    expect(() => validateNoCycle('a', ['c'], edges)).toThrow(/Cycle detected/);
  });

  it('parallel branches from same root (no cycle)', () => {
    // Pipeline with parallel execution:
    // analyst → [executor-a, executor-b] → reviewer
    const edges = new Map([
      ['analyst', []],
      ['executor-a', ['analyst']],
      ['executor-b', ['analyst']],
      ['reviewer', ['executor-a', 'executor-b']],
    ]);

    expect(hasCycle(edges)).toBe(false);
  });
});
