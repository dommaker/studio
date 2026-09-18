/**
 * Capability Probe — spawn 前探测目标 CLI 支持的 flag 集合（#565 阶段 1）
 *
 * 对声明了 `capabilityProbe.helpArgs` 的 provider 跑 `<binary> <helpArgs>`，
 * 用正则从输出解析 `--flag` 集合。消费方（cli-adapter buildSpawnArgs）据此
 * 剔除模板中标记为 conditionalFlags 但目标 CLI 不认识的 flag。
 *
 * 语义（2026-09-16 人审决策）：
 * - 进程内缓存，key = binary path + version 串（version 变 = CLI 升级，自然重探）。
 *   不落盘——重探成本是每 provider 一次 --help，可忽略。
 * - daemon 启动随 cli-scanner 扫描 warm 一次；首次 spawn 缓存未命中则懒探测。
 * - 探测失败（help 跑不出来 / 输出解析为空）→ fail-open：返回 undefined，
 *   调用方保持现状全量传参 + warn 日志，不因探测故障改变现有行为。
 *   失败结果同样入缓存，同 key 不重复执行。
 *
 * Node-only module（execFileSync 同步风格，与 cli-scanner 一致）—
 * 经 '@dommaker/studio-shared/node' 导出。
 */

import { execFileSync } from 'node:child_process';
import { logger } from './utils/logger';
import { resolveProviderDefinition } from './providers';

/** 从 help 输出抓 flag 的正则（实测 codex/claude/kimi/opencode help 形态足够） */
const FLAG_RE = /--[a-z0-9][a-z0-9-]*/g;

/** 探测结果缓存：key = `${binaryPath}@${version}`；null = 探测失败（fail-open，同 key 不重试） */
const flagsCache = new Map<string, Set<string> | null>();

/** which/version 定位结果缓存：key = provider id；null = CLI 不存在 */
const binaryInfoCache = new Map<string, { path: string; version: string } | null>();

/** 从 help 文本解析去重后的 flag 集合（纯函数，供测试直接覆盖） */
export function parseHelpFlags(helpOutput: string): Set<string> {
  const flags = new Set<string>();
  for (const m of helpOutput.matchAll(FLAG_RE)) {
    flags.add(m[0]);
  }
  return flags;
}

function cacheKey(binaryPath: string, version: string): string {
  return `${binaryPath}@${version}`;
}

/** 执行 help 探测；失败（异常/非字符串输出/解析为空）返回 null */
function runProbe(binaryPath: string, helpArgs: string[]): Set<string> | null {
  try {
    const output = execFileSync(binaryPath, helpArgs, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    if (typeof output !== 'string') return null;
    const flags = parseHelpFlags(output);
    return flags.size > 0 ? flags : null;
  } catch {
    return null;
  }
}

/**
 * 启动扫描时 warm（cli-scanner 已算出 path + version，同批探测 best-effort）。
 * 同 key 已缓存（含失败）则跳过。
 */
export function warmCapabilityProbe(providerId: string, binaryPath: string, version: string): void {
  const def = resolveProviderDefinition(providerId);
  if (!def.capabilityProbe) return;
  const key = cacheKey(binaryPath, version);
  if (flagsCache.has(key)) return;
  const flags = runProbe(binaryPath, def.capabilityProbe.helpArgs);
  if (flags === null) {
    logger.warn('[CapabilityProbe] help 探测失败，fail-open 保持全量传参', { provider: providerId, binaryPath });
  }
  flagsCache.set(key, flags);
}

/**
 * 取 provider 的 supported flag 集合（spawn 前懒探测入口）。
 * 返回 undefined = 不探测/探测失败 → 调用方 fail-open 全量传参。
 */
export function getSupportedFlags(providerId: string): Set<string> | undefined {
  const def = resolveProviderDefinition(providerId);
  if (!def.capabilityProbe) return undefined;
  const binary = def.binaries[0];
  if (!binary) return undefined;

  if (!binaryInfoCache.has(providerId)) {
    let info: { path: string; version: string } | null = null;
    try {
      const binaryPath = execFileSync('which', [binary], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (binaryPath) {
        let version: string;
        try {
          version = execFileSync(binaryPath, def.versionArgs, {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5_000,
          }).trim();
        } catch {
          version = 'unknown';
        }
        info = { path: binaryPath, version };
      }
    } catch {
      info = null; // CLI 未安装——没有什么可过滤的，spawn 会自己报错
    }
    binaryInfoCache.set(providerId, info);
  }

  const info = binaryInfoCache.get(providerId);
  if (!info) return undefined;

  const key = cacheKey(info.path, info.version);
  if (!flagsCache.has(key)) {
    warmCapabilityProbe(providerId, info.path, info.version);
  }
  return flagsCache.get(key) ?? undefined;
}

/** Test hook: 清空探测缓存 */
export function resetCapabilityProbeCache(): void {
  flagsCache.clear();
  binaryInfoCache.clear();
}
