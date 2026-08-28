/**
 * monitor 轮内异步子进程包装（#374）——monitor 轮禁止同步 execSync/execFileSync
 * （阻塞事件循环，SSE/HTTP 同进程受害），统一经此走回调式 exec/execFile 的 Promise 版。
 *
 * exec 走 shell（字符串命令，支持 `||` 兜底等 shell 语法）；
 * execFile 不经 shell（数组参数，git 等可信命令的防注入口径）。
 * 成功 resolve stdout 字符串；非零退出/超时 reject（err 为 exec 错误，含 stderr）。
 */

import { exec, execFile } from 'child_process';

export const execAsync = (
  cmd: string,
  opts: { cwd?: string; timeout?: number } = {}
): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

export const execFileAsync = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {}
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
