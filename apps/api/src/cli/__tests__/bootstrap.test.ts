/**
 * bootstrap.ts 单元测试（#571：studio run web 与 studio up 共用的数据目录/密钥自举）。
 *
 * 行为契约（自 server.ts studioUp 内联逻辑提取，语义不变）：
 * - ensureDataDirs：创建 data/ .analyst/ .daemon/ knowledge/ worktrees/，幂等；
 * - ensureDaemonSecrets：env 已有值不动；.daemon 下有文件则读入 env；都没有则生成并落盘；
 *   重复调用幂等（第二次从文件 loaded，不重新生成）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureDataDirs, ensureDaemonSecrets, probeStorageWritable } from '../bootstrap.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bootstrap-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ensureDataDirs', () => {
  it('创建全部数据子目录', () => {
    ensureDataDirs(tmp);
    for (const d of ['data', '.analyst', '.daemon', 'knowledge', 'worktrees']) {
      expect(fs.statSync(path.join(tmp, d)).isDirectory()).toBe(true);
    }
  });

  it('幂等：重复调用不报错', () => {
    ensureDataDirs(tmp);
    expect(() => ensureDataDirs(tmp)).not.toThrow();
  });
});

describe('probeStorageWritable', () => {
  it('可写目录 → 不抛错，且不留探针文件', () => {
    expect(() => probeStorageWritable(tmp)).not.toThrow();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('不可写/不存在路径 → 抛错', () => {
    expect(() => probeStorageWritable(path.join(tmp, 'no/such/dir'))).toThrow();
  });
});

describe('ensureDaemonSecrets', () => {
  it('全新数据根 → 生成 JWT_SECRET 与 ENCRYPTION_KEY 并落盘 .daemon/', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = ensureDaemonSecrets(path.join(tmp, '.daemon'), env);
    expect(r).toEqual({ jwt: 'generated', encryption: 'generated' });
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(tmp, '.daemon', 'jwt-secret'), 'utf-8')).toBe(env.JWT_SECRET);
    expect(fs.readFileSync(path.join(tmp, '.daemon', 'encryption-key'), 'utf-8')).toBe(env.ENCRYPTION_KEY);
  });

  it('二次调用从文件 loaded，不重新生成（值不变）', () => {
    const env1: NodeJS.ProcessEnv = {};
    ensureDaemonSecrets(path.join(tmp, '.daemon'), env1);
    const env2: NodeJS.ProcessEnv = {};
    const r = ensureDaemonSecrets(path.join(tmp, '.daemon'), env2);
    expect(r).toEqual({ jwt: 'loaded', encryption: 'loaded' });
    expect(env2.JWT_SECRET).toBe(env1.JWT_SECRET);
    expect(env2.ENCRYPTION_KEY).toBe(env1.ENCRYPTION_KEY);
  });

  it('env 已显式配置 → 不动（env 优先于文件与生成）', () => {
    const env: NodeJS.ProcessEnv = { JWT_SECRET: 'preset-jwt', ENCRYPTION_KEY: 'preset-enc' };
    const r = ensureDaemonSecrets(path.join(tmp, '.daemon'), env);
    expect(r).toEqual({ jwt: 'env', encryption: 'env' });
    expect(env.JWT_SECRET).toBe('preset-jwt');
    expect(fs.existsSync(path.join(tmp, '.daemon', 'jwt-secret'))).toBe(false);
  });

  it('混合：env 有 JWT_SECRET、文件有 encryption-key → 各走各径', () => {
    const daemonDir = path.join(tmp, '.daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'encryption-key'), 'file-enc\n');
    const env: NodeJS.ProcessEnv = { JWT_SECRET: 'preset-jwt' };
    const r = ensureDaemonSecrets(daemonDir, env);
    expect(r).toEqual({ jwt: 'env', encryption: 'loaded' });
    expect(env.ENCRYPTION_KEY).toBe('file-enc');
  });
});
