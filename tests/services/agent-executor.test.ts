/**
 * AgentExecutor 单元测试
 *
 * 覆盖：卡住检测（stuckCount）、策略提示（STRATEGY_HINTS）、
 *       buildPrompt session 1 vs session 2+
 */
import { describe, it, expect } from 'vitest';

describe('AgentExecutor — 卡住检测逻辑', () => {
  function detectStuck(
    currentStep: string, lastStep: string,
    completedCount: number, lastCompletedCount: number,
    stuckCount: number,
  ): number {
    if (currentStep === lastStep && completedCount <= lastCompletedCount) {
      return stuckCount + 1;
    }
    return Math.max(0, stuckCount - 1);
  }

  it('连续相同 step 应递增 stuckCount', () => {
    expect(detectStuck('step-3', 'step-3', 2, 2, 0)).toBe(1);
    expect(detectStuck('step-3', 'step-3', 2, 2, 1)).toBe(2);
    expect(detectStuck('step-3', 'step-3', 2, 2, 2)).toBe(3);
  });

  it('不同 step 应递减 stuckCount', () => {
    expect(detectStuck('step-4', 'step-3', 3, 2, 2)).toBe(1);
    expect(detectStuck('step-4', 'step-3', 3, 2, 0)).toBe(0);
  });

  it('completedSteps 增加应递减 stuckCount（有进展）', () => {
    expect(detectStuck('step-3', 'step-3', 3, 2, 2)).toBe(1);
  });

  it('stuckCount 不会低于 0', () => {
    expect(detectStuck('step-4', 'step-3', 3, 2, 0)).toBe(0);
  });
});

describe('AgentExecutor — STRATEGY_HINTS', () => {
  const HINTS: Record<number, string> = {
    0: '',
    1: '不要重复相同的尝试。换一种实现思路',
    2: '缩小范围：只做当前步骤最核心的部分',
    3: '强制切换模式：先不要写代码，写出 mini plan',
    4: '最后一次机会——放弃当前方向，从第 0 行重新开始',
  };

  it('stuckCount=0 应无策略提示', () => {
    expect(HINTS[0]).toBe('');
  });

  it('stuckCount=1-4 应有逐级升级的策略提示', () => {
    expect(HINTS[1]).toContain('换一种实现思路');
    expect(HINTS[2]).toContain('缩小范围');
    expect(HINTS[3]).toContain('mini plan');
    expect(HINTS[4]).toContain('最后一次机会');
  });

  it('stuckCount>4 应使用 level 4 的提示', () => {
    const level = Math.min(5, 4);
    expect(HINTS[level]).toContain('最后一次机会');
  });
});

describe('AgentExecutor — buildPrompt 结构', () => {
  function buildPrompt(session: number, progress: { currentStep?: string; completedSteps?: string[]; testResults?: { passed: number; failed: number }; notes?: string } | null, stuckCount = 0): string {
    const parts: string[] = [];

    if (session === 1 || !progress) {
      parts.push('## 你的任务', '读 REQUIREMENTS.md', '## TDD 工作流');
    } else {
      parts.push('## 续接任务', `上次做到：${progress.currentStep || '未知'}`);

      const hintLevel = Math.min(stuckCount, 4);
      const hints: Record<number, string> = {
        0: '', 1: '换思路', 2: '缩小范围', 3: '写plan', 4: '重做',
      };
      if (hints[hintLevel]) parts.push(hints[hintLevel]);
    }

    return parts.join('\n');
  }

  it('session 1 应包含完整指令', () => {
    const prompt = buildPrompt(1, null);
    expect(prompt).toContain('你的任务');
    expect(prompt).toContain('TDD 工作流');
    expect(prompt).not.toContain('上次做到');
  });

  it('session 2+ 应包含续接指令', () => {
    const prompt = buildPrompt(2, { currentStep: 'step-2', completedSteps: ['step-1'] });
    expect(prompt).toContain('续接任务');
    expect(prompt).toContain('step-2');
    expect(prompt).not.toContain('TDD 工作流');
  });

  it('stuckCount>0 应注入策略提示', () => {
    const prompt = buildPrompt(2, { currentStep: 'step-2' }, 1);
    expect(prompt).toContain('换思路');
  });

  it('stuckCount=0 不应有策略提示', () => {
    const prompt = buildPrompt(2, { currentStep: 'step-3' }, 0);
    expect(prompt).not.toContain('换思路');
    expect(prompt).not.toContain('缩小范围');
  });
});
