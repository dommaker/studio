/**
 * Provider Registry — single source of truth for agent CLI providers (F4)
 *
 * Built-ins: claude, kimi, codex, opencode (openclaw kept as config-only legacy).
 * Users can override/extend definitions via `~/.studio/providers.json`
 * (deep-merged over built-ins; missing or malformed file is tolerated).
 *
 * Flag verification status (this machine, 2026-07):
 *   claude 2.1.80, kimi 0.27.0, codex-cli 0.144.4, opencode 1.18.3 — all verified
 *   against `<bin> --help` / official docs. openclaw flags are UNVERIFIED (not
 *   installed here); they follow the pre-F4 hardcoded adapter.
 *
 * Node-only module (reads fs) — exported via '@dommaker/studio-shared/node'.
 */

import fs from 'node:fs';
import { studioPath } from './config/studio-dir';

/** Built-in provider ids scanned by default */
export type BuiltinProviderId = 'claude' | 'kimi' | 'codex' | 'opencode';
/** Provider id: a built-in, 'openclaw' (legacy, config-only), or any user-defined id from providers.json */
export type ProviderId = BuiltinProviderId | 'openclaw' | (string & {});

/**
 * Spawn-args template for non-interactive task execution.
 * Placeholders substituted at build time: {outputFormat}, {sessionId}.
 */
export interface ProviderSpawnTemplate {
  /** Argv for one-shot non-interactive execution (print/output mode) */
  baseArgs: string[];
  /** Output format used when the caller does not specify one */
  defaultOutputFormat: string;
  /** Maps common format names to provider-specific values (e.g. opencode: stream-json → json) */
  outputFormatMap?: Record<string, string>;
  /** Full argv REPLACING baseArgs when sessionId is set (subcommand-style resume, e.g. codex) */
  resumeArgs?: string[];
  /** Flag appended with the session id value when sessionId is set (claude/kimi/opencode style) */
  sessionIdFlag?: string;
  /** Flag appended with the model value when model is set */
  modelFlag?: string;
  /** Flag appended with the max-turns value when maxTurns is set */
  maxTurnsFlag?: string;
  /** Flag for granting access to extra working directories */
  addDirFlag?: string;
  /** Flag appended with the output format — only when the caller explicitly sets outputFormat */
  outputFormatFlag?: string;
  /** true: prompt is delivered via stdin */
  promptViaStdin: boolean;
  /** Prompt delivered as this flag's value (e.g. kimi --prompt <prompt>) */
  promptFlag?: string;
  /** Prompt appended as positional argument (e.g. codex exec [PROMPT], opencode run [message..]) */
  promptPositional?: boolean;
}

export interface ProviderDefinition {
  /** Provider id (registry key) */
  id: string;
  /** Human-readable name */
  displayName: string;
  /** Binary names to probe with `which`, first hit wins */
  binaries: string[];
  /** Args for the version command used by cli-scanner (`<binary> <versionArgs>`) */
  versionArgs: string[];
  /** Args for the AgentLoop health probe (`<binary> <healthProbeArgs>`) */
  healthProbeArgs: string[];
  /** Include in the default `studio daemon start` scan list (default true) */
  scanDefault?: boolean;
  /** Non-interactive task execution template */
  spawn: ProviderSpawnTemplate;
  /** Extra env vars to set when spawning */
  env?: Record<string, string>;
  /** Free-form note (verification status, quirks) */
  notes?: string;
}

/** Parameters interpreted by buildArgsFromTemplate */
export interface ProviderSpawnParams {
  model?: string;
  outputFormat?: string;
  sessionId?: string;
  maxTurns?: number;
  prompt?: string;
  extraArgs?: string[];
}

/**
 * Built-in provider definitions.
 * claude args MUST stay byte-identical to the pre-F4 hardcoded adapter (regression risk).
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderDefinition> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaries: ['claude'],
    versionArgs: ['--version'],
    healthProbeArgs: ['--version'],
    spawn: {
      // Verified against claude 2.1.80. Model is selected via env (ANTHROPIC_MODEL), not a CLI flag.
      baseArgs: ['--print', '--output-format', '{outputFormat}', '--verbose'],
      defaultOutputFormat: 'stream-json',
      sessionIdFlag: '--session-id',
      maxTurnsFlag: '--max-turns',
      addDirFlag: '--add-dir',
      promptViaStdin: true,
    },
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi Code',
    binaries: ['kimi'],
    versionArgs: ['--version'],
    healthProbeArgs: ['--version'],
    spawn: {
      // Verified against kimi 0.27.0 --help + official docs: -p/--prompt is the only
      // non-interactive input (no stdin prompt mode); --session <id> resumes a session;
      // --output-format stream-json requires --prompt. No max-turns equivalent.
      baseArgs: ['--output-format', '{outputFormat}'],
      defaultOutputFormat: 'stream-json',
      sessionIdFlag: '--session',
      modelFlag: '--model',
      addDirFlag: '--add-dir',
      promptViaStdin: false,
      promptFlag: '--prompt',
    },
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    binaries: ['codex'],
    versionArgs: ['--version'],
    healthProbeArgs: ['--version'],
    spawn: {
      // Verified against codex-cli 0.144.4: `codex exec` runs non-interactively and reads
      // the prompt from stdin when no positional PROMPT is given; --json emits JSONL events.
      // Session continuation is the `exec resume <id>` subcommand, not a flag.
      // No max-turns equivalent.
      // #147（0.147.0 实测）：非 managed command hook 需先 review+trust 才运行，exec
      // 无人值守下未信任一律跳过 → project hooks.json 不生效；--dangerously-bypass-hook-trust
      // 面向"已自行审查 hook 来源的自动化"（studio 即此：propagateHarnessConfig 生成并校验）
      // 才在非交互下执行 hooks。0.147.0 本机实证：加 flag 后 SessionStart hook 运行。
      baseArgs: ['exec', '--json', '--dangerously-bypass-hook-trust'],
      defaultOutputFormat: 'stream-json',
      resumeArgs: ['exec', 'resume', '{sessionId}', '--json', '--dangerously-bypass-hook-trust'],
      modelFlag: '--model',
      addDirFlag: '--add-dir',
      promptViaStdin: true,
      promptPositional: true,
    },
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    binaries: ['opencode'],
    versionArgs: ['--version'],
    healthProbeArgs: ['--version'],
    spawn: {
      // Verified against opencode 1.18.3: `opencode run [message..]` runs non-interactively,
      // --format json emits raw JSON events, -s/--session <id> continues a session.
      // No max-turns / add-dir equivalent.
      baseArgs: ['run', '--format', '{outputFormat}'],
      defaultOutputFormat: 'json',
      outputFormatMap: { 'stream-json': 'json', json: 'json', text: 'default' },
      sessionIdFlag: '--session',
      modelFlag: '--model',
      promptViaStdin: false,
      promptPositional: true,
    },
  },
  openclaw: {
    id: 'openclaw',
    displayName: 'OpenClaw',
    binaries: ['openclaw'],
    versionArgs: ['--version'],
    healthProbeArgs: ['--version'],
    // F4: dropped from the default scan list — add back via ~/.studio/providers.json
    // ("openclaw": { "scanDefault": true })
    scanDefault: false,
    spawn: {
      // UNVERIFIED — openclaw is not installed on the dev machine; flags follow the
      // pre-F4 hardcoded adapter.
      baseArgs: [],
      defaultOutputFormat: 'stream-json',
      modelFlag: '--model',
      sessionIdFlag: '--session',
      maxTurnsFlag: '--max-turns',
      promptViaStdin: true,
    },
  },
};

/** Fallback for provider ids not present in the registry (binary = the id itself) */
export const GENERIC_PROVIDER_DEFINITION: ProviderDefinition = {
  id: 'generic',
  displayName: 'Generic CLI',
  binaries: [],
  versionArgs: ['--version'],
  healthProbeArgs: ['--version'],
  spawn: {
    baseArgs: [],
    defaultOutputFormat: 'stream-json',
    outputFormatFlag: '--output-format',
    modelFlag: '--model',
    sessionIdFlag: '--session-id',
    maxTurnsFlag: '--max-turns',
    promptViaStdin: true,
  },
};

/** Default user override file: ~/.studio/providers.json */
export function getDefaultProvidersConfigPath(): string {
  return studioPath('providers.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge: plain objects merge recursively, arrays/scalars are replaced. */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result as T;
}

const registryCache = new Map<string, Record<string, ProviderDefinition>>();

/**
 * Load the provider registry: built-ins deep-merged with ~/.studio/providers.json.
 * Accepts either `{ "providers": { ... } }` or a bare `{ "<id>": { ... } }` map.
 * Missing or malformed file is tolerated (built-ins only). Results are cached per path.
 */
export function loadProviderRegistry(configPath?: string): Record<string, ProviderDefinition> {
  const p = configPath ?? getDefaultProvidersConfigPath();
  const cached = registryCache.get(p);
  if (cached) return cached;

  const registry: Record<string, ProviderDefinition> = { ...BUILTIN_PROVIDERS };
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
      const overrides = (isPlainObject(raw) && isPlainObject(raw.providers) ? raw.providers : raw) as unknown;
      if (isPlainObject(overrides)) {
        for (const [id, def] of Object.entries(overrides)) {
          const base: ProviderDefinition = registry[id] ?? ({ id } as ProviderDefinition);
          registry[id] = deepMerge(base, def);
          registry[id].id = id;
        }
      }
    }
  } catch {
    // Tolerate unreadable/malformed config — fall back to built-ins
  }

  registryCache.set(p, registry);
  return registry;
}

/** Test hook: drop cached registries so config-file changes are picked up. */
export function resetProviderRegistryCache(): void {
  registryCache.clear();
}

/** Look up a provider definition; undefined when the id is not in the registry. */
export function getProviderDefinition(id: string, configPath?: string): ProviderDefinition | undefined {
  return loadProviderRegistry(configPath)[id];
}

/**
 * Resolve a provider definition, falling back to the generic template
 * (binary = the id itself) for ids not present in the registry.
 */
export function resolveProviderDefinition(id: string, configPath?: string): ProviderDefinition {
  const def = getProviderDefinition(id, configPath);
  if (def) return def;
  return { ...GENERIC_PROVIDER_DEFINITION, id, displayName: id, binaries: [id] };
}

/** Provider ids included in the default CLI scan (scanDefault !== false). */
export function listScanProviders(configPath?: string): string[] {
  return Object.values(loadProviderRegistry(configPath))
    .filter(def => def.scanDefault !== false)
    .map(def => def.id);
}

/** Health probe command line for AgentLoop startup checks, e.g. `claude --version`. */
export function buildHealthProbeCommand(id: string, configPath?: string): string {
  const def = resolveProviderDefinition(id, configPath);
  return [def.binaries[0], ...def.healthProbeArgs].join(' ');
}

/**
 * Interpret a provider's spawn template for the given params.
 * Returns the argv and whether the prompt should be delivered via stdin.
 */
export function buildArgsFromTemplate(
  def: ProviderDefinition,
  params: ProviderSpawnParams,
): { args: string[]; promptViaStdin: boolean } {
  const t = def.spawn;
  const format = params.outputFormat ?? t.defaultOutputFormat;
  const mappedFormat = t.outputFormatMap?.[format] ?? format;
  const substitute = (argv: string[]): string[] => argv.map(a => a
    .split('{outputFormat}').join(mappedFormat)
    .split('{sessionId}').join(params.sessionId ?? ''));

  let args: string[];
  if (params.sessionId && t.resumeArgs) {
    args = substitute(t.resumeArgs);
  } else {
    args = substitute(t.baseArgs);
    if (params.sessionId && t.sessionIdFlag) {
      args.push(t.sessionIdFlag, params.sessionId);
    }
  }
  if (params.outputFormat !== undefined && t.outputFormatFlag) {
    args.push(t.outputFormatFlag, mappedFormat);
  }
  if (params.model && t.modelFlag) {
    args.push(t.modelFlag, params.model);
  }
  if (params.maxTurns && t.maxTurnsFlag) {
    args.push(t.maxTurnsFlag, String(params.maxTurns));
  }
  if (params.extraArgs) {
    args.push(...params.extraArgs);
  }

  let promptViaStdin = t.promptViaStdin;
  if (params.prompt) {
    if (t.promptFlag) {
      args.push(t.promptFlag, params.prompt);
      promptViaStdin = false;
    } else if (t.promptPositional || !t.promptViaStdin) {
      args.push(params.prompt);
      promptViaStdin = false;
    }
  }

  return { args, promptViaStdin };
}
