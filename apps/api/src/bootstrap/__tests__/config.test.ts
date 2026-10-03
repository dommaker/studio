/**
 * bootstrap/config 测试（P2-a）：配置加载语义——
 * 无 STUDIO_CONFIG_DIR 时按 STUDIO_HOME 兜底注入 WORKTREES_DIR；
 * 有 STUDIO_CONFIG_DIR 时解析 .env 但不覆盖既有 env；PORT/HOST 解析可读取。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initConfig, getPort, getHost } from '../config.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.STUDIO_CONFIG_DIR;
  delete process.env.WORKTREES_DIR;
  delete process.env.PORT;
  delete process.env.HOST;
});

afterAll(() => {
  process.env = { ...savedEnv };
});

describe('initConfig', () => {
  it('无 STUDIO_CONFIG_DIR：按 STUDIO_HOME 兜底注入 WORKTREES_DIR', () => {
    initConfig();
    expect(process.env.WORKTREES_DIR).toBe(path.join(process.env.STUDIO_HOME!, 'worktrees'));
  });

  it('无 STUDIO_CONFIG_DIR：已有 WORKTREES_DIR 不覆盖', () => {
    process.env.WORKTREES_DIR = '/custom/worktrees';
    initConfig();
    expect(process.env.WORKTREES_DIR).toBe('/custom/worktrees');
  });

  it('有 STUDIO_CONFIG_DIR：解析 .env 注入缺省值，不覆盖既有 env', () => {
    const configDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'studio-cfg-'));
    fs.writeFileSync(
      path.join(configDir, '.env'),
      '# comment\nTEST_BOOTSTRAP_CFG=from_env_file\nPREEXISTING_CFG=from_file\nNO_EQUALS_LINE\n',
    );
    process.env.STUDIO_CONFIG_DIR = configDir;
    process.env.PREEXISTING_CFG = 'original';
    delete process.env.TEST_BOOTSTRAP_CFG;
    initConfig();
    expect(process.env.TEST_BOOTSTRAP_CFG).toBe('from_env_file');
    expect(process.env.PREEXISTING_CFG).toBe('original');
  });

  it('PORT/HOST 解析：env 优先，缺省 3001 / 127.0.0.1', () => {
    initConfig();
    expect(getPort()).toBe(3001);
    expect(getHost()).toBe('127.0.0.1');
    process.env.PORT = '4321';
    initConfig();
    expect(getPort()).toBe('4321');
  });

  it('STUDIO_AUTH=none 下绑定非回环地址 → 拒启（抛错）', () => {
    process.env.STUDIO_AUTH = 'none';
    process.env.HOST = '0.0.0.0';
    expect(() => initConfig()).toThrow(/禁止绑定非回环地址/);
  });
});
