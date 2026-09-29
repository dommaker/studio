/**
 * CLI Adapter — translate common spawn params to provider-specific args
 *
 * Thin wrapper over the shared provider registry (@dommaker/studio-shared/node, F4).
 * Pure function: no file system side effects, no daemon-specific logic.
 *
 * Built-in providers: claude, kimi, codex, opencode (openclaw config-only).
 * Session strategies come from each provider's spawn template:
 *   claude   — --session-id <id>  (byte-identical to pre-F4 behavior; create-only semantics)
 *   kimi     — --session <id>     (resume-only semantics, 0.29.0 实测未知 id 报 Session not found)
 *   codex    — exec resume <id>   (subcommand, replaces base args; resume semantics)
 *   opencode — --session <id>     (resume-only semantics, 1.18.4 实测未知 id 报 Session not found)
 * maxTurns is only emitted for providers with a max-turns flag (claude --max-turns).
 *
 * 新建：仅 claude 传 --session-id 建会话；kimi/codex/opencode 的 session 参数是续用
 * 语义，新建传未使用 id 会直接报错 → 一律丢弃（CLI 自建会话）。
 *
 * 续用 (sessionResume=true)：sessionId 是 CLI 真实会话号（#639 方向 D，档案
 * metadata.cliSessionId，由 extractCliSessionId 从本步流内解析落盘），按 id 形态
 * 点名接——不再走 cwd 维度「接最新」（kimi/opencode --continue、codex exec resume
 * --last 已于 #639 撤除：非代码 WU 共享 cwd 时交错执行静默接错别家会话，见 #637）：
 *   claude 2.1.80  — --resume <id>（既有实测：--session-id 撞已存在 id 报 already in use）
 *   kimi 0.29.0    — --session <id>（实测未知 id 报 Session not found → 走 #94 降级链）
 *   opencode 1.18.32 — --session <id>（#639 冒烟实测：按 id 续用成功，上下文连续）
 *   codex 0.154.0  — exec resume <id>（子命令经 resumeArgs 模板 {sessionId} 占位注入）
 * 编号失效（Session not found / No conversation found）→ #94 降级链换新会话 +
 * #95 前序进展段交接，无新机制。
 *
 * 会话池隔离口径（#637 探查实证，取代旧版「agent HOME 按 profile 隔离 / CODEX_HOME
 * 隔离」过时注释）：实测无 per-profile HOME——kimi/opencode/codex 的会话存储均为
 * 机器全局 × cwd 维度（codex rollout 文件 ~/.codex/sessions、opencode 会话库
 * ~/.local/share/opencode），这正是 cwd 维度续用会跨 WU 串扰的根因。
 */

import { resolveProviderDefinition, buildArgsFromTemplate, type ProviderId, type ProviderDefinition } from '@dommaker/studio-shared/node';

export type Provider = ProviderId;

export interface SpawnParams {
  /** Working directory for the spawned process */
  worktreeDir: string;
  /** Session ID for persistent sessions */
  sessionId?: string;
  /**
   * true = sessionId 指向已存在的 CLI 真实会话（续用）；缺省/false = 新建语义。
   * claude 换 --resume <id>；kimi/opencode 传 --session <id>、codex 走 exec resume <id>
   * —— 均为 id 形态点名续用（#639 方向 D，cwd 维度 --continue/--last 已撤除，见文件头）。
   */
  sessionResume?: boolean;
  /** Max turns for the agent */
  maxTurns?: number;
  /**
   * #565: 能力探测产出的 supported flag 集合（getSupportedFlags）。
   * 提供时剔除模板 conditionalFlags 中不在集合内的 flag；undefined = fail-open 全量传参。
   */
  supportedFlags?: Set<string>;
}

export interface SpawnArgs {
  /** Binary name / path */
  command: string;
  /** Arguments array */
  args: string[];
}

/**
 * session 参数为续用语义的 provider：新建时绝不能把 sessionId 传给 CLI
 * （kimi/opencode 实测对未使用 id 报 Session not found；codex 同为 resume 语义）。
 * 新建 = 不传 session flag，CLI 自建会话。
 */
const RESUME_ONLY_SESSION_PROVIDERS = new Set(['kimi', 'codex', 'opencode']);

/**
 * #565: 剔除 conditionalFlags 中目标 CLI 不支持的 flag（按 token 精确匹配，
 * 第一批只标布尔型 flag，无值需要连带剔除）。supportedFlags 缺省 = fail-open 不过滤。
 */
function filterConditionalArgs(
  def: ProviderDefinition,
  args: string[],
  supportedFlags: Set<string> | undefined,
): string[] {
  const conditional = def.spawn.conditionalFlags;
  if (!conditional?.length || !supportedFlags) return args;
  const drop = new Set(conditional.filter(f => !supportedFlags.has(f)));
  if (drop.size === 0) return args;
  return args.filter(a => !drop.has(a));
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
  const command = def.binaries[0] || provider;

  if (params.sessionId && params.sessionResume) {
    // claude：--resume <id>（baseArgs 保留 --print/--output-format 等，模板 sessionIdFlag
    // --session-id 是 create-only 语义，撞已存在 id 报 already in use → 不能走模板 id 形态）
    if (provider === 'claude') {
      const { args } = buildArgsFromTemplate(def, { maxTurns: params.maxTurns });
      args.push('--resume', params.sessionId);
      return { command, args: filterConditionalArgs(def, args, params.supportedFlags) };
    }
    // kimi/opencode/codex：模板原生 id 形态点名续用（kimi/opencode sessionIdFlag
    // --session <id>；codex resumeArgs exec resume {sessionId}）。sessionId 必须是
    // CLI 真实会话号（#639：调用方只在大档案有 cliSessionId 时才置 sessionResume）。
    const { args } = buildArgsFromTemplate(def, { sessionId: params.sessionId, maxTurns: params.maxTurns });
    return { command, args: filterConditionalArgs(def, args, params.supportedFlags) };
  }

  // 新建：resume-only provider 丢弃 sessionId（传了会报 Session not found）
  const sessionId = params.sessionId && !RESUME_ONLY_SESSION_PROVIDERS.has(provider)
    ? params.sessionId
    : undefined;
  const { args } = buildArgsFromTemplate(def, {
    sessionId,
    maxTurns: params.maxTurns,
  });
  return { command, args: filterConditionalArgs(def, args, params.supportedFlags) };
}
