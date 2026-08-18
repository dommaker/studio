/**
 * config.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 studio config 各子命令（HOME 指向临时目录隔离 ~/.studio/config.env）：
 * - path：输出配置文件路径；
 * - set：写入 config.env、脱敏输出（长值前后各 4 位，短值 ****）、非法参数 exit(1)；
 * - list：仅列固定 6 键，标注来源（env 优先于 config.env）；
 * - check：三键全缺时逐项 ✗ 并 exit(1)；
 * - 无子命令：输出 usage 块。
 * 相关环境变量在用例间保存/恢复，保证断言确定性。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { studioConfig } from '../config.js';

const MANAGED_KEYS = ['JWT_SECRET', 'ENCRYPTION_KEY', 'DISCORD_DAILY_CHANNEL'];

let tmpHome: string;
let prevHome: string | undefined;
let prevStudioHome: string | undefined;
let prevEnv: Record<string, string | undefined>;
let logs: string[];
let errs: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

const configPath = () => path.join(tmpHome, '.studio', 'config.env');

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-config-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // #219：studioPath() 的 STUDIO_HOME 优先于 $HOME，钉到本测试的临时 home。
  prevStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(tmpHome, '.studio');
  prevEnv = Object.fromEntries(MANAGED_KEYS.map(k => [k, process.env[k]]));
  for (const k of MANAGED_KEYS) delete process.env[k];
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevStudioHome;
  for (const k of MANAGED_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: any) => {
    throw new Error(`exit:${code}`);
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  // check 子命令会把 config 写回 process.env —— 每个用例后清掉，避免串扰
  for (const k of MANAGED_KEYS) delete process.env[k];
  fs.rmSync(configPath(), { force: true });
});

describe('studio config path', () => {
  it('输出配置文件路径', async () => {
    await studioConfig(['path']);
    expect(logs).toEqual([configPath()]);
  });
});

describe('studio config set', () => {
  it('写入文件并脱敏输出（长值）', async () => {
    await studioConfig(['set', 'JWT_SECRET=abcdef1234567890']);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe('JWT_SECRET=abcdef1234567890\n');
    const out = logs.join('\n');
    expect(out).toContain('Set JWT_SECRET = abcd...7890');
    expect(out).toContain(`Saved to ${configPath()}`);
    expect(out).toContain('Restart to apply: systemctl restart studio-api');
    expect(out).not.toContain('abcdef1234567890'); // 不脱敏泄漏完整值
  });

  it('短值（≤8）显示 ****', async () => {
    await studioConfig(['set', 'K=abc']);
    expect(logs.join('\n')).toContain('Set K = ****');
  });

  it('缺 = → usage + exit(1)', async () => {
    await expect(studioConfig(['set', 'NOEQ'])).rejects.toThrow('exit:1');
    expect(errs.join('\n')).toContain('Usage: studio config set KEY=VALUE');
  });
});

describe('studio config list', () => {
  it('仅列固定键并标注来源；env 优先于 config.env', async () => {
    await studioConfig(['set', 'JWT_SECRET=abcdef1234567890']);
    process.env.ENCRYPTION_KEY = 'envvalue123456';
    logs = [];
    await studioConfig(['list']);
    const out = logs.join('\n');
    expect(out).toContain(`Config: ${configPath()}`);
    expect(out).toContain('JWT_SECRET = abcd...7890  (config.env)');
    expect(out).toContain('ENCRYPTION_KEY = envv...3456  (env)');
    expect(out).not.toContain('STUDIO_API_KEY ='); // 未配置的键不显示
  });
});

describe('studio config check', () => {
  it('两键全缺 → 逐项 ✗ + exit(1)', async () => {
    await expect(studioConfig(['check'])).rejects.toThrow('exit:1');
    const out = logs.join('\n');
    expect(out).toContain('  ✗ JWT Secret: MISSING');
    expect(out).toContain('  ✗ Encryption Key: MISSING');
  });

  it('config.env 提供的键会被采纳 → ✓', async () => {
    await studioConfig(['set', 'JWT_SECRET=abcdef1234567890']);
    process.env.ENCRYPTION_KEY = 'y';
    logs = [];
    await expect(studioConfig(['check'])).rejects.toThrow('exit:0');
    const out = logs.join('\n');
    expect(out).toContain('  ✓ JWT Secret: configured');
    expect(out).toContain('  ✓ Encryption Key: configured');
  });
});

describe('studio config 默认', () => {
  it('无子命令 → usage 块', async () => {
    await studioConfig([]);
    const out = logs.join('\n');
    expect(out).toContain('Usage: studio config <command>');
    expect(out).toContain('list        View current configuration (masked)');
    expect(out).toContain('path        Show config file path');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
