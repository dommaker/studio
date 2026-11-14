import { describe, expect, it } from 'vitest';
import { estimateTokens } from '@dommaker/harness';
import type { RecoveryPacket } from '../../workunit/index.js';
import { parseAgentOutput, stepActivityFromEvents } from '../agent-loop-parsers.js';
import { buildHandoffSection } from '../prompt-sections/prompt-section-handoff.js';

describe('#711 STEP_RECORD 输出协议', () => {
  it('解析结构化步骤详情，损坏记录不影响 ACTION', () => {
    const parsed = parseAgentOutput([
      'STEP_RECORD: {"acProgress":[{"ac":"AC1","status":"completed"}],"decisions":["采用现有事件流"],"nextStep":"补恢复测试"}',
      'ACTION: PROGRESS:模型已落盘',
    ].join('\n'));
    expect(parsed).toMatchObject({
      action: 'progress', summary: '模型已落盘',
      stepRecord: {
        acProgress: [{ ac: 'AC1', status: 'completed' }],
        decisions: ['采用现有事件流'], nextStep: '补恢复测试',
      },
    });

    const damaged = parseAgentOutput('STEP_RECORD: {bad json}\nACTION: COMPLETE:完成');
    expect(damaged).toMatchObject({ action: 'complete', summary: '完成' });
    expect(damaged.stepRecord).toBeUndefined();
  });

  it('从真实工具事件补充命令、结果和修改文件', () => {
    const details = stepActivityFromEvents([
      { type: 'assistant', content: [
        { type: 'tool_use', id: 'cmd-1', name: 'Bash', input: { command: 'pnpm typecheck' } },
        { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/repo/src/a.ts' } },
      ] },
      { type: 'user', content: [
        { type: 'tool_result', tool_use_id: 'cmd-1', is_error: false },
        { type: 'tool_result', tool_use_id: 'edit-1', is_error: false },
      ] },
    ]);
    expect(details).toEqual({
      commands: [{ command: 'pnpm typecheck', status: 'passed' }],
      modifiedFiles: ['/repo/src/a.ts'],
    });
  });
});

describe('#711 恢复包 handoff 段', () => {
  const packet: RecoveryPacket = {
    workUnitId: 'wu-1', assignmentId: 'assignment-1',
    mandate: null,
    acceptanceCriteria: [{ ac: '保留完整事实', status: 'in_progress' }],
    confirmedDecisions: ['只读实时 Git'],
    repository: { root: '/repo', branch: 'task/wu-1', commit: 'abc123', dirty: true, readAt: '2026-11-15T00:00:00.000Z' },
    unfinishedItems: ['保留完整事实', '补测试'],
    recentVerification: { status: 'failed', commands: ['pnpm test'], at: '2026-11-15T00:00:00.000Z' },
    openQuestions: ['是否继续？'],
    transcriptRefs: ['transcripts/wu-1.jsonl#step=1'],
    steps: [],
  };

  it('渲染 Mandate、AC、决策、Git、验证、问题和下一步，而非短摘要', () => {
    const built = buildHandoffSection({ stepCount: 1, sessionSummary: '过期摘要' }, true, 2000, packet);
    expect(built.section).toContain('## 恢复包');
    expect(built.section).toContain('保留完整事实');
    expect(built.section).toContain('task/wu-1');
    expect(built.section).toContain('abc123');
    expect(built.section).toContain('pnpm test');
    expect(built.section).toContain('是否继续？');
    expect(built.section).toContain('transcripts/wu-1.jsonl#step=1');
    expect(built.section).not.toContain('过期摘要');
  });

  it('没有旧 stepCount/摘要元数据时仍凭结构化记录恢复', () => {
    const built = buildHandoffSection({}, true, 2000, packet);
    expect(built.section).toContain('## 恢复包');
    expect(built.section).toContain('只读实时 Git');
  });

  it('恢复内容仍受 handoff token 预算约束', () => {
    const built = buildHandoffSection({ stepCount: 1 }, true, 50, packet);
    expect(built.tokens).toBeLessThanOrEqual(50);
    expect(estimateTokens(built.section)).toBeLessThanOrEqual(50);
    expect(built.originalTokens).toBeGreaterThan(built.tokens);
  });
});
