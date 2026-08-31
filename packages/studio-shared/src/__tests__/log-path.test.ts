/**
 * log-path（#361 自 apps/api 下沉后共享包侧单测）
 *
 * 覆盖测试/生产路径隔离规则：VITEST/NODE_ENV=test → os.tmpdir()/studio-test-logs，
 * 生产 → ~/.studio/logs；testTmpRoot 子根按进程实例唯一。
 */
import { describe, test, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { isTestEnv, testTmpRoot, resolveStudioLogsDir, resolveStudioLogFile } from '../log-path';

const prevVitest = process.env.VITEST;
const prevNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (prevVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = prevVitest;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

describe('isTestEnv', () => {
  test('VITEST=true 或 NODE_ENV=test 判定为测试环境（含显式 env 参数）', () => {
    expect(isTestEnv({ VITEST: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTestEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('resolveStudioLogsDir / resolveStudioLogFile', () => {
  test('测试环境 → os.tmpdir()/studio-test-logs，文件名拼接不变', () => {
    const dir = resolveStudioLogsDir({ VITEST: 'true' } as NodeJS.ProcessEnv);
    expect(dir).toBe(path.join(os.tmpdir(), 'studio-test-logs'));
    expect(resolveStudioLogFile('studio-events.jsonl', { VITEST: 'true' } as NodeJS.ProcessEnv))
      .toBe(path.join(dir, 'studio-events.jsonl'));
  });

  test('生产环境 → ~/.studio/logs', () => {
    const dir = resolveStudioLogsDir({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(dir).toContain(path.join('.studio', 'logs'));
  });
});

describe('testTmpRoot (#135)', () => {
  test('子根含唯一 TEST_RUN_ID；同参数同实例稳定复用', () => {
    const a1 = testTmpRoot('foo');
    const a2 = testTmpRoot('foo');
    const b = testTmpRoot('bar');
    expect(a1).toBe(a2);
    expect(a1.startsWith(path.join(os.tmpdir(), 'foo' + path.sep))).toBe(true);
    expect(b.startsWith(path.join(os.tmpdir(), 'bar' + path.sep))).toBe(true);
  });
});
