/**
 * CLI Adapter — translate common agent args to provider-specific spawn args
 *
 * Provider definitions come from the shared provider registry (F4):
 * claude, kimi, codex, opencode built in (+ openclaw config-only),
 * user overrides via ~/.studio/providers.json.
 * claude args are byte-identical to the pre-F4 hardcoded adapter.
 */

import { resolveProviderDefinition, buildArgsFromTemplate } from '@dommaker/studio-shared/node';
import type { ProviderName } from './cli-scanner.js';

/** Common CLI parameters for agent execution */
export interface AgentCliParams {
  /** Model name or tier */
  model?: string;
  /** Output format: stream-json, json, text */
  outputFormat?: 'stream-json' | 'json' | 'text';
  /** Session ID for persistent sessions */
  sessionId?: string;
  /** Max turns for the agent */
  maxTurns?: number;
  /** Prompt text (passed via stdin or flag) */
  prompt?: string;
  /** Working directory */
  cwd?: string;
  /** Additional raw args */
  extraArgs?: string[];
}

/** Result of adapting CLI params for a provider */
export interface SpawnArgs {
  /** Binary name / path */
  command: string;
  /** Arguments array */
  args: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Whether prompt is passed via stdin */
  promptViaStdin: boolean;
}

/**
 * Build spawn args for the given provider.
 *
 * @param provider - CLI provider name
 * @param params - Common agent CLI parameters
 * @param providerPath - Optional explicit path to the binary
 */
export function buildSpawnArgs(
  provider: ProviderName,
  params: AgentCliParams,
  providerPath?: string,
): SpawnArgs {
  const def = resolveProviderDefinition(provider);
  const { args, promptViaStdin } = buildArgsFromTemplate(def, params);

  return {
    command: providerPath || def.binaries[0] || provider,
    args,
    env: def.env ? { ...def.env } : undefined,
    promptViaStdin,
  };
}
