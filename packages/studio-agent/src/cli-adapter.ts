/**
 * CLI Adapter — translate common spawn params to provider-specific args
 *
 * Pure function: no file system side effects, no daemon-specific logic.
 *
 * Supports: claude, codex, opencode, openclaw
 * Each provider has different CLI flags for the same concepts.
 *
 * Provider Session Strategies:
 *   claude   — --session-id <id> (native CLI flag)
 *   codex    — --session <id>    (native CLI flag)
 *   openclaw — --session <id>    (native CLI flag)
 *   opencode — no session flag (session via file context injection)
 */

export type Provider = 'claude' | 'codex' | 'opencode' | 'openclaw';

export interface SpawnParams {
  /** Working directory for the spawned process */
  worktreeDir: string;
  /** Session ID for persistent sessions */
  sessionId?: string;
  /** Max turns for the agent */
  maxTurns?: number;
}

export interface SpawnArgs {
  /** Binary name / path */
  command: string;
  /** Arguments array */
  args: string[];
}

/**
 * Build spawn args for the given provider.
 *
 * @param provider - CLI provider name
 * @param params - Common spawn parameters
 * @returns command + args for the provider
 */
export function buildSpawnArgs(provider: Provider, params: SpawnParams): SpawnArgs {
  switch (provider) {
    case 'claude':
      return buildClaudeArgs(params);
    case 'codex':
      return buildCodexArgs(params);
    case 'openclaw':
      return buildOpenclawArgs(params);
    case 'opencode':
      return buildOpencodeArgs(params);
  }
}

const DEFAULT_ARGS: string[] = ['--print', '--output-format', 'stream-json'];

function buildClaudeArgs(params: SpawnParams): SpawnArgs {
  const args: string[] = [...DEFAULT_ARGS];
  if (params.sessionId) {
    args.push('--session-id', params.sessionId);
  }
  if (params.maxTurns) {
    args.push('--max-turns', String(params.maxTurns));
  }
  return { command: 'claude', args };
}

function buildCodexArgs(params: SpawnParams): SpawnArgs {
  const args: string[] = [...DEFAULT_ARGS];
  if (params.sessionId) {
    args.push('--session', params.sessionId);
  }
  return { command: 'codex', args };
}

function buildOpenclawArgs(params: SpawnParams): SpawnArgs {
  const args: string[] = [...DEFAULT_ARGS];
  if (params.sessionId) {
    args.push('--session', params.sessionId);
  }
  return { command: 'openclaw', args };
}

function buildOpencodeArgs(params: SpawnParams): SpawnArgs {
  const args: string[] = [...DEFAULT_ARGS];
  // opencode 无原生 session 支持，通过文件上下文注入
  // session context 由调用方通过 prompt 传入（agent-runner 在 executeLightweight 中注入 knowledgeContext）
  return { command: 'opencode', args };
}
