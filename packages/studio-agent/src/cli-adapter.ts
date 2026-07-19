/**
 * CLI Adapter — translate common spawn params to provider-specific args
 *
 * Thin wrapper over the shared provider registry (@dommaker/studio-shared/node, F4).
 * Pure function: no file system side effects, no daemon-specific logic.
 *
 * Built-in providers: claude, kimi, codex, opencode (openclaw config-only).
 * Session strategies come from each provider's spawn template:
 *   claude   — --session-id <id>  (byte-identical to pre-F4 behavior)
 *   kimi     — --session <id>
 *   codex    — exec resume <id>   (subcommand, replaces base args)
 *   opencode — --session <id>
 * maxTurns is only emitted for providers with a max-turns flag (claude --max-turns).
 */

import { resolveProviderDefinition, buildArgsFromTemplate, type ProviderId } from '@dommaker/studio-shared/node';

export type Provider = ProviderId;

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
  const def = resolveProviderDefinition(provider);
  const { args } = buildArgsFromTemplate(def, {
    sessionId: params.sessionId,
    maxTurns: params.maxTurns,
  });
  return { command: def.binaries[0] || provider, args };
}
