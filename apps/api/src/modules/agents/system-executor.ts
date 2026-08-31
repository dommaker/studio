/**
 * SystemExecutor - 系统级 LLM 调用执行器（AC-1.6 ~ AC-1.10）
 *
 * 封装系统任务的 spawn 逻辑：读 studio 角色 provider -> resolveProviderDefinition
 * -> buildArgsFromTemplate -> execSh -> 解析 JSON envelope.usage -> 写 system:tokens 事件。
 *
 * 不走 Executor/AgentTask/agentRunner（那是 AgentLoop 的重型抽象，含 sessionId/状态机）。
 * systemExecutor 是轻量 spawn（无状态），直接 execSh；超时按源解析（见 DEFAULT_TIMEOUT_BY_EVENT_SOURCE）。
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
import { getErrorMessage } from '../../utils/errors.js';

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
  /** system:tokens 事件的 source 标记（默认 'system-executor'；调用方传入可按任务聚合成本，如 'knowledge-maintenance'）。
   *  同时作为按源默认超时注册表（DEFAULT_TIMEOUT_BY_EVENT_SOURCE）的键。 */
  eventSource?: string;
}

/** 全局兜底超时：未打 eventSource 或不在注册表的调用点走此值 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 按 eventSource 的默认超时（#369）：已知重 prompt 源脱离全局默认，调用点不再逐个硬编码。
 * 显式传 timeoutMs 时优先于本表。实测依据（#365）：蒸馏 prompt 思考型模型 21-27s 撞 30s；
 * constraint-audit / knowledge-maintenance 同为全库批量重 prompt，同量级暴露，同口径放宽。
 */
export const DEFAULT_TIMEOUT_BY_EVENT_SOURCE: Readonly<Record<string, number>> = {
  'knowledge-distill': 120_000,
  'constraint-audit': 120_000,
  'knowledge-maintenance': 120_000,
};

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
    super(`systemExecutor JSON parse failed: ${getErrorMessage(cause)}`);
    this.name = 'SystemExecutorJsonParseError';
  }
}

const DEFAULT_EVENTS_FILE = resolveStudioLogFile('studio-events.jsonl');

/** system:tokens 事件 source 缺省值（#370）：事件 payload / 成功打点 / 失败 warn 三处共用 */
const DEFAULT_EVENT_SOURCE = 'system-executor';

export class SystemExecutor {
  constructor(
    private fileStore: FileStore,
    private eventsFile: string = DEFAULT_EVENTS_FILE,
  ) {}

  async run(prompt: string, options?: SystemExecutorOptions): Promise<SystemExecutorResult> {
    const opts = {
      maxBuffer: 5 * 1024 * 1024,
      ...options,
    };
    // 超时解析：显式 timeoutMs > 按源注册表 > 全局默认（#369）
    const effectiveTimeoutMs = opts.timeoutMs
      ?? DEFAULT_TIMEOUT_BY_EVENT_SOURCE[opts.eventSource ?? '']
      ?? DEFAULT_TIMEOUT_MS;
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
        IS_SANDBOX: process.env.IS_SANDBOX ?? '1',
        ...(opts.allowedTools ? { CLAUDE_ALLOWED_TOOLS: opts.allowedTools } : {}),
      },
      timeoutMs: effectiveTimeoutMs,
      maxBuffer: opts.maxBuffer,
    });

    // 5. 解析 JSON envelope.usage（claude --verbose 时为事件数组，归一到 result 事件，#364）
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    const envelope = SystemExecutor.extractResultEnvelope(stdout);
    const usageRaw = envelope?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usageRaw) {
      usage = {
        inputTokens: usageRaw.input_tokens ?? 0,
        outputTokens: usageRaw.output_tokens ?? 0,
      };
    }

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
        eventSource: opts.eventSource,
      });
    } catch (err) {
      logger.warn('[SystemExecutor] writeSystemTokenEvent failed', {
        error: String(err),
        eventSource: opts.eventSource ?? DEFAULT_EVENT_SOURCE,
      });
    }

    return result;
  }

  async runJson<T>(prompt: string, options?: SystemExecutorOptions): Promise<T> {
    const result = await this.run(prompt, options);
    try {
      const parsed: unknown = JSON.parse(result.output);
      // claude --output-format json --verbose：stdout 是 stream-json 事件数组，
      // 模型产出在末位 type=result 事件的 .result 字符串里（#364）
      if (Array.isArray(parsed)) {
        const envelope = SystemExecutor.extractResultEnvelope(result.output);
        if (typeof envelope?.result !== 'string') {
          throw new Error('no result event in stream-json array output');
        }
        return JSON.parse(envelope.result) as T;
      }
      // claude 无 --verbose / 其他 envelope 形态：{type:"result", result:"<json>"} 同样解包
      if (parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'result'
        && typeof (parsed as { result?: unknown }).result === 'string') {
        return JSON.parse((parsed as { result: string }).result) as T;
      }
      return parsed as T;
    } catch (err) {
      throw new SystemExecutorJsonParseError(result.output, err);
    }
  }

  /**
   * 归一 stdout 到 result envelope（#364）：
   * - stream-json 事件数组（claude --output-format json --verbose）→ 末位 type=result 事件；
   * - 单 envelope 对象 → 原样；非 JSON / 无 result 事件 → null。
   */
  private static extractResultEnvelope(stdout: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        for (let i = parsed.length - 1; i >= 0; i--) {
          const e = parsed[i];
          if (e && typeof e === 'object' && (e as { type?: unknown }).type === 'result') {
            return e as Record<string, unknown>;
          }
        }
        return null;
      }
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private async writeSystemTokenEvent(args: {
    provider: string;
    usage?: { inputTokens: number; outputTokens: number };
    durationMs: number;
    promptSignature: string;
    eventSource?: string;
  }): Promise<void> {
    const metricsFs = new FileStore();
    await metricsFs.appendJsonl(this.eventsFile, {
      type: 'system:tokens',
      source: args.eventSource ?? DEFAULT_EVENT_SOURCE,
      payload: JSON.stringify({
        provider: args.provider,
        inputTokens: args.usage?.inputTokens ?? null,
        outputTokens: args.usage?.outputTokens ?? null,
        durationMs: args.durationMs,
        promptSignature: args.promptSignature,
      }),
      createdAt: new Date().toISOString(),
    });
    // #370：成功打点——"跑了且写成了"有迹可查（失败路径有 warn，成功路径此前完全静默）
    logger.info('[SystemExecutor] system:tokens event written', {
      eventSource: args.eventSource ?? DEFAULT_EVENT_SOURCE,
      provider: args.provider,
      durationMs: args.durationMs,
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
