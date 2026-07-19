/**
 * dev.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 getAdminToken 的三条路径：
 * - 无 token 文件且无 ADMIN_PASSWORD → 警告并返回空串；
 * - token 文件存在 → 返回文件内容并写入模块级缓存（再次调用不读文件）；
 * - 有 ADMIN_PASSWORD 但 API 不可达 → 登录失败警告并返回空串
 *   （vi.resetModules 重置 _cachedAdminToken 后重新导入）。
 * HOME 指向临时目录隔离 ~/.studio。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let prevAdminPassword: string | undefined;
let dev: typeof import('../dev.js');
let errs: string[];

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-dev-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  prevAdminPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  dev = await import('../dev.js');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = prevAdminPassword;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  errs = [];
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tokenFile = () => path.join(tmpHome, '.studio', '.daemon', 'admin-token');

describe('getAdminToken', () => {
  it('无 token 文件且无 ADMIN_PASSWORD → 警告 + 空串', async () => {
    expect(await dev.getAdminToken('http://localhost:19121')).toBe('');
    expect(errs.join('\n')).toContain('Warning: ADMIN_PASSWORD not set, harness tests may fail auth');
  });

  it('token 文件存在 → 返回 trim 后内容', async () => {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), ' cached-tok\n');
    expect(await dev.getAdminToken('http://localhost:19121')).toBe('cached-tok');
  });

  it('命中模块级缓存后不再读文件', async () => {
    fs.rmSync(tokenFile());
    expect(await dev.getAdminToken('http://localhost:19121')).toBe('cached-tok');
  });

  it('有 ADMIN_PASSWORD 但 API 不可达 → 登录错误警告 + 空串', async () => {
    process.env.ADMIN_PASSWORD = 'pw';
    vi.resetModules(); // 重置 _cachedAdminToken
    const fresh = await import('../dev.js');
    try {
      expect(await fresh.getAdminToken('http://localhost:19121/api/v1')).toBe('');
      expect(errs.join('\n')).toContain('Warning: Admin login error:');
    } finally {
      delete process.env.ADMIN_PASSWORD;
    }
  });
});
