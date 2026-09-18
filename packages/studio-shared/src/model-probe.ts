/**
 * Model Probe — provider 动态模型发现（#574）
 *
 * 对声明了 `listModels` 的 provider 跑 `<binary> <args>`，按声明的 parser 解析
 * 模型清单。探测失败/超时/解析为空 → 退回注册表静态 `fallbackModels`（source=fallback）；
 * 未声明 listModels 且无 fallbackModels → undefined（消费面不展示模型行）。
 *
 * 缓存语义（对齐 #565 capability-probe）：
 * - 进程内缓存，key = binary path + version 串（version 变 = CLI 升级，自然重探）。
 * - 探测失败同样入缓存（null），同 key 不重试。
 * - 探测节奏 = cli-scanner 扫描（启动 + 手动 rescan）时触发，结果随 runtimes 记录
 *   持久；GET 前的重扫命中本缓存，不每次请求真跑探测进程。
 *
 * 探测命令/解析器逐 provider 实测记录见 docs/plans/2026-09-provider-list-models.md
 * 与 providers.ts 各声明处注释（2026-09-16，codex 0.147.0 / kimi 0.38.0 / opencode 1.18.18）。
 *
 * Node-only module（execFileSync 同步风格，与 capability-probe 一致）—
 * 经 '@dommaker/studio-shared/node' 导出。
 */

import { execFileSync } from 'node:child_process';
import { logger } from './utils/logger';
import { resolveProviderDefinition, type ProviderDefinition } from './providers';

type ModelListParser = NonNullable<ProviderDefinition['listModels']>['parser'];

export interface ProviderModelsResult {
  models: string[];
  /** live = CLI 实测探测；fallback = 注册表静态兜底清单 */
  source: 'live' | 'fallback';
}

/** 探测结果缓存：key = `${binaryPath}@${version}`；null = 探测失败（同 key 不重试） */
const modelsCache = new Map<string, string[] | null>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** codex `debug models`：JSON，取 visibility==="list" 的 slug（无 visibility 字段的条目不收——实测全量带该字段） */
function parseJsonModelSlugs(parsed: unknown): string[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return [];
  return parsed.models
    .filter((m): m is Record<string, unknown> => isRecord(m))
    .filter(m => m.visibility === 'list' && typeof m.slug === 'string')
    .map(m => m.slug as string);
}

/** kimi `provider list --json`：JSON，models 对象的键即模型 alias */
function parseJsonModelKeys(parsed: unknown): string[] {
  if (!isRecord(parsed) || !isRecord(parsed.models)) return [];
  return Object.keys(parsed.models);
}

/** opencode `models`：每行一个 provider/model */
function parseLines(output: string): string[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * 从探测输出解析模型清单（纯函数，供测试直接覆盖）。
 * 任何解析失败（非法 JSON、结构不符、空输出）→ 空数组，由调用方按探测失败处理。
 */
export function parseModelList(output: string, parser: ModelListParser): string[] {
  if (parser === 'lines') return parseLines(output);
  try {
    const parsed: unknown = JSON.parse(output);
    return parser === 'jsonModelSlugs' ? parseJsonModelSlugs(parsed) : parseJsonModelKeys(parsed);
  } catch {
    return [];
  }
}

function cacheKey(binaryPath: string, version: string): string {
  return `${binaryPath}@${version}`;
}

/** 执行模型列表探测；失败（异常/非字符串输出/解析为空）返回 null */
function runProbe(binaryPath: string, probe: NonNullable<ProviderDefinition['listModels']>): string[] | null {
  try {
    const output = execFileSync(binaryPath, probe.args, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: probe.timeoutMs ?? 10_000,
    });
    if (typeof output !== 'string') return null;
    const models = parseModelList(output, probe.parser);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * 取 provider 的模型清单（扫描期调用；cli-scanner 已算出 path + version）。
 * - 声明了 listModels：进程内缓存命中直接用，未命中跑探测；成功 → live。
 * - 探测失败/未声明 → 静态 fallbackModels（source=fallback）。
 * - 两者皆无 → undefined。
 */
export function getProviderModels(
  providerId: string,
  binaryPath: string,
  version: string,
): ProviderModelsResult | undefined {
  const def = resolveProviderDefinition(providerId);

  if (def.listModels) {
    const key = cacheKey(binaryPath, version);
    if (!modelsCache.has(key)) {
      const models = runProbe(binaryPath, def.listModels);
      if (models === null) {
        logger.warn('[ModelProbe] 模型列表探测失败，退回静态 fallbackModels', { provider: providerId, binaryPath });
      }
      modelsCache.set(key, models);
    }
    const live = modelsCache.get(key);
    if (live) return { models: live, source: 'live' };
  }

  if (def.fallbackModels && def.fallbackModels.length > 0) {
    return { models: def.fallbackModels, source: 'fallback' };
  }
  return undefined;
}

/** Test hook: 清空探测缓存 */
export function resetModelProbeCache(): void {
  modelsCache.clear();
}
