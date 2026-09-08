/**
 * monitor 轮内异步子进程包装（#374）——monitor 轮禁止同步 execSync/execFileSync
 * （阻塞事件循环，SSE/HTTP 同进程受害），统一经此走回调式 exec/execFile 的 Promise 版。
 *
 * exec 走 shell（字符串命令，支持 `||` 兜底等 shell 语法）；
 * execFile 不经 shell（数组参数，git 等可信命令的防注入口径）。
 * 成功 resolve stdout 字符串；非零退出/超时 reject（err 为 exec 错误，含 stderr）。
 *
 * #411：monitor 轮子进程唯一出口在此加 exec 段计时上报（sink 关闭时原 promise 直返，
 * 零行为变化）。段名取到首个 flag 前的 token（'git worktree prune' /
 * 'npx tsx src/cli/studio-cli.ts update-user-model'），shell 语法尾巴与易变 flag 参数不进段名，报告按名分组。
 */

import { exec, execFile } from 'child_process';
import { runSegmentSpan } from '@dommaker/studio-shared/read-metrics';

/** exec 段名：取到首个 flag（`-` 开头 token）为止、上限 4 个 token。flag 参数（如
 *  `git log --since=<时间戳>` 的易变时间戳）不进段名，报告按命令身份稳定分组。 */
function execSpanName(full: string): string {
  const out: string[] = [];
  for (const token of full.trim().split(/\s+/)) {
    if (token.startsWith('-') || out.length >= 4) break;
    out.push(token);
  }
  return out.join(' ');
}

export const execAsync = (
  cmd: string,
  opts: { cwd?: string; timeout?: number } = {}
): Promise<string> =>
  runSegmentSpan('exec', execSpanName(cmd), () =>
    new Promise<string>((resolve, reject) => {
      exec(cmd, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    }),
  );

export const execFileAsync = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {}
): Promise<string> =>
  runSegmentSpan('exec', execSpanName([cmd, ...args].join(' ')), () =>
    new Promise<string>((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    }),
  );
