/**
 * cli/command-contract.ts 测试（随 ADR-0019 自 harness 迁移后补直测）
 */

import { describe, it, expect } from 'vitest';
import { log, logError, captureIO, lastJsonOutput } from '../command-contract.js';

describe('command-contract', () => {
  it('log 写 stdout 并附加换行（util.format 语义）', () => {
    const io = captureIO();
    log(io, 'a %s', 'b');
    expect(io.outText()).toBe('a b\n');
    expect(io.errText()).toBe('');
  });

  it('logError 写 stderr', () => {
    const io = captureIO();
    logError(io, 'oops');
    expect(io.errText()).toBe('oops\n');
    expect(io.outText()).toBe('');
  });

  it('captureIO 行切分：末尾换行不产生空尾行', () => {
    const io = captureIO();
    log(io, 'l1');
    log(io, 'l2');
    expect(io.outLines()).toEqual(['l1', 'l2']);
    expect(io.outRecords()).toEqual(['l1\n', 'l2\n']);
  });

  it('lastJsonOutput 解析 --json 输出', () => {
    const io = captureIO();
    log(io, JSON.stringify({ newSessions: 2, changes: [] }));
    expect(lastJsonOutput(io)).toEqual({ newSessions: 2, changes: [] });
  });
});
