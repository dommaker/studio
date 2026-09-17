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
    // #565 起 scanAllProviders 含 auth/能力探测（每 provider 多 1-2 次进程 spawn），
    // #574 起再挂模型列表探测（kimi `provider list --json` 实测 ~4s、opencode `models`
    // 实测 ~7s），真机全量扫描单跑即 ~15s——本用例打的是真 CLI，给足集成级窗口
  }, 30_000);

  // #573 漂移修正（摸底 Q5）：agent CLI 检查对齐 provider 注册表扫描，不再硬编码 claude
  it('注入空探测结果 → 报缺 agent CLI（注册表口径，不点名单一 CLI）', () => {
    checkPrerequisites([]);
    const out = errs.join('\n');
    expect(out).toMatch(/^Missing prerequisites: /);
    expect(out).toContain('agent CLI');
    expect(out).toContain('至少需要一个 agent CLI 才能跑执行');
    expect(out).not.toContain('claude CLI');
  });

  it('注入任一已探测 provider → 不报缺 agent CLI', () => {
    checkPrerequisites([{ provider: 'kimi', path: '/usr/local/bin/kimi', version: '1.0.0' }]);
    expect(errs.join('\n')).not.toContain('agent CLI');
  });
});
