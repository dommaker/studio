/**
 * B3b-i（决策 D3 前半）WU 自动验证 —— 从 agent-loop 抽出的可复用实现（2026-07-30 F6-c 断链修复）。
 *
 * 消费方：
 *   - agent-loop COMPLETE 前验证守卫（原私有方法，行为一字不改）
 *   - agent-loop 步骤超限强制收口路径（F6-c 断点 1：收口前补跑 L1）
 *   - POST /api/v1/workunits/:id/verify 人工重跑 L1（F6-c 断点 2）
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSh } from '@dommaker/studio-shared/node';
import { getWorkspaceRecord } from '../../workspaces/workspace-store.js';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';

/** B3b-i: 代码类 WU（执行面强制专属 worktree 隔离） */
export const CODE_WORKTREE_TYPES = new Set(['task', 'bug', 'feature', 'refactor']);
/** B3b-i: 单条验证命令超时 10min；失败注入 prompt 的输出尾部上限 */
export const VERIFY_COMMAND_TIMEOUT_MS = 600_000;
export const VERIFY_FAIL_TAIL_CHARS = 2_000;

/** B3b-i: 从 execSh 拒绝错误提取输出尾部（stderr/stdout/message 拼接后截 maxChars） */
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

/** 一次 WU 验证的结果：ran = 已跑且通过的命令；failure = 首个失败命令 + 输出尾部 */
export interface WuVerifyOutcome {
  ran: string[];
  source: 'override' | 'convention';
  failure?: { command: string; tail: string };
}

/**
 * B3b-i（决策 D3 前半）: 解析 WU 的验证命令 —— 覆盖优先于约定。
 * 覆盖：metadata.verifyCommands > workspace 记录 verifyCommands（字符串数组）；
 * 约定：worktree package.json scripts 存在 test/typecheck/lint 则依次跑
 * （按 lockfile 选 pnpm/npm）；都没有 → 空数组（跳过验证，维持现状）。
 */
export async function resolveVerifyCommands(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  worktreePath: string,
): Promise<{ commands: string[]; source: 'override' | 'convention' }> {
  const asCommands = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && c.trim().length > 0) : [];

  const fromMeta = asCommands(metadata.verifyCommands);
  if (fromMeta.length > 0) return { commands: fromMeta, source: 'override' };

  if (wu.workspaceId) {
    try {
      const ws = await getWorkspaceRecord(wu.workspaceId);
      const fromWs = asCommands(ws?.verifyCommands);
      if (fromWs.length > 0) return { commands: fromWs, source: 'override' };
    } catch { /* 记录读取失败按无覆盖处理 */ }
  }

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

/**
 * B3b-i: 在 WU 的 worktree 里依次跑验证命令（单条 10min 超时）。
 * 任一失败 → 返回 failure（命令 + 输出尾部截 2000 字符）；全过 → ran 为全部命令。
 */
export async function runWuVerification(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  worktreePath: string,
): Promise<WuVerifyOutcome> {
  const { commands, source } = await resolveVerifyCommands(wu, metadata, worktreePath);
  const ran: string[] = [];
  for (const command of commands) {
    try {
      await execSh(command, { cwd: worktreePath, timeoutMs: VERIFY_COMMAND_TIMEOUT_MS });
      ran.push(command);
    } catch (err) {
      return { ran, source, failure: { command, tail: extractExecOutputTail(err, VERIFY_FAIL_TAIL_CHARS) } };
    }
  }
  return { ran, source };
}
