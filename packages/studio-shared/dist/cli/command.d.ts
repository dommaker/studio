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
/**
 * 注册命令
 */
export declare function registerCommand(cmd: Command): void;
/**
 * 获取命令
 */
export declare function getCommand(name: string): Command | undefined;
/**
 * 列出所有命令
 */
export declare function listCommands(): Command[];
/**
 * 执行命令
 */
export declare function runCommand(name: string, args: ParsedArgs, config?: StudioConfig): Promise<void>;
/**
 * 清空命令注册表
 */
export declare function clearCommands(): void;
//# sourceMappingURL=command.d.ts.map