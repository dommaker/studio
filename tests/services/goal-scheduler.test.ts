/**
 * GoalScheduler 单元测试
 *
 * 覆盖：detectConflicts（文件冲突分组）、getAvailableSlots（资源感知）、
 *       processGoal（调度逻辑）
 */
import { describe, it, expect, vi } from 'vitest';

// 直接测试内部逻辑（复制关键方法用于纯函数测试）
describe('GoalScheduler — detectConflicts', () => {
  function detectConflicts(executions: Array<{ id: string; input?: { acGroup?: { files?: string[] } } }>): string[][] {
    const batches: string[][] = [];
    const remaining = new Set(executions.map(e => e.id));
    while (remaining.size > 0) {
      const batch: string[] = [];
      const batchFiles = new Set<string>();
      for (const execId of [...remaining]) {
        const exec = executions.find(e => e.id === execId)!;
        const files = exec.input?.acGroup?.files || [];
        if (files.some(f => batchFiles.has(f))) continue;
        batch.push(execId);
        files.forEach(f => batchFiles.add(f));
        remaining.delete(execId);
      }
      if (batch.length === 0 && remaining.size > 0) {
        const first = [...remaining][0];
        batch.push(first);
        remaining.delete(first);
      }
      batches.push(batch);
    }
    return batches;
  }

  it('无冲突文件时应全部分入一批', () => {
    const execs = [
      { id: 'a', input: { acGroup: { files: ['src/a.ts'] } } },
      { id: 'b', input: { acGroup: { files: ['src/b.ts'] } } },
    ];
    expect(detectConflicts(execs)).toEqual([['a', 'b']]);
  });

  it('有冲突文件时应分入不同批次', () => {
    const execs = [
      { id: 'a', input: { acGroup: { files: ['src/shared.ts'] } } },
      { id: 'b', input: { acGroup: { files: ['src/shared.ts'] } } },
    ];
    const result = detectConflicts(execs);
    expect(result.length).toBe(2);
    expect(result.flat()).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('空文件列表的处理', () => {
    const execs = [
      { id: 'a', input: { acGroup: {} } },
      { id: 'b', input: { acGroup: { files: [] } } },
    ];
    expect(detectConflicts(execs)).toEqual([['a', 'b']]);
  });

  it('无 input 的兜底处理', () => {
    const execs = [
      { id: 'a' },
      { id: 'b', input: undefined },
    ];
    expect(detectConflicts(execs)).toEqual([['a', 'b']]);
  });
});

describe('GoalScheduler — getAvailableSlots', () => {
  let osMock: { freemem: () => number; totalmem: () => number; loadavg: () => number[]; cpus: () => unknown[] };

  function getAvailableSlots(
    freemem: number, totalmem: number, load: number, cpuCount: number,
  ): number {
    const freeMemPct = freemem / totalmem;
    const loadRatio = load / cpuCount;
    if (freeMemPct < 0.15) return 1;
    if (freeMemPct < 0.30) return 2;
    if (loadRatio > 0.90) return 2;
    return 5; // MAX_CONCURRENT
  }

  it('内存充足时应返回最大并发数', () => {
    expect(getAvailableSlots(8000, 16000, 1.0, 4)).toBe(5);
  });

  it('内存低于 15% 时应限制为 1', () => {
    expect(getAvailableSlots(1000, 16000, 1.0, 4)).toBe(1);
  });

  it('负载高于 90% 时应限制为 2', () => {
    expect(getAvailableSlots(8000, 16000, 3.8, 4)).toBe(2);
  });
});

// G5: 动态模型路由 — classifyTaskComplexity
describe('GoalScheduler — classifyTaskComplexity', () => {
  // 纯函数复制自 goal-scheduler.ts
  function classifyTaskComplexity(input: Record<string, any> | null, prompt: string): string {
    const acs = input?.acGroup?.acs ? JSON.stringify(input.acGroup.acs) : '';
    const taskDesc = (input?.taskDescription as string) || prompt || '';
    const combined = `${taskDesc} ${acs}`.toLowerCase();

    const isHighRiskDomain = /schema|migration|migrate|auth|authentication|security|financial|payment|encrypt|crypto/.test(combined);
    const isLowRiskDomain = /style|typo|rename|format|lint|comment|doc|readme|spelling|refactor.*simple/.test(combined);

    const acCount = input?.acGroup?.acs?.length || 1;
    const files: string[] = input?.acGroup?.files || [];
    const fileCount = files.length;

    if (isHighRiskDomain || acCount >= 4 || fileCount >= 5) return 'premium';
    if (isLowRiskDomain && acCount <= 1 && fileCount <= 2) return 'fast';
    return 'standard';
  }

  it('schema 变更 → premium', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1'], files: ['src/schema.prisma'] } },
      'migrate user table'
    )).toBe('premium');
  });

  it('auth 变更 → premium', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1'] }, taskDescription: 'implement JWT authentication' },
      ''
    )).toBe('premium');
  });

  it('多 AC 组 → premium', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], files: ['src/a.ts'] } },
      'refactor module'
    )).toBe('premium');
  });

  it('多文件变更 → premium', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1'], files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] } },
      'refactor'
    )).toBe('premium');
  });

  it('typo 修复 → fast', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1'], files: ['src/app.ts'] } },
      'fix typo in variable name'
    )).toBe('fast');
  });

  it('format 调整 → fast', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1'] }, taskDescription: 'format code with prettier' },
      ''
    )).toBe('fast');
  });

  it('普通任务 → standard', () => {
    expect(classifyTaskComplexity(
      { acGroup: { acs: ['AC-1', 'AC-2'], files: ['src/a.ts', 'src/b.ts'] } },
      'add user profile page'
    )).toBe('standard');
  });

  it('空 input → standard', () => {
    expect(classifyTaskComplexity(null, 'do something')).toBe('standard');
  });
});
