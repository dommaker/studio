import fs from 'node:fs';
import path from 'node:path';
import { execSh } from '@dommaker/studio-shared/node';

export const HOST_CHECK_TIMEOUT_MS = 600_000;
export const HOST_CHECK_MAX_BUFFER = 1024 * 1024;

const REGISTERED_COMMANDS = new Set([
  'pnpm run test',
  'pnpm run typecheck',
  'pnpm run lint',
  'npm run test',
  'npm run typecheck',
  'npm run lint',
]);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class HostExecutionPolicyError extends Error {}

/** 校验 WU 执行记录：词法路径与真实路径都必须绑定到当前 WU 的受控 worktree。 */
export function assertTrustedWuWorktree(wuId: string, candidate: string, worktreesDir: string): string {
  const expected = path.resolve(worktreesDir, `wu-${wuId}`);
  const actual = path.resolve(candidate);
  if (actual !== expected || !isWithin(path.resolve(worktreesDir), actual)) {
    throw new HostExecutionPolicyError(`WU ${wuId} 的 worktree 执行记录不受信`);
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(worktreesDir);
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new HostExecutionPolicyError(`WU ${wuId} 的 worktree 不存在或不可读取`);
  }
  if (realCandidate !== path.join(realRoot, `wu-${wuId}`) || !isWithin(realRoot, realCandidate)) {
    throw new HostExecutionPolicyError(`WU ${wuId} 的 worktree 真实路径越界或不匹配`);
  }
  return realCandidate;
}

/**
 * 将 Spec 文件检查解析到服务端项目根。存在的文件校验真实目标；不存在的文件
 * 校验最近已存在祖先，避免经中间符号链接越界。
 */
export function resolveHostPath(projectRoot: string, candidate: string): string {
  const realRoot = fs.realpathSync(projectRoot);
  const resolved = path.resolve(realRoot, candidate);
  if (!isWithin(realRoot, resolved)) throw new Error('检查路径必须位于服务端项目根内');

  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('检查路径没有已存在祖先');
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  if (!isWithin(realRoot, realExisting)) throw new Error('检查路径真实目标必须位于服务端项目根内');
  if (existing === resolved) return realExisting;
  return resolved;
}

/** 仅执行服务端登记的固定检查；命令、环境、超时与输出上限均不接受调用方覆盖。 */
export async function runHostCheck(command: string, cwd: string): Promise<void> {
  if (!REGISTERED_COMMANDS.has(command)) throw new Error(`未登记的宿主检查命令: ${command}`);
  await execSh(command, {
    cwd: fs.realpathSync(cwd),
    timeoutMs: HOST_CHECK_TIMEOUT_MS,
    maxBuffer: HOST_CHECK_MAX_BUFFER,
    killProcessGroup: true,
    inheritProcessEnv: false,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      CI: '1',
      NO_COLOR: '1',
    },
  });
}
