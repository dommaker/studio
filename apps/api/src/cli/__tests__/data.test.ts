/**
 * data.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖数据域 apiCommand / studioKnowledge / studioEnv / studioMcp 的离线路径：
 * - 本地分支（缺 id 的 show / 未知子命令 / upsert 缺参）不发请求直接输出；
 * - 需要请求的分支在 API 不可达（ECONNREFUSED）时输出 "API server not running"。
 * 导入前将 PORT 指到端口 19141（API 常量在模块加载时计算），
 * HOME 指向临时目录避免读取真实 ~/.studio session-token。
 * 注意：文件末尾的 happy-path describe 会在 19141 起 stub server，
 * 依赖执行顺序——ECONNREFUSED 用例必须排在它之前。
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

describe('studioKnowledge 本地分支（不发请求）', () => {
  it('upsert 缺必需参数 → usage 错误', async () => {
    await data.studioKnowledge(['upsert', '--scope', 'test']);
    expect(errs.join('\n')).toContain('Usage: studio knowledge upsert');
  });

  it('upsert --file 指向不存在文件 → 读文件错误', async () => {
    await data.studioKnowledge(['upsert', '--scope', 's', '--title', 't', '--file', '/nonexistent/nope.md']);
    expect(errs.join('\n')).toContain('Failed to read file');
  });

  it('list/show/search 委托 apiCommand（未知子命令 → 用法行）', async () => {
    await data.studioKnowledge([]);
    expect(logs.join('\n')).toContain('studio knowledge <list|show|search');
  });
});

describe('studioKnowledge 远端分支（API 不可达）', () => {
  it('upsert 参数齐全 → ECONNREFUSED 提示', async () => {
    await data.studioKnowledge(['upsert', '--scope', 's', '--title', 't', '--content', 'c']);
    expect(errs.join('\n')).toContain('API server not running. Run: studio up');
  });

  it('sync-status → ECONNREFUSED 提示', async () => {
    await data.studioKnowledge(['sync-status']);
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
    expect(logs.join('\n')).toContain('studio mcp <tools|health|install>');
  });

  it('studioMcp 默认 tools 在 API 不可达时 → ECONNREFUSED 提示', async () => {
    await data.studioMcp([]);
    expect(errs.join('\n')).toContain('API server not running. Run: studio up');
  });
});

describe('studioKnowledge happy path（stub server）', () => {
  let server: import('node:http').Server;
  let lastReq: { method: string; url: string; body: any } | null;

  beforeAll(async () => {
    const http = await import('node:http');
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        lastReq = { method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null };
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/knowledge/upsert') {
          res.end(JSON.stringify({ knowledgeStore: { action: 'created', entryId: 'k-1' } }));
        } else if (req.url === '/api/knowledge/sync-status') {
          res.end(JSON.stringify({ trackedScopes: ['a'], stale: [], unmonitored: [], healed: [] }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(19141, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => { lastReq = null; });

  it('upsert POST /api/knowledge/upsert 带正确 body 并打印结果', async () => {
    await data.studioKnowledge(['upsert', '--scope', 'harness', '--title', 'T', '--content', 'C']);
    expect(lastReq?.method).toBe('POST');
    expect(lastReq?.url).toBe('/api/knowledge/upsert');
    expect(lastReq?.body).toEqual({
      scope: 'harness', title: 'T', content: 'C', type: 'architecture', source: 'cli',
    });
    expect(logs.join('\n')).toContain('k-1');
  });

  it('upsert --file 读取文件内容', async () => {
    const f = path.join(tmpHome, 'k.md');
    fs.writeFileSync(f, 'from-file');
    await data.studioKnowledge(['upsert', '--scope', 's', '--title', 't', '--file', f]);
    expect(lastReq?.body?.content).toBe('from-file');
  });

  it('sync-status GET /api/knowledge/sync-status 并打印 JSON', async () => {
    await data.studioKnowledge(['sync-status']);
    expect(lastReq?.method).toBe('GET');
    expect(lastReq?.url).toBe('/api/knowledge/sync-status');
    expect(logs.join('\n')).toContain('"trackedScopes"');
  });
});

