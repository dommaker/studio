/**
 * CLI 命令契约（自 harness src/cli/command-contract.ts 迁入，ADR-0019）
 *
 * 供 update-user-model / analyze-sessions 两个会话挖掘命令使用：
 * - 返回值 `CommandResult`：判定结果（kind + reason），退出码由调用方（studio-cli.ts）映射。
 * - 写入面 `CommandIO`：流式输出去向，命令经注入的 io 打印，缺省 process 标准流。
 * - captureIO / lastJsonOutput：测试断言面。
 */

import { format } from 'util';

/**
 * 命令判定类别。
 * 对外退出码只有 0/1，语义放进 kind，码值映射收敛在 CLI 入口。
 */
export type CommandKind = 'ok' | 'skip' | 'fail' | 'usage-error';

/**
 * 命令实现返回值（判别联合）。
 * `fail` / `usage-error` 必附 `reason`，且 reason 要能唯一定位失败点；
 * `skip` 可选附原因。
 */
export type CommandResult =
  | { kind: 'ok' }
  | { kind: 'skip'; reason?: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'usage-error'; reason: string };

/**
 * 命令输出流注入面（最小可写接口，`process.stdout` / `process.stderr` 结构化满足）
 */
export interface CommandIO {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
}

/** 缺省 io：process 标准流（入口不注入时的现状行为） */
export const processIO: CommandIO = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/**
 * 与 console.log 同语义（util.format + 换行）写入 io.stdout
 */
export function log(io: CommandIO, ...args: unknown[]): void {
  io.stdout.write(format(...args) + '\n');
}

/**
 * 与 console.error 同语义（util.format + 换行）写入 io.stderr
 */
export function logError(io: CommandIO, ...args: unknown[]): void {
  io.stderr.write(format(...args) + '\n');
}

/**
 * 捕获型 io：测试注入面，替代对彩色字符串的断言。
 */
export interface CapturingIO extends CommandIO {
  /** 已写入 stdout 的全部文本 */
  outText(): string;
  /** 已写入 stderr 的全部文本 */
  errText(): string;
  /** stdout 按行切分（末尾换行不产生空尾行） */
  outLines(): string[];
  /** stderr 按行切分（末尾换行不产生空尾行） */
  errLines(): string[];
  /** stdout 每次写入的原始文本（一次 log 调用 = 一条记录） */
  outRecords(): string[];
  /** stderr 每次写入的原始文本 */
  errRecords(): string[];
}

export function captureIO(): CapturingIO {
  let out = '';
  let err = '';
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const split = (text: string): string[] =>
    text.endsWith('\n') ? text.slice(0, -1).split('\n') : (text === '' ? [] : text.split('\n'));
  return {
    stdout: { write: (chunk: string) => { out += chunk; outChunks.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { err += chunk; errChunks.push(chunk); return true; } },
    outText: () => out,
    errText: () => err,
    outLines: () => split(out),
    errLines: () => split(err),
    outRecords: () => [...outChunks],
    errRecords: () => [...errChunks],
  };
}

/**
 * 解析 --json 命令的捕获输出（测试断言面）
 *
 * 缺省返回 Record 形状；消费方已知字段形状时传泛型。
 */
export function lastJsonOutput<T = Record<string, unknown>>(capture: CapturingIO): T {
  return JSON.parse(capture.outText());
}
