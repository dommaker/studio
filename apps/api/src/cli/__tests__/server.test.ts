/**
 * server.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖服务管理域的离线安全路径：
 * - studioDb：固定输出 FileStore 提示；
 * - studioStop：端口无监听时输出 "No server found"（PORT/VITE_PORT 指向
 *   未占用端口，确保不会误杀本机真实进程）；
 * - studioStatus：API 不可达时输出 not reachable 并提前返回；
 * - checkPrerequisites：冒烟（不抛错，输出与否则取决于本机是否装 claude）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkPrerequisites, studioDb, studioStatus, studioStop } from '../server.js';

let logs: string[];
let errs: string[];
let prevPort: string | undefined;
let prevVitePort: string | undefined;

beforeEach(() => {
  logs = [];
  errs = [];
  prevPort = process.env.PORT;
  prevVitePort = process.env.VITE_PORT;
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
  if (prevVitePort === undefined) delete process.env.VITE_PORT;
  else process.env.VITE_PORT = prevVitePort;
});

describe('studioDb', () => {
  it('输出 FileStore 提示', async () => {
    await studioDb();
    expect(logs.join('\n')).toContain('DB commands removed — all data is stored in ~/.studio/ via FileStore.');
  });
});

describe('studioStop', () => {
  it('端口无监听时输出 No server found', async () => {
    process.env.PORT = '19111';
    process.env.VITE_PORT = '19112';
    await studioStop();
    expect(logs.join('\n')).toContain('No server found on port 19111');
    expect(logs.join('\n')).not.toContain('Server stopped');
  });
});

describe('studioStatus', () => {
  it('API 不可达时输出 not reachable 并提前返回', async () => {
    process.env.PORT = '19113';
    await studioStatus();
    const out = logs.join('\n');
    expect(out).toContain('Studio Status');
    expect(out).toContain('  Server:    ❌ not reachable (port 19113)');
    expect(out).toContain('  Start with: studio up');
    // 提前返回：不输出后续检查段
    expect(out).not.toContain('Channels:');
  });
});

describe('checkPrerequisites', () => {
  it('不抛错；缺依赖时输出 Missing prerequisites', () => {
    expect(() => checkPrerequisites()).not.toThrow();
    if (errs.length > 0) {
      expect(errs[0]).toMatch(/^Missing prerequisites: /);
      expect(errs[1]).toBe('Install them before running studio up.');
    }
  });
});
