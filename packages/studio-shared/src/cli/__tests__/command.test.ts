// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { registerCommand, getCommand, listCommands, runCommand, Command } from '../command';

/**
 * AC-004: 命令注册框架可用
 * 
 * 测试覆盖：
 * - 正常情况：注册、获取、执行命令
 * - 边界情况：空命令、同名命令覆盖
 * - 错误情况：命令不存在、执行失败
 */
describe('AC-004: 命令注册框架', () => {
  describe('正常情况', () => {
    test('AC-004-1: 注册命令', () => {
      const cmd: Command = {
        name: 'test',
        description: 'Test command',
        handler: async () => {},
      };
      registerCommand(cmd);
      expect(getCommand('test')).toBeDefined();
    });

    test('AC-004-2: 获取已注册命令', () => {
      const cmd: Command = {
        name: 'balance',
        description: 'Show balance',
        handler: async () => {},
      };
      registerCommand(cmd);
      const retrieved = getCommand('balance');
      expect(retrieved?.name).toBe('balance');
      expect(retrieved?.description).toBe('Show balance');
    });

    test('AC-004-3: 列出所有命令', () => {
      registerCommand({ name: 'cmd1', description: 'Command 1', handler: async () => {} });
      registerCommand({ name: 'cmd2', description: 'Command 2', handler: async () => {} });
      const commands = listCommands();
      expect(commands.length).toBeGreaterThanOrEqual(2);
      expect(commands.map(c => c.name)).toContain('cmd1');
      expect(commands.map(c => c.name)).toContain('cmd2');
    });

    test('AC-004-4: 执行命令', async () => {
      let executed = false;
      const cmd: Command = {
        name: 'exec-test',
        description: 'Test execution',
        handler: async () => { executed = true; },
      };
      registerCommand(cmd);
      await runCommand('exec-test', { command: 'exec-test', options: {}, positional: [] });
      expect(executed).toBe(true);
    });

    test('AC-004-5: 命令带选项', () => {
      const cmd: Command = {
        name: 'options-test',
        description: 'Test with options',
        options: [
          { name: 'company', short: 'c', description: 'Company ID', required: true },
          { name: 'format', short: 'f', description: 'Output format' },
        ],
        handler: async () => {},
      };
      registerCommand(cmd);
      const retrieved = getCommand('options-test');
      expect(retrieved?.options?.length).toBe(2);
    });
  });

  describe('边界情况', () => {
    test('AC-004-6: 同名命令覆盖', () => {
      registerCommand({ name: 'override', description: 'First', handler: async () => {} });
      registerCommand({ name: 'override', description: 'Second', handler: async () => {} });
      const cmd = getCommand('override');
      expect(cmd?.description).toBe('Second');
    });

    test('AC-004-7: 命令无 options', () => {
      const cmd: Command = {
        name: 'no-options',
        description: 'No options command',
        handler: async () => {},
      };
      registerCommand(cmd);
      const retrieved = getCommand('no-options');
      expect(retrieved?.options).toBeUndefined();
    });
  });

  describe('错误情况', () => {
    test('AC-004-8: 命令不存在返回 undefined', () => {
      const cmd = getCommand('nonexistent');
      expect(cmd).toBeUndefined();
    });

    test('AC-004-9: 执行不存在命令抛出错误', async () => {
      await expect(runCommand('nonexistent', { command: 'nonexistent', options: {}, positional: [] }))
        .rejects.toThrow();
    });

    test('AC-004-10: 命令执行失败抛出错误', async () => {
      const cmd: Command = {
        name: 'fail-test',
        description: 'Failing command',
        handler: async () => { throw new Error('Command failed'); },
      };
      registerCommand(cmd);
      await expect(runCommand('fail-test', { command: 'fail-test', options: {}, positional: [] }))
        .rejects.toThrow('Command failed');
    });
  });
});