/**
 * B2 单元测试 — 不需要运行服务器的模块
 *
 * 覆盖: error-class, knowledge-agent
 * （memory-store 已随 2026-10 架构精简刀2 删除——唯一消费方是 legacy AgentRegistry）
 */
import { describe, it, expect } from 'vitest';

describe('Triage ErrorClass (P1-11)', () => {
  it('classifySystemError maps service_down to timeout', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const r = classifySystemError('service_down', 'unreachable');
    expect(r.errorClass).toBe('timeout');
    expect(r.severity).toBe('critical');
  });

  it('classifySystemError maps ext_dependency to vendor_error', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const r = classifySystemError('ext_dependency', 'DB timeout');
    expect(r.errorClass).toBe('vendor_error');
  });

  it('classifySystemError maps ext_dependency + config to param_error', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const r = classifySystemError('ext_dependency', 'config file corrupt');
    expect(r.errorClass).toBe('param_error');
  });

  it('classifySystemError maps resource_critical to env_error', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const r = classifySystemError('resource_critical', 'disk full');
    expect(r.errorClass).toBe('env_error');
  });

  it('classifySystemError maps zombie to timeout', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const r = classifySystemError('zombie', 'defunct process');
    expect(r.errorClass).toBe('timeout');
  });

  it('classifySystemError falls back to env_error for unknown', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const r = classifySystemError('weird', 'something');
    expect(r.errorClass).toBe('env_error');
  });

  it('TriageErrorClass has 8 design values', async () => {
    const { classifySystemError } = await import('../src/modules/triage/error-class.js');
    const validClasses = ['timeout', 'test_failure', 'permission_denied', 'env_error',
      'vendor_error', 'validation_failure', 'user_abort', 'param_error'];
    // All patterns map to valid design classes
    const cases = [
      ['service_down', 'unreachable'],
      ['resource_critical', 'disk 95%'],
      ['zombie', 'stuck'],
      ['ext_dependency', 'api down'],
      ['ext_dependency', 'config missing'],
      ['ext_dependency', 'rate limited 429'],
    ];
    for (const [type, details] of cases) {
      const r = classifySystemError(type, details);
      expect(validClasses).toContain(r.errorClass);
    }
  });
});

describe('ErrorClass patterns (B1-007)', () => {
  it('classifyError detects syntax_error', async () => {
    const { classifyError } = await import('../src/modules/triage/error-class.js');
    const r = classifyError('syntax error: unexpected token at line 10');
    expect(r.errorClass).toBe('syntax_error');
    expect(r.severity).toBe('low');
  });

  it('classifyError detects runtime_error', async () => {
    const { classifyError } = await import('../src/modules/triage/error-class.js');
    const r = classifyError('Cannot read properties of undefined');
    expect(r.errorClass).toBe('runtime_error');
    expect(r.severity).toBe('high');
  });

  it('classifyError detects permission_error', async () => {
    const { classifyError } = await import('../src/modules/triage/error-class.js');
    const r = classifyError('EACCES: permission denied');
    expect(r.errorClass).toBe('permission_error');
  });

  it('classifyError falls back to unknown_error', async () => {
    const { classifyError } = await import('../src/modules/triage/error-class.js');
    const r = classifyError('something completely unexpected happened here');
    expect(r.errorClass).toBe('unknown_error');
  });
});
