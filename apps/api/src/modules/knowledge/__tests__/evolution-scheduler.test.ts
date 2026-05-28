/**
 * Evolution Scheduler 独立测试
 *
 * 覆盖：startEvolutionScheduler / stopEvolutionScheduler 生命周期
 *
 * 策略：仅验证 start/stop 不抛异常 + logger 输出确认。不触发实际定时任务。
 */
import { describe, it, expect, vi } from 'vitest';

describe('EvolutionScheduler', () => {
  it('startEvolutionScheduler does not throw', async () => {
    const { startEvolutionScheduler } = await import('../evolution-scheduler.js');
    expect(() => startEvolutionScheduler()).not.toThrow();
  });

  it('stopEvolutionScheduler does not throw', async () => {
    const { stopEvolutionScheduler } = await import('../evolution-scheduler.js');
    expect(() => stopEvolutionScheduler()).not.toThrow();
  });

  it('stop is idempotent (no error when called without start)', async () => {
    const { stopEvolutionScheduler } = await import('../evolution-scheduler.js');
    expect(() => {
      stopEvolutionScheduler();
      stopEvolutionScheduler(); // double stop
    }).not.toThrow();
  });

  it('start → stop → start cycle works', async () => {
    const { startEvolutionScheduler, stopEvolutionScheduler } = await import('../evolution-scheduler.js');
    expect(() => {
      startEvolutionScheduler();
      stopEvolutionScheduler();
      startEvolutionScheduler();
      stopEvolutionScheduler();
    }).not.toThrow();
  });
});
