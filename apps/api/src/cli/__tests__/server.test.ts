/**
 * server.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖服务管理域的离线安全路径：
 * - studioDb：固定输出 FileStore 提示；
 * - studioStop：端口无监听时输出 "No server found"（PORT/VITE_PORT 指向
 *   未占用端口，确保不会误杀本机真实进程）；
 * - studioStatus：API 不可达时输出 not reachable 并提前返回；
 * - checkPrerequisites：冒烟（不抛错；scanAllProviders 已 mock 隔离真机扫描，见 #577）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkPrerequisites, studioDb, studioStatus, studioStop } from '../server.js';

// #577：mock scanAllProviders 隔离真机全量扫描——#573 挂注册表扫描、#574 挂模型探测
// （kimi ~4s / opencode ~7s）后真扫描在复审环境实测 43-55s，两次上调超时（#565 → 30s）
// 仍被拖爆；扫描成本只随 provider 探测增长，单测不应为机器计时买单。importOriginal
// 部分 mock（wholesale mock import 期崩坑先例，见 agents/CONTEXT.md #575 条），
// KNOWN_PROVIDERS 等其余导出保持真实；git --version 检查仍走真 execSync。
vi.mock('../../daemon/cli-scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../daemon/cli-scanner.js')>();
  return {
    ...actual,
    scanAllProviders: () => [{ provider: 'kimi', path: '/usr/local/bin/kimi', version: '1.0.0' }],
  };
});

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
    // 扫描已由顶部 vi.mock 隔离（#577），本用例只验证默认参数路径不抛错 +
    // 缺 git 时的输出形态；无需集成级超时窗口
  });

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
