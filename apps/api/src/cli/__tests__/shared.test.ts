/**
 * shared.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 验证 CLI 共享助手：
 * - extractConfigFlag：--config 旗标抽取（有值 / 无值 / 无旗标）；
 * - ensureDir：递归创建目录；
 * - getCompanyId / getToken：基于 ~/.studio 文件读取与降级路径。
 * HOME 指向临时目录隔离（os.homedir 在 POSIX 下读取 $HOME）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let prevStudioHome: string | undefined;
let shared: typeof import('../shared.js');

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cli-shared-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // #219：STUDIO_DIR 在 import 期冻结且 STUDIO_HOME 优先于 $HOME，
  // 须先把 STUDIO_HOME 钉到本测试的临时 home 再 import shared.js。
  prevStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(tmpHome, '.studio');
  shared = await import('../shared.js');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevStudioHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('extractConfigFlag', () => {
  it('无旗标时原样返回 args', () => {
    expect(shared.extractConfigFlag(['up', '--verbose'])).toEqual({ args: ['up', '--verbose'] });
  });

  it('抽取 --config 及其值，其余 args 保持不变', () => {
    expect(shared.extractConfigFlag(['up', '--config', '/tmp/x.env', 'extra'])).toEqual({
      configPath: '/tmp/x.env',
      args: ['up', 'extra'],
    });
  });

  it('--config 位于末尾（无值）时不抽取', () => {
    expect(shared.extractConfigFlag(['up', '--config'])).toEqual({ args: ['up', '--config'] });
  });
});

describe('ensureDir', () => {
  it('递归创建不存在的目录，重复调用幂等', () => {
    const dir = path.join(tmpHome, 'a', 'b', 'c');
    shared.ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    shared.ensureDir(dir); // 不抛错
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('getCompanyId', () => {
  it('无 active-project / company.json 时返回空串', () => {
    expect(shared.getCompanyId()).toBe('');
  });

  it('优先读取 active-project 文件内容', () => {
    fs.mkdirSync(path.join(tmpHome, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.studio', 'active-project'), '  proj-1  ');
    expect(shared.getCompanyId()).toBe('proj-1');
  });

  it('无 active-project 时降级 company.json 的 id 字段', () => {
    fs.rmSync(path.join(tmpHome, '.studio', 'active-project'));
    fs.writeFileSync(path.join(tmpHome, '.studio', 'company.json'), JSON.stringify({ id: 'comp-9' }));
    expect(shared.getCompanyId()).toBe('comp-9');
  });

  it('company.json 非法 JSON 时返回空串', () => {
    fs.writeFileSync(path.join(tmpHome, '.studio', 'company.json'), '{broken');
    expect(shared.getCompanyId()).toBe('');
  });
});

describe('getToken', () => {
  it('无 session-token 文件时返回空串', async () => {
    expect(await shared.getToken()).toBe('');
  });

  it('读取 .daemon/session-token 并 trim', async () => {
    const daemonDir = path.join(tmpHome, '.studio', '.daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'session-token'), ' tok-abc\n');
    expect(await shared.getToken()).toBe('tok-abc');
  });
});
