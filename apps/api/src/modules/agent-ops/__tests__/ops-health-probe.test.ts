/**
 * OpsService.getStatus() API 探针语义测试
 *
 * 复现 2026-09-15 生产事故（ops 探针假阴性）：探针打带鉴权的
 * /api/v1/channels 且仅认 statusCode===200，该端点加 requireAuth 后恒 401
 * → apiResponding 恒 false → healthCheck 每 5 分钟 process.exit(1)
 * → systemd 拉起 → 看门狗自杀循环。
 *
 * 修复口径（防御纵深两层）：
 * 1. 探针改打免鉴权端点 /health（app.ts 注册于鉴权中间件之前）；
 * 2. 语义修对——收到任何 HTTP 响应（含 401/403）即判「进程在服务」，
 *    只有连接失败/超时才判死。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';

// 强制 loadRules 走 defaults，不读真实 ~/.studio/ops-rules.json
process.env.OPS_RULES_PATH = '/nonexistent-studio-test/ops-rules.json';

import { OpsService } from '../ops.service.js';

let server: http.Server;
let port: number;
let lastUrl: string | undefined;
let statusToRespond = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url;
    res.writeHead(statusToRespond).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeOps(p: number): OpsService {
  // getStatus 不触 fileStore，传最小桩避免 FileStore 实例化扫盘
  return new OpsService(p, {} as any);
}

describe('OpsService API 探针（2026-09-15 假阴性事故防回归）', () => {
  it('401 响应判活：任何 HTTP 响应都证明进程在服务（仅连接失败/超时判死）', async () => {
    statusToRespond = 401;
    const status = await makeOps(port).getStatus();
    expect(status.apiResponding).toBe(true);
  });

  it('探针打免鉴权 /health，不打需鉴权的 /api/v1/channels', async () => {
    statusToRespond = 200;
    await makeOps(port).getStatus();
    expect(lastUrl).toBe('/health');
  });

  it('连接失败（端口关闭）判死', async () => {
    // 拿一个曾监听现已关闭的端口，保证 ECONNREFUSED
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    const status = await makeOps(closedPort).getStatus();
    expect(status.apiResponding).toBe(false);
  });
});
