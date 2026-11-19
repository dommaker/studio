import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { makeTempHome, removeTempHome, findFreePort, buildServerEnv } from '../server.js';

describe('makeTempHome / removeTempHome', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) removeTempHome(h);
  });

  it('创建独立临时数据区，删除后不存在', () => {
    const home = makeTempHome();
    homes.push(home);
    expect(home).toContain('studio-perf-');
    expect(existsSync(home)).toBe(true);
    removeTempHome(home);
    expect(existsSync(home)).toBe(false);
  });

  it('两次创建互不相同', () => {
    const a = makeTempHome();
    const b = makeTempHome();
    homes.push(a, b);
    expect(a).not.toBe(b);
  });

  it('路径不含 studio-perf- 时拒绝删除（防误删保护）', () => {
    const stray = join(tmpdir(), `stray-${Date.now()}`);
    mkdirSync(stray);
    removeTempHome(stray);
    expect(existsSync(stray)).toBe(true);
    removeTempHome(stray);
  });
});

describe('findFreePort', () => {
  it('返回可绑定的空闲端口', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
    });
  });
});

describe('buildServerEnv', () => {
  it('最小 allowlist：宿主 secret 不继承，dotenv 指向隔离空配置', () => {
    process.env.PERF_TEST_HOST_SECRET = 'must-not-leak';
    const home = makeTempHome();
    try {
      const env = buildServerEnv({ studioHome: home, port: 39001, telemetry: true, extraEnv: { REGISTER_ENABLED: 'true' } });
      expect(env.PERF_TEST_HOST_SECRET).toBeUndefined();
      expect(env.HOME).toBe(home);
      expect(env.STUDIO_DATA_DIR).toBe(join(home, 'data'));
      expect(env.DOTENV_CONFIG_PATH).toBe(join(home, 'perf-empty.env'));
      expect(env.REGISTER_ENABLED).toBe('true');
      expect(env.NODE_OPTIONS).toContain('--import');
    } finally {
      removeTempHome(home);
      delete process.env.PERF_TEST_HOST_SECRET;
    }
  });
});
