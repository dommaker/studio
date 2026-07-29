/**
 * 命令注册框架
 *
 * 统一的命令注册和执行
 */
// 命令注册表
const commands = new Map();
/**
 * 注册命令
 */
export function registerCommand(cmd) {
    commands.set(cmd.name, cmd);
}
/**
 * 获取命令
 */
export function getCommand(name) {
    return commands.get(name);
}
/**
 * 列出所有命令
 */
export function listCommands() {
    return Array.from(commands.values());
}
/**
 * 执行命令
 */
export async function runCommand(name, args, config) {
    const cmd = commands.get(name);
    if (!cmd) {
        throw new Error(`命令不存在: ${name}`);
    }
    const defaultConfig = {
        format: 'table',
        timeout: 10000,
    };
    await cmd.handler(args, config || defaultConfig);
}
/**
 * 清空命令注册表
 */
export function clearCommands() {
    commands.clear();
}
//# sourceMappingURL=command.js.map