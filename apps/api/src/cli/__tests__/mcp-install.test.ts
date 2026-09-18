/**
 * mcp-install 单元测试（#566 P3，pre-commit TDD 门禁）。
 *
 * 覆盖 studio mcp install <agent> 的三态幂等：
 * - install 写用户级配置（claude/kimi/opencode 各自路径与格式），只动 studio key
 * - --print 干跑不落盘；--uninstall 只删 studio key，既有字段无损
 * - Q3：默认探测 localhost:3001 /mcp/health，不通报错提示 --url；--url 跳过探测
 * - 安全：JSON 损坏拒写；写前备份 .bak；codex 不支持 SSE 报错（Q2 不架桥）
 *
 * 隔离：HOME 指向临时目录；fetch 全局 stub。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let logs: string[];
let errs: string[];

const { mcpInstall } = await import('../mcp-install.js');

function stubFetchOk() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
}
function stubFetchFail() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-install-'));
  prevHome = process.env.HOME;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.HOME = tmpHome;
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // 清理临时 HOME 内的产物
  for (const entry of fs.readdirSync(tmpHome)) {
    fs.rmSync(path.join(tmpHome, entry), { recursive: true, force: true });
  }
});

describe('参数与 agent 支持面', () => {
  it('无 agent → 用法行', async () => {
    await mcpInstall([]);
    expect(logs.join('\n')).toContain('studio mcp install <agent>');
  });

  it('未知 agent → 报错 + 用法行', async () => {
    await mcpInstall(['cursor']);
    expect(errs.join('\n')).toContain('未知 agent: cursor');
  });

  it('codex 不支持 SSE → 报错提示，不写任何文件（Q2 不架桥）', async () => {
    stubFetchOk();
    await mcpInstall(['codex']);
    expect(errs.join('\n')).toContain('codex 不支持 SSE transport');
    expect(fs.existsSync(path.join(tmpHome, '.codex'))).toBe(false);
  });
});

describe('install 写配置', () => {
  it('claude：探测 3001 通过 → 写 ~/.claude.json 的 mcpServers.studio（type:sse）', async () => {
    stubFetchOk();
    await mcpInstall(['claude']);
    const file = path.join(tmpHome, '.claude.json');
    const config = readJson(file);
    expect(config.mcpServers.studio).toEqual({
      type: 'sse',
      url: 'http://localhost:3001/api/v1/mcp/external/sse',
    });
    expect(fs.existsSync(`${file}.bak`)).toBe(false); // 首次写入无既有文件，无备份
  });

  it('kimi/opencode 各自的容器 key 与 entry 格式', async () => {
    stubFetchOk();
    await mcpInstall(['kimi']);
    expect(readJson(path.join(tmpHome, '.kimi-code', 'mcp.json')).mcpServers.studio)
      .toEqual({ transport: 'sse', url: 'http://localhost:3001/api/v1/mcp/external/sse' });

    await mcpInstall(['opencode']);
    expect(readJson(path.join(tmpHome, '.config', 'opencode', 'opencode.json')).mcp.studio)
      .toEqual({ type: 'remote', url: 'http://localhost:3001/api/v1/mcp/external/sse' });
  });

  it('幂等合并：既有字段与其他 mcpServers 无损，重复 install 不改动', async () => {
    stubFetchOk();
    const file = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { type: 'sse', url: 'http://localhost:9999/sse' } },
    }));

    await mcpInstall(['claude']);
    const config = readJson(file);
    expect(config.theme).toBe('dark');
    expect(config.mcpServers.other).toEqual({ type: 'sse', url: 'http://localhost:9999/sse' });
    expect(config.mcpServers.studio).toBeDefined();
    expect(readJson(`${file}.bak`).mcpServers.studio).toBeUndefined(); // 备份是写入前快照

    const afterFirst = fs.readFileSync(file, 'utf-8');
    await mcpInstall(['claude']);
    expect(logs[logs.length - 1]).toContain('已是目标配置，无需改动');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterFirst);
  });

  it('URL 变化时重复 install 更新条目（可重入）', async () => {
    stubFetchOk();
    await mcpInstall(['claude', '--url', 'http://localhost:13101/api/v1/mcp/external/sse']);
    await mcpInstall(['claude', '--url', 'http://localhost:3001/api/v1/mcp/external/sse']);
    expect(readJson(path.join(tmpHome, '.claude.json')).mcpServers.studio.url)
      .toBe('http://localhost:3001/api/v1/mcp/external/sse');
  });
});

describe('URL 来源（Q3）', () => {
  it('探测失败且无 --url → 报错提示 --url，不落盘', async () => {
    stubFetchFail();
    await mcpInstall(['claude']);
    expect(errs.join('\n')).toContain('--url');
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });

  it('--url 跳过探测直接用', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    await mcpInstall(['claude', '--url', 'http://localhost:7777/api/v1/mcp/external/sse']);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(readJson(path.join(tmpHome, '.claude.json')).mcpServers.studio.url)
      .toBe('http://localhost:7777/api/v1/mcp/external/sse');
  });
});

describe('--print / --uninstall', () => {
  it('--print 输出片段不落盘', async () => {
    stubFetchOk();
    await mcpInstall(['claude', '--print']);
    const out = logs.join('\n');
    expect(out).toContain('.claude.json');
    expect(out).toContain('"type": "sse"');
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });

  it('--uninstall 只删 studio key，既有字段无损；重复卸载幂等', async () => {
    stubFetchOk();
    await mcpInstall(['claude']);
    const file = path.join(tmpHome, '.claude.json');
    // 模拟用户后续加了别的 key
    const config = readJson(file);
    config.mcpServers.other = { command: 'x' };
    fs.writeFileSync(file, JSON.stringify(config));

    await mcpInstall(['claude', '--uninstall']);
    const after = readJson(file);
    expect(after.mcpServers.studio).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: 'x' });

    await mcpInstall(['claude', '--uninstall']);
    expect(logs[logs.length - 1]).toContain('未安装');
  });

  it('--uninstall 无配置文件 → 未安装提示', async () => {
    await mcpInstall(['kimi', '--uninstall']);
    expect(logs.join('\n')).toContain('未安装');
  });
});

describe('安全边界', () => {
  it('配置文件 JSON 损坏 → 拒写（install 与 uninstall 同）', async () => {
    stubFetchOk();
    const file = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(file, '{broken json');
    await mcpInstall(['claude']);
    expect(errs.join('\n')).toContain('解析失败');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{broken json');

    await mcpInstall(['claude', '--uninstall']);
    expect(errs.join('\n')).toContain('拒绝修改');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{broken json');
  });
});
