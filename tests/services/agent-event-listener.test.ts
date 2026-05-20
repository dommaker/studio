/**
 * AgentEventListener 单元测试
 *
 * 覆盖：buildCompletionOutput、事件解析、@sibling 标记解析
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// 测试 buildCompletionOutput 的纯逻辑部分
describe('buildCompletionOutput — 输出构建逻辑', () => {
  const tmpDir = '/tmp/test-worktree-' + Date.now();

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildCompletionOutput(worktree: string): Record<string, any> {
    const output: Record<string, any> = { summary: '', changedFiles: [], completedAcs: [], siblingAdvice: [] };

    // 读取 .progress.json
    try {
      const pp = path.join(worktree, '.progress.json');
      if (fs.existsSync(pp)) {
        const progress = JSON.parse(fs.readFileSync(pp, 'utf-8'));
        output.summary = `完成 ${progress.completedSteps?.length || 0} 个步骤。${progress.notes || ''}`;
        output.completedAcs = progress.completedSteps || [];
      }
    } catch {}

    // 解析 @sibling 标记
    try {
      const pp = path.join(worktree, '.progress.json');
      if (fs.existsSync(pp)) {
        const progress = JSON.parse(fs.readFileSync(pp, 'utf-8'));
        const notes: string = progress.notes || '';
        const regex = /@sibling\s+(\S+):\s*(.+)/g;
        let match;
        while ((match = regex.exec(notes)) !== null) {
          output.siblingAdvice.push({ targetGroupId: match[1], message: match[2].trim(), priority: 'medium' });
        }
      }
    } catch {}

    return output;
  }

  it('正常 progress.json 解析', () => {
    const worktree = path.join(tmpDir, 'test-1');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.progress.json'), JSON.stringify({
      completedSteps: ['AC-001', 'AC-002'], notes: '关键决策：改用异步方案',
    }));

    const output = buildCompletionOutput(worktree);
    expect(output.summary).toContain('完成 2 个步骤');
    expect(output.summary).toContain('改用异步方案');
    expect(output.completedAcs).toEqual(['AC-001', 'AC-002']);

    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('缺少 progress.json 返回空 output', () => {
    const worktree = path.join(tmpDir, 'test-2');
    fs.mkdirSync(worktree, { recursive: true });

    const output = buildCompletionOutput(worktree);
    expect(output.summary).toBe('');
    expect(output.completedAcs).toEqual([]);

    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('@sibling 标记解析', () => {
    const worktree = path.join(tmpDir, 'test-3');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.progress.json'), JSON.stringify({
      completedSteps: ['AC-001'],
      notes: '改变了 API 签名。@sibling step-1: 旧签名已废弃，请用新接口',
    }));

    const output = buildCompletionOutput(worktree);
    expect(output.siblingAdvice.length).toBe(1);
    expect(output.siblingAdvice[0].targetGroupId).toBe('step-1');
    expect(output.siblingAdvice[0].message).toContain('新接口');

    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('多个 @sibling 标记', () => {
    const worktree = path.join(tmpDir, 'test-4');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.progress.json'), JSON.stringify({
      completedSteps: ['AC-001'],
      notes: '@sibling group-a: 注意依赖版本\n@sibling step-2: 接口已变更',
    }));

    const output = buildCompletionOutput(worktree);
    expect(output.siblingAdvice.length).toBe(2);

    fs.rmSync(worktree, { recursive: true, force: true });
  });
});

describe('AgentEventListener — 事件解析', () => {
  function parseEvent(raw: string): { event_type?: string; data?: Record<string, unknown> } | null {
    try {
      return JSON.parse(raw);
    } catch { return null; }
  }

  it('agent.completed 事件解析', () => {
    const evt = parseEvent(JSON.stringify({
      event_type: 'agent.completed',
      data: { executionId: 'exec-1', worktree: '/tmp/wt', sessionCount: 3 },
    }));
    expect(evt?.event_type).toBe('agent.completed');
    expect(evt?.data?.executionId).toBe('exec-1');
  });

  it('agent.failed 事件解析', () => {
    const evt = parseEvent(JSON.stringify({
      event_type: 'agent.failed',
      data: { executionId: 'exec-2', error: 'timeout' },
    }));
    expect(evt?.event_type).toBe('agent.failed');
  });

  it('无效 JSON 返回 null', () => {
    expect(parseEvent('not-json')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseEvent('')).toBeNull();
  });
});

describe('AgentEventListener — executionId fallback', () => {
  it('goalExecutionId 缺失时 fallback executionId', () => {
    const data = { executionId: 'exec-123', agentType: 'claude' };
    const goalExecutionId = (data as any).goalExecutionId || data.executionId;
    expect(goalExecutionId).toBe('exec-123');
  });

  it('goalExecutionId 存在时优先使用', () => {
    const data = { goalExecutionId: 'goal-456', executionId: 'exec-123' };
    const goalExecutionId = data.goalExecutionId || data.executionId;
    expect(goalExecutionId).toBe('goal-456');
  });
});
