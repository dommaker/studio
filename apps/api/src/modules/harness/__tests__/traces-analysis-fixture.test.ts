/**
 * /analysis* 坏行透传的真实 fixture 集成测试（#451 验收第一条）。
 *
 * 与 traces.routes.test.ts 的边界分工：那一份在 @dommaker/harness 类边界 mock
 * （钉路由接线与零噪声），本文件不 mock harness——真实 TraceCollector +
 * TraceAnalyzer 读一份塞了一行坏数据的 traces.log，端到端验证
 * 「坏一行 → 200 + 部分结果 + skippedLines=1 + warn 日志」。
 *
 * pool=forks 每文件一进程，beforeAll chdir 到临时工程根（TraceCollector
 * 默认读 cwd 下 .harness/logs/traces.log），afterAll 还原。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@dommaker/studio-shared';

let tmpRoot: string;
let prevCwd: string;
let server: Server;
let base: string;

async function api(p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'traces-fixture-'));
  process.chdir(tmpRoot);

  // 2 行合法 + 1 行损坏；合法行同 constraintId（pass/fail 各一），时间戳落在默认 24h 窗内
  const valid = (result: 'pass' | 'fail') =>
    JSON.stringify({ constraintId: 'fx1', severity: 'error', timestamp: Date.now(), result });
  const logDir = path.join(tmpRoot, '.harness', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'traces.log'),
    [valid('pass'), 'not-json{{{corrupted', valid('fail')].join('\n') + '\n',
    'utf-8',
  );

  const { tracesRoutes } = await import('../traces.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', tracesRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('analysis endpoints with a corrupted traces.log（#451 AC）', () => {
  it('GET /analysis returns 200 + partial summaries + skippedLines=1 + warn', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await api('/analysis');
    expect(res.status).toBe(200);
    // summaries 只含合法记录：同一约束 pass/fail 各 1
    expect(res.json.summaries).toHaveLength(1);
    expect(res.json.summaries[0]).toMatchObject({ constraintId: 'fx1', passCount: 1, failCount: 1 });
    expect(res.json.totalSummaries).toBe(1);
    expect(res.json.skippedLines).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped'),
      expect.objectContaining({ skippedLines: 1 }),
    );
  });

  it('GET /analysis/anomalies returns 200 + skippedLines=1', async () => {
    const res = await api('/analysis/anomalies');
    expect(res.status).toBe(200);
    expect(res.json.skippedLines).toBe(1);
    expect(res.json.total).toBe(res.json.data.length);
  });
});
