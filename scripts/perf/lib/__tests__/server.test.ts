import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { makeTempHome, removeTempHome, findFreePort } from '../server.js';

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
