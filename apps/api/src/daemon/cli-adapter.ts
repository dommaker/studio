/**
 * CLI Adapter — translate common agent args to provider-specific spawn args
 *
 * Supports: claude, codex, opencode, openclaw
 * Each provider has different CLI flags for the same concepts.
 */

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
  const command = providerPath || provider;

  switch (provider) {
    case 'claude':
      return buildClaudeArgs(command, params);
    case 'codex':
      return buildCodexArgs(command, params);
    case 'opencode':
      return buildOpencodeArgs(command, params);
    case 'openclaw':
      return buildOpenclawArgs(command, params);
    default:
      return buildGenericArgs(command, params);
  }
}

function buildClaudeArgs(command: string, params: AgentCliParams): SpawnArgs {
  const args: string[] = ['--print', '--output-format', 'json'];

  if (params.sessionId) {
    args.push('--session-id', params.sessionId);
  }
  if (params.maxTurns) {
    args.push('--max-turns', String(params.maxTurns));
  }
  if (params.outputFormat === 'stream-json') {
    // --print already outputs JSON; stream-json enables streaming
    args.push('--verbose');
  }
  if (params.extraArgs) {
    args.push(...params.extraArgs);
  }

  return {
    command,
    args,
    promptViaStdin: true,
  };
}

function buildCodexArgs(command: string, params: AgentCliParams): SpawnArgs {
  const args: string[] = [];

  if (params.model) {
    args.push('--model', params.model);
  }
  if (params.outputFormat) {
    args.push('--format', params.outputFormat);
  }
  if (params.sessionId) {
    args.push('--session', params.sessionId);
  }
  if (params.maxTurns) {
    args.push('--max-steps', String(params.maxTurns));
  }
  if (params.extraArgs) {
    args.push(...params.extraArgs);
  }

  // Prompt via positional arg or stdin
  if (params.prompt) {
    args.push(params.prompt);
    return { command, args, promptViaStdin: false };
  }

  return { command, args, promptViaStdin: true };
}

function buildOpencodeArgs(command: string, params: AgentCliParams): SpawnArgs {
  const args: string[] = ['run'];

  if (params.model) {
    args.push('--model', params.model);
  }
  if (params.outputFormat) {
    args.push('--output', params.outputFormat);
  }
  if (params.maxTurns) {
    args.push('--max-turns', String(params.maxTurns));
  }
  if (params.extraArgs) {
    args.push(...params.extraArgs);
  }

  return { command, args, promptViaStdin: true };
}

function buildOpenclawArgs(command: string, params: AgentCliParams): SpawnArgs {
  const args: string[] = [];

  if (params.model) {
    args.push('--model', params.model);
  }
  if (params.sessionId) {
    args.push('--session', params.sessionId);
  }
  if (params.maxTurns) {
    args.push('--max-turns', String(params.maxTurns));
  }
  if (params.extraArgs) {
    args.push(...params.extraArgs);
  }

  return { command, args, promptViaStdin: true };
}

function buildGenericArgs(command: string, params: AgentCliParams): SpawnArgs {
  const args: string[] = [];

  if (params.model) {
    args.push('--model', params.model);
  }
  if (params.outputFormat) {
    args.push('--output-format', params.outputFormat);
  }
  if (params.sessionId) {
    args.push('--session-id', params.sessionId);
  }
  if (params.maxTurns) {
    args.push('--max-turns', String(params.maxTurns));
  }
  if (params.extraArgs) {
    args.push(...params.extraArgs);
  }

  return { command, args, promptViaStdin: true };
}
