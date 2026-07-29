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
import os from 'node:os';
import path from 'node:path';
/**
 * Built-in provider definitions.
 * claude args MUST stay byte-identical to the pre-F4 hardcoded adapter (regression risk).
 */
export const BUILTIN_PROVIDERS = {
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
            baseArgs: ['exec', '--json'],
            defaultOutputFormat: 'stream-json',
            resumeArgs: ['exec', 'resume', '{sessionId}', '--json'],
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
export const GENERIC_PROVIDER_DEFINITION = {
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
export function getDefaultProvidersConfigPath() {
    return path.join(os.homedir(), '.studio', 'providers.json');
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Deep merge: plain objects merge recursively, arrays/scalars are replaced. */
function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) {
        return (override === undefined ? base : override);
    }
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        result[key] = key in result ? deepMerge(result[key], value) : value;
    }
    return result;
}
const registryCache = new Map();
/**
 * Load the provider registry: built-ins deep-merged with ~/.studio/providers.json.
 * Accepts either `{ "providers": { ... } }` or a bare `{ "<id>": { ... } }` map.
 * Missing or malformed file is tolerated (built-ins only). Results are cached per path.
 */
export function loadProviderRegistry(configPath) {
    const p = configPath ?? getDefaultProvidersConfigPath();
    const cached = registryCache.get(p);
    if (cached)
        return cached;
    const registry = { ...BUILTIN_PROVIDERS };
    try {
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
            const overrides = (isPlainObject(raw) && isPlainObject(raw.providers) ? raw.providers : raw);
            if (isPlainObject(overrides)) {
                for (const [id, def] of Object.entries(overrides)) {
                    const base = registry[id] ?? { id };
                    registry[id] = deepMerge(base, def);
                    registry[id].id = id;
                }
            }
        }
    }
    catch {
        // Tolerate unreadable/malformed config — fall back to built-ins
    }
    registryCache.set(p, registry);
    return registry;
}
/** Test hook: drop cached registries so config-file changes are picked up. */
export function resetProviderRegistryCache() {
    registryCache.clear();
}
/** Look up a provider definition; undefined when the id is not in the registry. */
export function getProviderDefinition(id, configPath) {
    return loadProviderRegistry(configPath)[id];
}
/**
 * Resolve a provider definition, falling back to the generic template
 * (binary = the id itself) for ids not present in the registry.
 */
export function resolveProviderDefinition(id, configPath) {
    const def = getProviderDefinition(id, configPath);
    if (def)
        return def;
    return { ...GENERIC_PROVIDER_DEFINITION, id, displayName: id, binaries: [id] };
}
/** Provider ids included in the default CLI scan (scanDefault !== false). */
export function listScanProviders(configPath) {
    return Object.values(loadProviderRegistry(configPath))
        .filter(def => def.scanDefault !== false)
        .map(def => def.id);
}
/** Health probe command line for AgentLoop startup checks, e.g. `claude --version`. */
export function buildHealthProbeCommand(id, configPath) {
    const def = resolveProviderDefinition(id, configPath);
    return [def.binaries[0], ...def.healthProbeArgs].join(' ');
}
/**
 * Interpret a provider's spawn template for the given params.
 * Returns the argv and whether the prompt should be delivered via stdin.
 */
export function buildArgsFromTemplate(def, params) {
    const t = def.spawn;
    const format = params.outputFormat ?? t.defaultOutputFormat;
    const mappedFormat = t.outputFormatMap?.[format] ?? format;
    const substitute = (argv) => argv.map(a => a
        .split('{outputFormat}').join(mappedFormat)
        .split('{sessionId}').join(params.sessionId ?? ''));
    let args;
    if (params.sessionId && t.resumeArgs) {
        args = substitute(t.resumeArgs);
    }
    else {
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
        }
        else if (t.promptPositional || !t.promptViaStdin) {
            args.push(params.prompt);
            promptViaStdin = false;
        }
    }
    return { args, promptViaStdin };
}
//# sourceMappingURL=providers.js.map