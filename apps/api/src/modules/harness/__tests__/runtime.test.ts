/**
 * runtime.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 本文件将 @dommaker/harness mock 为导入失败，验证：
 * - loadHarness 失败返回 false 且可重试（harnessLoading 复位）；
 * - getCollector / getAnalyzer / getKnowledgeStore / getKnowledgeQuery 全部降级为 null；
 * - getCached / setCache TTL 缓存的存取与过期语义。
 * HOME 指向临时目录隔离 knowledge-bus 链路。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// knowledge-bus 依赖 studio-shared（其模块级初始化需要真实 @dommaker/harness），
// 此处将其 mock 掉，使 harness 导入失败仅作用于 runtime.ts 的动态 import。
vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  UNIFIED_KNOWLEDGE_DIR: '/tmp/harness-runtime-test-knowledge',
}));

vi.mock('@dommaker/harness', () => {
  throw new Error('@dommaker/harness not installed');
});

let tmpHome: string;
let prevHome: string | undefined;
let runtime: typeof import('../runtime.js');

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runtime-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  runtime = await import('../runtime.js');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('runtime (harness unavailable)', () => {
  it('loadHarness returns false when import fails (and stays retryable)', async () => {
    expect(await runtime.loadHarness()).toBe(false);
    // 失败后 harnessLoading 复位，再次调用重试而非缓存 true
    expect(await runtime.loadHarness()).toBe(false);
    expect(runtime.harnessModule).toBeNull();
  });

  it('getCollector / getAnalyzer degrade to null', async () => {
    expect(await runtime.getCollector()).toBeNull();
    expect(await runtime.getAnalyzer()).toBeNull();
  });

  it('getKnowledgeStore / getKnowledgeQuery degrade to null', async () => {
    expect(await runtime.getKnowledgeStore()).toBeNull();
    expect(await runtime.getKnowledgeQuery()).toBeNull();
  });
});

describe('runtime TTL cache', () => {
  it('setCache / getCached roundtrip', () => {
    runtime.setCache('k1', { a: 1 });
    expect(runtime.getCached<{ a: number }>('k1')).toEqual({ a: 1 });
  });

  it('getCached returns undefined for missing key', () => {
    expect(runtime.getCached('nope')).toBeUndefined();
  });

  it('getCached returns undefined for expired entry', () => {
    runtime.setCache('k2', 'v', -1);
    expect(runtime.getCached('k2')).toBeUndefined();
  });
});
