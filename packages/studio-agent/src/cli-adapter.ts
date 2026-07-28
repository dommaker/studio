/**
 * CLI Adapter — translate common spawn params to provider-specific args
 *
 * Thin wrapper over the shared provider registry (@dommaker/studio-shared/node, F4).
 * Pure function: no file system side effects, no daemon-specific logic.
 *
 * Built-in providers: claude, kimi, codex, opencode (openclaw config-only).
 * Session strategies come from each provider's spawn template:
 *   claude   — --session-id <id>  (byte-identical to pre-F4 behavior; create-only semantics)
 *   kimi     — --session <id>     (resume semantics per registry comment)
 *   codex    — exec resume <id>   (subcommand, replaces base args)
 *   opencode — --session <id>     (continue semantics per --help)
 * maxTurns is only emitted for providers with a max-turns flag (claude --max-turns).
 *
 * Resume (sessionResume=true): sessionId points at an EXISTING session.
 *   claude   — --resume <id> replaces --session-id (2.1.80 实测：--session-id 撞已存在 id
 *              报 "Session ID ... is already in use"；--resume 按 id+ cwd 续用)
 *   kimi/codex/opencode — 模板 flag 本来就是续用语义，无需覆盖，走 registry 原路径。
 */

import { resolveProviderDefinition, buildArgsFromTemplate, type ProviderId } from '@dommaker/studio-shared/node';

export type Provider = ProviderId;

export interface SpawnParams {
  /** Working directory for the spawned process */
  worktreeDir: string;
  /** Session ID for persistent sessions */
  sessionId?: string;
  /**
   * true = sessionId 指向已存在会话（续用）；缺省/false = 新建语义。
   * 只对 sessionIdFlag 为 create-only 语义的 provider（claude）改变输出。
   */
  sessionResume?: boolean;
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
 * 续用时的 resume flag 覆盖 —— 仅 sessionIdFlag 为"仅新建"语义的 provider 需要：
 * claude --session-id 只能用于新会话，续用必须 --resume。
 * kimi/opencode --session、codex exec resume 均续用语义，不在此表（走模板）。
 */
const RESUME_FLAG_OVERRIDES: Record<string, string> = {
  claude: '--resume',
};

/**
 * Build spawn args for the given provider.
 *
 * @param provider - CLI provider name
 * @param params - Common spawn parameters
 * @returns command + args for the provider
 */
export function buildSpawnArgs(provider: Provider, params: SpawnParams): SpawnArgs {
  const def = resolveProviderDefinition(provider);
  const command = def.binaries[0] || provider;

  // 续用 + create-only provider：模板不传 sessionId（避免 --session-id 撞已存在 id），改拼 resume flag
  const resumeFlag = params.sessionId && params.sessionResume ? RESUME_FLAG_OVERRIDES[provider] : undefined;
  if (resumeFlag && params.sessionId) {
    const { args } = buildArgsFromTemplate(def, { maxTurns: params.maxTurns });
    args.push(resumeFlag, params.sessionId);
    return { command, args };
  }

  const { args } = buildArgsFromTemplate(def, {
    sessionId: params.sessionId,
    maxTurns: params.maxTurns,
  });
  return { command, args };
}
