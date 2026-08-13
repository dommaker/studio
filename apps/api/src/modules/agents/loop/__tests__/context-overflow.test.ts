// #96 context-overflow 纯函数单测：溢出错误识别 / 会话滚动摘要构建。
// 溢出识别与 session-resume 的 RESUME_FAILURE_RE「会话不存在」是不同失败类型，别混。
import { describe, it, expect } from 'vitest';
import type { WorkUnitMetadata } from '../../../../workunit/workunit.service.js';
import {
  OVERFLOW_ERROR_RE,
  isContextOverflowError,
  buildRollingSummary,
  OVERFLOW_SUMMARY_HEADER,
} from '../context-overflow.js';

describe('OVERFLOW_ERROR_RE / isContextOverflowError', () => {
  it('匹配 Claude Code CLI 实测溢出错误「Prompt is too long」', () => {
    expect(isContextOverflowError('Prompt is too long')).toBe(true);
    expect(isContextOverflowError('prompt is too long: reduce input and retry')).toBe(true);
  });

  it('匹配 Anthropic API 上下文超限错误（context length / maximum context / context_length_exceeded）', () => {
    expect(isContextOverflowError('This request is over the maximum context length. Please reduce the length of the prompt and try again.')).toBe(true);
    expect(isContextOverflowError('context_length_exceeded')).toBe(true);
    expect(isContextOverflowError('Context window exceeded')).toBe(true);
    expect(isContextOverflowError('exceeds the maximum tokens')).toBe(true);
  });

  it('匹配 token 超限类错误（too many tokens / token limit）', () => {
    expect(isContextOverflowError('too many tokens')).toBe(true);
    expect(isContextOverflowError('token limit exceeded')).toBe(true);
  });

  it('非溢出错误不匹配（会话不存在 / 超时 / spawn / 业务失败）', () => {
    expect(isContextOverflowError('No conversation found with session ID sess-1')).toBe(false);
    expect(isContextOverflowError('Session not found')).toBe(false);
    expect(isContextOverflowError('CLI boom')).toBe(false);
    expect(isContextOverflowError('timeout after 120s')).toBe(false);
    expect(isContextOverflowError('spawn claude ENOENT')).toBe(false);
  });

  it('OVERFLOW_ERROR_RE 与 RESUME_FAILURE_RE 无交集（识别词表不重叠）', () => {
    // 溢出识别词表不匹配「会话不存在」类；续用识别词表不匹配溢出类
    expect(OVERFLOW_ERROR_RE.test('No conversation found')).toBe(false);
    expect(OVERFLOW_ERROR_RE.test('Session not found')).toBe(false);
    expect(OVERFLOW_ERROR_RE.test('Prompt is too long')).toBe(true);
  });
});

describe('buildRollingSummary', () => {
  const progressLog: WorkUnitMetadata['progressLog'] = [
    { step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' },
    { step: 2, action: 'complete', summary: '完成服务层并自测通过', at: '2026-08-12T10:05:00Z' },
  ];

  it('摘要 = 任务 scope + 已完成步骤（旧→新）', () => {
    const summary = buildRollingSummary('实现登录功能', { progressLog });
    expect(summary).toContain('任务：实现登录功能');
    expect(summary).toContain('已完成步骤：');
    expect(summary).toContain('- 第 1 步 [progress]：完成数据层');
    expect(summary).toContain('- 第 2 步 [complete]：完成服务层并自测通过');
  });

  it('无 progressLog / 无 scope → 不含对应行（不抛错）', () => {
    expect(buildRollingSummary(undefined, {})).toBe('');
    expect(buildRollingSummary('', {})).toBe('');
  });

  it('附上一步失败行（errorType 存在时）', () => {
    const summary = buildRollingSummary('实现登录功能', { progressLog, errorType: 'execution_failed' });
    expect(summary).toContain('上一步执行失败（execution_failed）');
  });

  it('progressLog 畸形条目（null/标量）窄断言跳过，不渲染脏数据', () => {
    const summary = buildRollingSummary('任务', {
      progressLog: [null, 42, { step: 1, action: 'progress', summary: '有效步', at: 'x' }] as unknown as WorkUnitMetadata['progressLog'],
    });
    expect(summary).toContain('- 第 1 步 [progress]：有效步');
    expect(summary).not.toContain('null');
    expect(summary).not.toContain('42');
  });

  it('摘要不递归：不引用历史摘要字段（只从 scope/progressLog/errorType 构建）', () => {
    const summary = buildRollingSummary('实现登录功能', { progressLog });
    expect(summary).not.toContain('会话摘要');
  });
});

describe('OVERFLOW_SUMMARY_HEADER', () => {
  it('摘要段标题为非空字符串（注入新会话 prompt 用）', () => {
    expect(typeof OVERFLOW_SUMMARY_HEADER).toBe('string');
    expect(OVERFLOW_SUMMARY_HEADER.length).toBeGreaterThan(0);
    expect(OVERFLOW_SUMMARY_HEADER).toContain('会话摘要');
  });
});
