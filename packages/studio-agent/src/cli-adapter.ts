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
 * 续用 (sessionResume=true)：sessionId 指向已存在会话。但 Studio 持有的 sessionId 是
 * 自建 UUID，CLI 并不认识 —— kimi/opencode/codex 只能靠 CLI 自己的 cwd 维度会话记录
 * 续用（B3b-i 每 WU 独立 worktree = 独立 cwd，agent HOME 按 profile 隔离，cwd 维度
 * 恰好命中"同一 agent 在同一 WU 的上一次会话"）：
 *   claude 2.1.80  — --resume <id>（既有实测：--session-id 撞已存在 id 报 already in use）
 *   kimi 0.29.0    — --continue（实测：续用 cwd 上一会话成功；cwd 无前会话时优雅新开不报错）
 *   opencode 1.18.4 — --continue（实测：cwd 维度续用成功；异 cwd 不串会话、无前会话新开）
 *   codex 0.144.4  — exec resume --last（2026-07-28 运行实证，CODEX_HOME 隔离 +
 *                    volcengine-agent-plan responses wire：① stdin 投 prompt 无需 `-` 占位；
 *                    ② 同 cwd 命中最新会话、上下文连续（cached tokens + 暗号记忆）；
 *                    ③ 异 cwd 过滤生效不串会话，该 cwd 无前会话时优雅新开不报错（exit 0，
 *                    与 kimi/opencode --continue 同构）。
 *                    ⚠️ 本机默认 ~/.codex/config.toml（DeepSeek wire_api=chat）在 0.144.4
 *                    连配置加载都失败（启动即拒 "no longer supported"，-c 覆盖无法绕过），
 *                    跑 codex 需先把 provider 换成 wire_api=responses 的可用网关）
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
   * claude 换 --resume <id>；kimi/opencode/codex 忽略 id 改走 cwd 维度续用
   * （--continue / exec resume --last，见文件头实证记录）。
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
 * 续用时的 flag 覆盖（取代模板的 id 形态）：
 * claude 是 id 续用（--resume <id>，按 HOME+cwd 存储）；kimi/opencode 是 cwd 维度
 * 续用（--continue，不接 id）。codex 走子命令形态，不在此表（见 buildSpawnArgs）。
 */
const RESUME_FLAG_OVERRIDES: Record<string, string> = {
  claude: '--resume',
  kimi: '--continue',
  opencode: '--continue',
};

/**
 * session 参数为续用语义的 provider：新建时绝不能把 sessionId 传给 CLI
 * （kimi/opencode 实测对未使用 id 报 Session not found；codex 同为 resume 语义）。
 * 新建 = 不传 session flag，CLI 自建会话。
 */
const RESUME_ONLY_SESSION_PROVIDERS = new Set(['kimi', 'codex', 'opencode']);

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
    // codex：子命令形态 exec resume --last（cwd 过滤的最新会话）——'--last' 经 {sessionId}
    // 占位注入 resumeArgs 模板，保留模板对 model/add-dir 等 flag 的处理；Studio UUID 忽略。
    if (provider === 'codex') {
      const { args } = buildArgsFromTemplate(def, { sessionId: '--last', maxTurns: params.maxTurns });
      return { command, args };
    }
    const resumeFlag = RESUME_FLAG_OVERRIDES[provider];
    if (resumeFlag) {
      // claude 接 id；kimi/opencode 的 --continue 无值（cwd 维度续用）
      const { args } = buildArgsFromTemplate(def, { maxTurns: params.maxTurns });
      args.push(resumeFlag, ...(provider === 'claude' ? [params.sessionId] : []));
      return { command, args };
    }
    // 未覆盖的 provider（openclaw/generic）：回落模板 id 形态（未验证，保持旧行为）
  }

  // 新建：resume-only provider 丢弃 sessionId（传了会报 Session not found）
  const sessionId = params.sessionId && !RESUME_ONLY_SESSION_PROVIDERS.has(provider)
    ? params.sessionId
    : undefined;
  const { args } = buildArgsFromTemplate(def, {
    sessionId,
    maxTurns: params.maxTurns,
  });
  return { command, args };
}
