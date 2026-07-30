/**
 * SystemExecutor - 系统级 LLM 调用执行器（AC-1.6 ~ AC-1.10）
 *
 * 封装系统任务的 spawn 逻辑：读 studio 角色 provider -> resolveProviderDefinition
 * -> buildArgsFromTemplate -> execSh -> 解析 JSON envelope.usage -> 写 system:tokens 事件。
 *
 * 不走 Executor/AgentTask/agentRunner（那是 AgentLoop 的重型抽象，含 sessionId/状态机）。
 * systemExecutor 是轻量 spawn（30s 超时/无状态），直接 execSh。
 *
 * 失败由调用方 catch（fire-and-forget 模式由调用方决定）。
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { FileStore, logger } from '@dommaker/studio-shared';
import { execSh, resolveProviderDefinition, buildArgsFromTemplate } from '@dommaker/studio-shared/node';
import { STUDIO_ROLE_NAME } from './agent-profile.service.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

export interface SystemExecutorOptions {
  /** 系统提示词（注入 CLI prompt 的 system 部分，通过 stdin prefix） */
  systemPrompt?: string;
  /** 执行目录（review 等 worktree 场景需要） */
  cwd?: string;
  /** CLI --allowedTools 参数（通过 env 传递） */
  allowedTools?: string;
  /** 超时（默认 30_000） */
  timeoutMs?: number;
  /** 输出缓冲（默认 5MB） */
  maxBuffer?: number;
}

export interface SystemExecutorResult {
  /** CLI stdout（纯文本或 JSON 字符串） */
  output: string;
  /** CLI --output-format json 返回的 usage；缺失时 undefined */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** 执行时长（ms） */
  durationMs: number;
}

export class StudioRoleNotConfiguredError extends Error {
  constructor() {
    super('studio role provider not configured; open UI to configure');
    this.name = 'StudioRoleNotConfiguredError';
  }
}

export class SystemExecutorJsonParseError extends Error {
  constructor(public readonly rawOutput: string, cause: unknown) {
    super(`systemExecutor JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SystemExecutorJsonParseError';
  }
}

const DEFAULT_EVENTS_FILE = resolveStudioLogFile('studio-events.jsonl');

export class SystemExecutor {
  constructor(
    private fileStore: FileStore,
    private eventsFile: string = DEFAULT_EVENTS_FILE,
  ) {}

  async run(prompt: string, options?: SystemExecutorOptions): Promise<SystemExecutorResult> {
    const opts = {
      timeoutMs: 30_000,
      maxBuffer: 5 * 1024 * 1024,
      ...options,
    };
    const startMs = Date.now();

    // 1. 读 studio 角色 provider
    const profiles = await this.fileStore.listProfiles();
    const studioProfile = profiles.find(p => p.name === STUDIO_ROLE_NAME);
    if (!studioProfile || !studioProfile.provider) {
      throw new StudioRoleNotConfiguredError();
    }
    const providerId = studioProfile.provider;

    // 2. 构造 CLI args
    const def = resolveProviderDefinition(providerId);
    // 先用 undefined prompt 调 buildArgsFromTemplate 拿 promptViaStdin，
    // 再决定 prompt 投递方式（避免 TDZ：解构同表达式内引用变量）
    const built = buildArgsFromTemplate(def, { outputFormat: 'json' });
    const { args, promptViaStdin } = built;

    // 3. 组装 shell 命令
    const bin = def.binaries[0];
    const cmd = `${bin} ${args.join(' ')}`;

    // 4. 执行（env 继承 process.env，CLI 自己读鉴权配置）
    const stdinContent = promptViaStdin
      ? (opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt)
      : undefined;
    const { stdout } = await execSh(cmd, {
      cwd: opts.cwd,
      stdin: stdinContent,
      env: {
        ...process.env,
        // root 下 claude root guard（getuid===0 && IS_SANDBOX!=="1"）exit 1 ——
        // 与 buildSessionEnv（runner-params.ts）同一修复：IS_SANDBOX=1 是 CLI 预留的
        // 沙箱声明，不放宽权限（settings 本就 bypassPermissions），只让 root guard 放行。
        // sdd-freshness post-commit 钩子走的正是这条轻量路径（不经 buildSessionEnv）。
        IS_SANDBOX: process.env.IS_SANDBOX ?? '1',
        ...(opts.allowedTools ? { CLAUDE_ALLOWED_TOOLS: opts.allowedTools } : {}),
      },
      timeoutMs: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
    });

    // 5. 解析 JSON envelope.usage
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const envelope = JSON.parse(stdout);
      if (envelope.usage) {
        usage = {
          inputTokens: envelope.usage.input_tokens ?? 0,
          outputTokens: envelope.usage.output_tokens ?? 0,
        };
      }
    } catch { /* 非 JSON 输出，usage 保持 undefined */ }

    const result: SystemExecutorResult = {
      output: stdout,
      usage,
      durationMs: Date.now() - startMs,
    };

    // 6. 写 system:tokens 事件（await + catch：失败只 log，不影响 run 结果）
    try {
      await this.writeSystemTokenEvent({
        provider: providerId,
        usage,
        durationMs: result.durationMs,
        promptSignature: hashPrompt(prompt),
      });
    } catch (err) {
      logger.warn('[SystemExecutor] writeSystemTokenEvent failed', { error: String(err) });
    }

    return result;
  }

  async runJson<T>(prompt: string, options?: SystemExecutorOptions): Promise<T> {
    const result = await this.run(prompt, options);
    try {
      return JSON.parse(result.output) as T;
    } catch (err) {
      throw new SystemExecutorJsonParseError(result.output, err);
    }
  }

  private async writeSystemTokenEvent(args: {
    provider: string;
    usage?: { inputTokens: number; outputTokens: number };
    durationMs: number;
    promptSignature: string;
  }): Promise<void> {
    const metricsFs = new FileStore();
    await metricsFs.appendJsonl(this.eventsFile, {
      type: 'system:tokens',
      source: 'system-executor',
      payload: JSON.stringify({
        provider: args.provider,
        inputTokens: args.usage?.inputTokens ?? null,
        outputTokens: args.usage?.outputTokens ?? null,
        durationMs: args.durationMs,
        promptSignature: args.promptSignature,
      }),
      createdAt: new Date().toISOString(),
    });
  }
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 8);
}

// 单例（懒初始化，首次调用时读 FileStore）
let _systemExecutor: SystemExecutor | null = null;
export function getSystemExecutor(): SystemExecutor {
  if (!_systemExecutor) _systemExecutor = new SystemExecutor(new FileStore());
  return _systemExecutor;
}

/** 测试用：重置单例 */
export function resetSystemExecutor(): void {
  _systemExecutor = null;
}
