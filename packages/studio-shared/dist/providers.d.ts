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
export declare const BUILTIN_PROVIDERS: Record<string, ProviderDefinition>;
/** Fallback for provider ids not present in the registry (binary = the id itself) */
export declare const GENERIC_PROVIDER_DEFINITION: ProviderDefinition;
/** Default user override file: ~/.studio/providers.json */
export declare function getDefaultProvidersConfigPath(): string;
/**
 * Load the provider registry: built-ins deep-merged with ~/.studio/providers.json.
 * Accepts either `{ "providers": { ... } }` or a bare `{ "<id>": { ... } }` map.
 * Missing or malformed file is tolerated (built-ins only). Results are cached per path.
 */
export declare function loadProviderRegistry(configPath?: string): Record<string, ProviderDefinition>;
/** Test hook: drop cached registries so config-file changes are picked up. */
export declare function resetProviderRegistryCache(): void;
/** Look up a provider definition; undefined when the id is not in the registry. */
export declare function getProviderDefinition(id: string, configPath?: string): ProviderDefinition | undefined;
/**
 * Resolve a provider definition, falling back to the generic template
 * (binary = the id itself) for ids not present in the registry.
 */
export declare function resolveProviderDefinition(id: string, configPath?: string): ProviderDefinition;
/** Provider ids included in the default CLI scan (scanDefault !== false). */
export declare function listScanProviders(configPath?: string): string[];
/** Health probe command line for AgentLoop startup checks, e.g. `claude --version`. */
export declare function buildHealthProbeCommand(id: string, configPath?: string): string;
/**
 * Interpret a provider's spawn template for the given params.
 * Returns the argv and whether the prompt should be delivered via stdin.
 */
export declare function buildArgsFromTemplate(def: ProviderDefinition, params: ProviderSpawnParams): {
    args: string[];
    promptViaStdin: boolean;
};
//# sourceMappingURL=providers.d.ts.map