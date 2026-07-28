/**
 * studio-log-path (P0 修复 5) — 测试/生产日志路径隔离
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTestEnv, resolveStudioLogsDir, resolveStudioLogFile } from '../studio-log-path.js';

describe('isTestEnv', () => {
  it('VITEST 存在 → true', () => {
    expect(isTestEnv({ VITEST: 'true' })).toBe(true);
    expect(isTestEnv({ VITEST: '1' })).toBe(true);
  });

  it('NODE_ENV=test → true', () => {
    expect(isTestEnv({ NODE_ENV: 'test' })).toBe(true);
  });

  it('两者都无 → false（生产）', () => {
    expect(isTestEnv({})).toBe(false);
    expect(isTestEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(isTestEnv({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('resolveStudioLogsDir', () => {
  it('测试环境 → os.tmpdir()/studio-test-logs', () => {
    expect(resolveStudioLogsDir({ VITEST: 'true' }))
      .toBe(path.join(os.tmpdir(), 'studio-test-logs'));
    expect(resolveStudioLogsDir({ NODE_ENV: 'test' }))
      .toBe(path.join(os.tmpdir(), 'studio-test-logs'));
  });

  it('生产环境 → ~/.studio/logs（行为不变）', () => {
    expect(resolveStudioLogsDir({}))
      .toBe(path.join(os.homedir(), '.studio', 'logs'));
  });
});

describe('resolveStudioLogFile', () => {
  it('测试环境改写到隔离目录且文件名格式不变', () => {
    expect(resolveStudioLogFile('tasks-2026-07-27.jsonl', { VITEST: 'true' }))
      .toBe(path.join(os.tmpdir(), 'studio-test-logs', 'tasks-2026-07-27.jsonl'));
    expect(resolveStudioLogFile('studio-events.jsonl', { NODE_ENV: 'test' }))
      .toBe(path.join(os.tmpdir(), 'studio-test-logs', 'studio-events.jsonl'));
  });

  it('生产环境保持 ~/.studio/logs 下原路径', () => {
    expect(resolveStudioLogFile('incidents.jsonl', {}))
      .toBe(path.join(os.homedir(), '.studio', 'logs', 'incidents.jsonl'));
  });
});

describe('当前 vitest 进程（VITEST 已设置）', () => {
  it('默认 env 解析到隔离目录 —— 测试不再写生产路径', () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(resolveStudioLogsDir()).toBe(path.join(os.tmpdir(), 'studio-test-logs'));
    expect(resolveStudioLogsDir()).not.toContain('.studio' + path.sep + 'logs');
  });
});
