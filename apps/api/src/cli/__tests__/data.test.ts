/**
 * data.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖数据域 apiCommand / studioEnv / studioMcp 的离线路径：
 * - 本地分支（run / 缺 id 的 show / 未知子命令）不发请求直接输出；
 * - 需要请求的分支在 API 不可达（ECONNREFUSED）时输出 "API server not running"。
 * 导入前将 PORT 指到未占用端口（API 常量在模块加载时计算），
 * HOME 指向临时目录避免读取真实 ~/.studio session-token。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let prevPort: string | undefined;
let data: typeof import('../data.js');
let logs: string[];
let errs: string[];

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-data-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  prevPort = process.env.PORT;
  process.env.PORT = '19141'; // 未占用端口 → ECONNREFUSED
  data = await import('../data.js');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiCommand 本地分支（不发请求）', () => {
  it('run 子命令提示使用 studio run', async () => {
    await data.apiCommand('tasks', ['run']);
    expect(logs.join('\n')).toContain('Use: studio run <requirement>');
  });

  it('show 缺 id → usage 错误', async () => {
    await data.apiCommand('knowledge', ['show']);
    expect(errs.join('\n')).toContain('Usage: studio knowledge show <id>');
  });

  it('未知子命令 → 默认用法行', async () => {
    await data.apiCommand('tasks', []);
    expect(logs.join('\n')).toContain('studio tasks <list|show|search>');
  });
});

describe('apiCommand 远端分支（API 不可达）', () => {
  it('list → ECONNREFUSED 提示', async () => {
    await data.apiCommand('channels', ['list']);
    expect(errs.join('\n')).toContain('API server not running. Run: studio up');
  });
});

describe('studioEnv / studioMcp', () => {
  it('studioEnv API 不可达 → ECONNREFUSED 提示', async () => {
    await data.studioEnv();
    expect(errs.join('\n')).toContain('API server not running. Run: studio up');
  });

  it('studioMcp 未知子命令 → 用法行', async () => {
    await data.studioMcp(['bogus']);
    expect(logs.join('\n')).toContain('studio mcp <tools|health>');
  });

  it('studioMcp 默认 tools 在 API 不可达时 → ECONNREFUSED 提示', async () => {
    await data.studioMcp([]);
    expect(errs.join('\n')).toContain('API server not running. Run: studio up');
  });
});
