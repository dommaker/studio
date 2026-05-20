/**
 * 命令注册框架
 * 
 * 统一的命令注册和执行
 */

import { ParsedArgs } from './parser';
import { StudioConfig } from './config';

export interface CommandOption {
  name: string;
  short?: string;
  description: string;
  required?: boolean;
  default?: any;
}

export interface Command {
  name: string;
  description: string;
  options?: CommandOption[];
  handler: (args: ParsedArgs, config?: StudioConfig) => Promise<void>;
}

// 命令注册表
const commands: Map<string, Command> = new Map();

/**
 * 注册命令
 */
export function registerCommand(cmd: Command): void {
  commands.set(cmd.name, cmd);
}

/**
 * 获取命令
 */
export function getCommand(name: string): Command | undefined {
  return commands.get(name);
}

/**
 * 列出所有命令
 */
export function listCommands(): Command[] {
  return Array.from(commands.values());
}

/**
 * 执行命令
 */
export async function runCommand(name: string, args: ParsedArgs, config?: StudioConfig): Promise<void> {
  const cmd = commands.get(name);

  if (!cmd) {
    throw new Error(`命令不存在: ${name}`);
  }

  const defaultConfig: StudioConfig = {
    format: 'table',
    timeout: 10000,
  };

  await cmd.handler(args, config || defaultConfig);
}

/**
 * 清空命令注册表
 */
export function clearCommands(): void {
  commands.clear();
}