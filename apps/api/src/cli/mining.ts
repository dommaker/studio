// ── 会话挖掘域（studio#459，harness ADR-0019 迁入）──
// studio update-user-model（别名 uum）/ studio analyze-sessions（别名 analyze）
// 命令实现在 update-user-model.ts / analyze-sessions.ts，本文件只做 flag 解析与退出码映射。

import { updateUserModel } from './update-user-model.js';
import { analyzeSessions } from './analyze-sessions.js';
import type { CommandResult } from './command-contract.js';

/** 解析 --flag / --key value / --key=value / -d value 形式的参数 */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(a.startsWith('--') ? 2 : 1, eq)] = a.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
      out[a.slice(a.startsWith('--') ? 2 : 1)] = args[++i];
    } else {
      out[a.slice(a.startsWith('--') ? 2 : 1)] = true;
    }
  }
  return out;
}

function toInt(v: string | boolean | undefined): number | undefined {
  if (v === undefined || v === true || v === false) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** 退出码映射：fail/usage-error → 1（stderr 打 reason），ok/skip → 0 */
function applyResult(result: CommandResult): void {
  if (result.kind === 'fail' || result.kind === 'usage-error') {
    console.error(result.reason);
    process.exitCode = 1;
  }
}

export async function studioUpdateUserModel(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  applyResult(await updateUserModel({
    days: toInt(flags['days']),
    json: flags['json'] === true,
    dryRun: flags['dry-run'] === true,
  }));
}

export async function studioAnalyzeSessions(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  applyResult(await analyzeSessions({
    days: toInt(flags['days'] ?? flags['d']),
    json: flags['json'] === true,
  }));
}
