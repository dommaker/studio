/**
 * 独立 WU 自动验证能力（ARCH-02 自 agent-loop 下沉）。
 * AgentLoop 与 WorkUnit 共用；只依赖 core 执行策略与 shared，不反向依赖业务模块。
 * SEC-01/04：仅服务端固定检查模板，普通验证先校验 WU worktree provenance，
 * 文件读取与命令执行全程持目录 capability。
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { withDirectoryCapability } from '@dommaker/studio-shared/node';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { assertTrustedWuWorktree, HOST_CHECK_TIMEOUT_MS, runHostCheck } from './host-execution-policy.js';

export interface VerificationWorkUnit {
  id: string;
}

export const CODE_WORKTREE_TYPES = new Set(['task', 'bug', 'feature', 'refactor']);
export const VERIFY_COMMAND_TIMEOUT_MS = HOST_CHECK_TIMEOUT_MS;
export const VERIFY_FAIL_TAIL_CHARS = 2_000;

export function extractExecOutputTail(err: unknown, maxChars: number): string {
  let text = '';
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    text = [rec.stderr, rec.stdout, rec.message]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
  } else {
    text = String(err);
  }
  return text.slice(-maxChars);
}

export interface WuVerifyOutcome {
  ran: string[];
  source: 'override' | 'convention';
  failure?: { command: string; tail: string };
}

/** 项目内容只能选择启用 test/typecheck/lint，不能提供命令文本或参数。 */
export async function resolveVerifyCommands(
  _wu: VerificationWorkUnit,
  _metadata: unknown,
  worktreePath: string,
): Promise<{ commands: string[]; source: 'override' | 'convention' }> {
  try {
    const pkgRaw = readFileSync(join(worktreePath, 'package.json'), 'utf-8');
    const scripts = (JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }).scripts ?? {};
    const names = ['test', 'typecheck', 'lint'].filter(n => typeof scripts[n] === 'string');
    if (names.length === 0) return { commands: [], source: 'convention' };
    const pm = existsSync(join(worktreePath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    return { commands: names.map(n => `${pm} run ${n}`), source: 'convention' };
  } catch {
    return { commands: [], source: 'convention' };
  }
}

function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || studioPath('worktrees');
}

export async function runWuVerification(
  wu: VerificationWorkUnit,
  metadata: unknown,
  worktreePath: string,
  options?: { cwdProvenance: 'merge-target' },
): Promise<WuVerifyOutcome> {
  const trustedCwd = options?.cwdProvenance === 'merge-target'
    ? worktreePath
    : assertTrustedWuWorktree(wu.id, worktreePath, resolveWorktreesDir());
  const verify = async (capabilityCwd: string): Promise<WuVerifyOutcome> => {
    const { commands, source } = await resolveVerifyCommands(wu, metadata, capabilityCwd);
    const ran: string[] = [];
    for (const command of commands) {
      try {
        await runHostCheck(command, capabilityCwd);
        ran.push(command);
      } catch (err) {
        return { ran, source, failure: { command, tail: extractExecOutputTail(err, VERIFY_FAIL_TAIL_CHARS) } };
      }
    }
    return { ran, source };
  };
  // 合并流程已持有 capability 时直接复用，不能嵌套 realpath/open。
  if (new RegExp(`^/proc/${process.pid}/fd/\\d+$`).test(trustedCwd)) return verify(trustedCwd);
  return withDirectoryCapability(trustedCwd, verify);
}
