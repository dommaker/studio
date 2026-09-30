/**
 * bootstrap/index 装配测试（P2-a）：
 * - 装配顺序 = 原 index.ts start() 逐行顺序（迁移先于对账、warmup 跨 registerRoutes 两段、
 *   listen 在 error handler 之后、shutdown 最后注册）；
 * - 数据区迁移失败 = 拒启：catch 落错误日志 + process.exit(1)，后续步骤不再执行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({
  migrationsError: null as Error | null,
  fakeServer: { fake: true },
}));

vi.mock('../config.js', () => ({
  initConfig: () => calls.push('initConfig'),
  getPort: () => 3001,
  getHost: () => '127.0.0.1',
}));
vi.mock('../migrations.js', () => ({
  runDataMigrations: vi.fn(async () => {
    calls.push('runDataMigrations');
    if (state.migrationsError) throw state.migrationsError;
  }),
  reconcileWorkUnitIndex: vi.fn(async () => { calls.push('reconcileWorkUnitIndex'); }),
}));
vi.mock('../seed.js', () => ({
  seedBuiltinSkillsStep: vi.fn(async () => { calls.push('seedBuiltinSkillsStep'); }),
}));
vi.mock('../warmup.js', () => ({
  startWarmupTasks: () => calls.push('startWarmupTasks'),
  startPostRoutesWarmup: () => calls.push('startPostRoutesWarmup'),
}));
vi.mock('../services.js', () => ({
  startCoreServices: vi.fn(async () => { calls.push('startCoreServices'); }),
}));
vi.mock('../agent-loop.js', () => ({
  startAgentLoops: vi.fn(async () => { calls.push('startAgentLoops'); }),
  sweepEmptyAgentDirs: vi.fn(async () => { calls.push('sweepEmptyAgentDirs'); }),
}));
vi.mock('../channels.js', () => ({
  initChannels: vi.fn(async () => { calls.push('initChannels'); }),
}));
vi.mock('../handlers.js', () => ({
  registerScanHandlers: vi.fn(async () => { calls.push('registerScanHandlers'); }),
}));
vi.mock('../lifecycle.js', () => ({
  createHttpServer: () => { calls.push('createHttpServer'); return state.fakeServer; },
  installErrorHandlers: () => calls.push('installErrorHandlers'),
  listen: () => calls.push('listen'),
  registerShutdown: () => calls.push('registerShutdown'),
}));
vi.mock('../tunnel.js', () => ({
  startTunnelIfEnabled: () => calls.push('startTunnelIfEnabled'),
}));
vi.mock('../../app.js', () => ({
  app: { fake: true },
  registerRoutes: vi.fn(async () => { calls.push('registerRoutes'); }),
}));
vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bootstrapHarness: vi.fn(async () => { calls.push('bootstrapHarness'); }),
}));

import { bootstrap } from '../index.js';
import { runDataMigrations } from '../migrations.js';

let processExitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  state.migrationsError = null;
  vi.clearAllMocks();
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe('bootstrap 装配', () => {
  it('按原 index.ts start() 顺序装配全部启动步骤', async () => {
    await bootstrap();
    expect(calls).toEqual([
      'initConfig',
      'runDataMigrations',
      'reconcileWorkUnitIndex',
      'seedBuiltinSkillsStep',
      'bootstrapHarness',
      'startWarmupTasks',
      'registerRoutes',
      'startPostRoutesWarmup',
      'createHttpServer',
      'startCoreServices',
      'startAgentLoops',
      'initChannels',
      'sweepEmptyAgentDirs',
      'registerScanHandlers',
      'installErrorHandlers',
      'listen',
      'startTunnelIfEnabled',
      'registerShutdown',
    ]);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('数据区迁移失败 = 拒启：exit(1)，后续步骤不执行', async () => {
    state.migrationsError = new Error('MigrationError: boom');
    await bootstrap();
    expect(calls).toEqual(['initConfig', 'runDataMigrations']);
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(runDataMigrations).toHaveBeenCalledOnce();
  });
});
