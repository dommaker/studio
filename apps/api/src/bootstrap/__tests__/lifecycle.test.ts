/**
 * bootstrap/lifecycle 测试（P2-a）：
 * - installErrorHandlers 注册 unhandledRejection/uncaughtException + Express 错误兜底中间件；
 * - listen 挂 EADDRINUSE 拒启错误处理并启动监听；
 * - 优雅关闭保持原逆序清理：unmount AgentLoop → 杀在飞 CLI 进程组 → 杀 cloudflared
 *   → 停进化调度 → monitor.stop → auditor.stop → server.close。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('../../modules/agent-loop/index.js', () => ({
  agentLoopRegistry: { unmountAll: () => calls.push('unmountAll') },
}));
vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: { stopAllProcessGroups: vi.fn(async () => { calls.push('stopAllProcessGroups'); return 0; }) },
}));
vi.mock('../tunnel.js', () => ({
  stopTunnel: () => calls.push('stopTunnel'),
}));
vi.mock('../../modules/knowledge/evolution-scheduler.js', () => ({
  startEvolutionScheduler: vi.fn(),
  stopEvolutionScheduler: () => calls.push('stopEvolutionScheduler'),
}));
vi.mock('../../modules/agents/monitor/monitor.service.js', () => ({
  monitorService: { start: vi.fn(), stop: () => calls.push('monitor.stop') },
}));
vi.mock('../../modules/agent-auditor/index.js', () => ({
  auditorService: { start: vi.fn(), stop: () => calls.push('auditor.stop') },
}));

import { installErrorHandlers, listen, registerShutdown } from '../lifecycle.js';

function fakeServer() {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    handlers,
    on: vi.fn((event: string, fn: (...args: any[]) => void) => { handlers.set(event, fn); }),
    listen: vi.fn(),
    close: vi.fn((cb?: () => void) => { calls.push('server.close'); cb?.(); }),
  } as any;
}

let processOnSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
});

afterEach(() => {
  processOnSpy.mockRestore();
  processExitSpy.mockRestore();
});

describe('installErrorHandlers', () => {
  it('注册进程级错误兜底 + Express 错误中间件', () => {
    const app = { use: vi.fn() } as any;
    installErrorHandlers(app);
    const events = processOnSpy.mock.calls.map(c => c[0]);
    expect(events).toContain('unhandledRejection');
    expect(events).toContain('uncaughtException');
    expect(app.use).toHaveBeenCalledOnce();
  });
});

describe('listen', () => {
  it('挂 error 处理（EADDRINUSE 拒启）并启动监听', () => {
    const server = fakeServer();
    listen(server, { port: 3001, host: '127.0.0.1' });
    expect(server.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(server.listen).toHaveBeenCalledWith(3001, '127.0.0.1', expect.any(Function));
  });
});

describe('registerShutdown — 优雅关闭逆序清理', () => {
  it('SIGTERM：按原 index.ts 顺序逆序清理', async () => {
    const server = fakeServer();
    registerShutdown(server);
    const sigterm = processOnSpy.mock.calls.find(c => c[0] === 'SIGTERM')?.[1] as () => Promise<void>;
    expect(sigterm).toBeDefined();
    await sigterm();
    expect(calls).toEqual([
      'unmountAll',
      'stopAllProcessGroups',
      'stopTunnel',
      'stopEvolutionScheduler',
      'monitor.stop',
      'auditor.stop',
      'server.close',
    ]);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('SIGINT 同样注册关闭流程', () => {
    const server = fakeServer();
    registerShutdown(server);
    expect(processOnSpy.mock.calls.map(c => c[0])).toContain('SIGINT');
  });
});
