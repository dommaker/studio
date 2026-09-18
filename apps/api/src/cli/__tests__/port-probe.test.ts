/**
 * port-probe.ts 单元测试（#571 npm 本地形态：端口动态顺延）。
 *
 * 冻结语义（docs/architecture/data-directory-contract.md §7）：
 * - 默认 3001，占用顺次探测 +1 …（上限 maxOffset）；
 * - 显式指定（--port / PORT）占用即拒启，显式意图不被顺延覆盖；
 * - 顺延耗尽报错拒启。
 * 探测用 node net 模块（跨平台），不走 lsof（Linux-only）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { probePortFree, resolvePort, parsePortFlag, explicitPortFromEnv } from '../port-probe.js';

const HOST = '127.0.0.1';

let servers: net.Server[] = [];

async function occupy(port: number): Promise<net.Server> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, HOST, () => resolve());
  });
  servers.push(srv);
  return srv;
}

/** 从 OS 取一个空闲端口（listen 0 后立即关闭，供后续用例占用/探测） */
async function grabFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, HOST, () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

afterEach(async () => {
  for (const srv of servers) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  servers = [];
});

describe('probePortFree', () => {
  it('空闲端口返回 true', async () => {
    const port = await grabFreePort();
    expect(await probePortFree(port, HOST)).toBe(true);
  });

  it('被占用端口返回 false', async () => {
    const port = await grabFreePort();
    await occupy(port);
    expect(await probePortFree(port, HOST)).toBe(false);
  });
});

describe('resolvePort', () => {
  it('首选端口空闲 → 直接命中，无顺延', async () => {
    const port = await grabFreePort();
    const r = await resolvePort({ host: HOST, preferred: port, maxOffset: 5 });
    expect(r.port).toBe(port);
    expect(r.shiftedFrom).toBeNull();
  });

  it('首选被占用 → 顺延到下一个空闲端口并记录 shiftedFrom', async () => {
    const base = await grabFreePort();
    await occupy(base);
    await occupy(base + 1);
    const r = await resolvePort({ host: HOST, preferred: base, maxOffset: 5 });
    expect(r.port).toBe(base + 2);
    expect(r.shiftedFrom).toBe(base);
  });

  it('顺延耗尽 → 抛错拒启', async () => {
    const base = await grabFreePort();
    await occupy(base);
    await occupy(base + 1);
    await expect(resolvePort({ host: HOST, preferred: base, maxOffset: 1 }))
      .rejects.toThrow(/[Nn]o free port/);
  });

  it('显式端口空闲 → 命中', async () => {
    const port = await grabFreePort();
    const r = await resolvePort({ host: HOST, explicitPort: port });
    expect(r.port).toBe(port);
    expect(r.shiftedFrom).toBeNull();
  });

  it('显式端口被占用 → 抛错拒启（不顺延）', async () => {
    const port = await grabFreePort();
    await occupy(port);
    await expect(resolvePort({ host: HOST, explicitPort: port }))
      .rejects.toThrow(new RegExp(`${port}`));
    // 显式语义报错文案须体现「显式指定不顺延」
    await expect(resolvePort({ host: HOST, explicitPort: port }))
      .rejects.toThrow(/explicit/i);
  });
});

describe('explicitPortFromEnv', () => {
  it('--port flag 优先于 PORT env', () => {
    expect(explicitPortFromEnv(3005, { PORT: '4001' })).toBe(3005);
  });

  it('仅 PORT env → 用之（显式语义）', () => {
    expect(explicitPortFromEnv(undefined, { PORT: '4001' })).toBe(4001);
  });

  it('皆无 → undefined（走动态顺延）', () => {
    expect(explicitPortFromEnv(undefined, {})).toBeUndefined();
  });

  it('PORT 非数字/越界 → 抛错', () => {
    expect(() => explicitPortFromEnv(undefined, { PORT: 'abc' })).toThrow(/PORT/);
    expect(() => explicitPortFromEnv(undefined, { PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('parsePortFlag', () => {
  it('无 --port → port undefined，args 原样', () => {
    expect(parsePortFlag(['web'])).toEqual({ port: undefined, rest: ['web'] });
  });

  it('--port 3005 → port 3005，flag 从参数中摘除', () => {
    expect(parsePortFlag(['web', '--port', '3005'])).toEqual({ port: 3005, rest: ['web'] });
  });

  it('--port 非数字 → 抛错', () => {
    expect(() => parsePortFlag(['--port', 'abc'])).toThrow(/--port/);
  });

  it('--port 缺值 → 抛错', () => {
    expect(() => parsePortFlag(['--port'])).toThrow(/--port/);
  });
});
