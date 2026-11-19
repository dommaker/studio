/**
 * CLI Scanner — auto-detect available agent CLIs on the system
 *
 * Scans the registry's default providers (F4): claude, kimi, codex, opencode
 * (openclaw is config-only now — re-add via ~/.studio/providers.json).
 * Uses `which` to find path, provider version command to get version string.
 */

import { execFile, execFileSync, execSync } from 'child_process';
import { promisify } from 'node:util';
import { listScanProviders, resolveProviderDefinition, warmCapabilityProbe, warmCapabilityProbeAsync, getProviderModels, getProviderModelsAsync, type ProviderId } from '@dommaker/studio-shared/node';

/** execFile 的 promisify 形态（调用期才取值：wholesale mock child_process 的测试无 execFile 导出，模块加载期取值会炸） */
const execFileAsync = (file: string, args: string[], options: object): Promise<{ stdout: string; stderr: string }> =>
  (promisify(execFile) as unknown as (f: string, a: string[], o: object) => Promise<{ stdout: string; stderr: string }>)(file, args, options);

/** Known agent CLI providers (from the provider registry, built-ins + user config) */
export const KNOWN_PROVIDERS: readonly string[] = listScanProviders();
export type ProviderName = ProviderId;

export interface DetectedRuntime {
  provider: ProviderName;
  path: string;
  version: string;
  /**
   * #565: 登录态三态。未声明 authProbe / 探测自身出错（spawn 失败、超时）→ unknown，
   * 不根据配置目录/凭证文件存在性猜测。探测节奏 = 启动扫描 + 手动 rescan，
   * 结果随 runtimes 记录持久（见 authCheckedAt），不随每次 GET 重跑。
   */
  auth: 'ok' | 'failed' | 'unknown';
  /** auth=failed 时的修复提示（产品语言，来自注册表 authProbe.authHint） */
  authHint?: string;
  /** 本次 auth 探测时间（ISO） */
  authCheckedAt: string;
  /**
   * #574: 模型清单。live = listModels 探测实测；fallback = 注册表静态兜底
   * （探测失败/超时/未声明 listModels 时）。探测节奏同 auth：启动扫描 + 手动
   * rescan，随 runtimes 记录持久；进程内缓存 key=binary@version，重扫不重跑。
   */
  models?: string[];
  /** models 的来源标注（消费面区分实测/静态兜底） */
  modelsSource?: 'live' | 'fallback';
}

/**
 * #565: 登录态探测（注册表 authProbe 声明驱动）。
 * exit 0 且输出不命中已知未登录模式 → ok；命中模式或非零 exit → failed；
 * 未声明 / spawn 失败（进程根本没跑起来）→ unknown。
 */
function probeAuth(
  def: ReturnType<typeof resolveProviderDefinition>,
  binaryPath: string,
): Pick<DetectedRuntime, 'auth' | 'authHint' | 'authCheckedAt'> {
  const authCheckedAt = new Date().toISOString();
  const probe = def.authProbe;
  if (!probe) return { auth: 'unknown', authCheckedAt };

  const notLoggedIn = (output: string): boolean =>
    (probe.notLoggedInPatterns ?? []).some(p => new RegExp(p).test(output));

  try {
    // execFileSync 数组参数不经 shell（2026-08-25 安全收口）
    const output = execFileSync(binaryPath, probe.args, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: probe.timeoutMs ?? 10_000,
    });
    if (notLoggedIn(String(output))) {
      return { auth: 'failed', authHint: probe.authHint, authCheckedAt };
    }
    return { auth: 'ok', authCheckedAt };
  } catch (err) {
    // 进程跑了但非零退出（err.status 是数字）→ failed；spawn 失败/超时 → unknown
    const e = err as { status?: number };
    if (typeof e.status === 'number') {
      return { auth: 'failed', authHint: probe.authHint, authCheckedAt };
    }
    return { auth: 'unknown', authCheckedAt };
  }
}

/**
 * Detect a single CLI provider.
 * Returns null if the binary is not found or fails to report version.
 */
export function detectProvider(name: ProviderName): DetectedRuntime | null {
  const def = resolveProviderDefinition(name);
  for (const binary of def.binaries) {
    try {
      // execFileSync 数组参数不经 shell（2026-08-25 安全收口）
      const cliPath = execFileSync('which', [binary], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (!cliPath) continue;

      let version = 'unknown';
      try {
        version = execFileSync(binary, def.versionArgs, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5_000,
        }).trim();
      } catch {
        // version command may not be supported; try -v
        try {
          version = execFileSync(binary, ['-v'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5_000,
          }).trim();
        } catch {
          version = 'unknown';
        }
      }

      // #565: 声明了能力探测的 provider 随扫描 warm flag 缓存（best-effort；
      // 探测失败 fail-open，spawn 时行为与现状一致）
      if (def.capabilityProbe) {
        try {
          warmCapabilityProbe(name, cliPath, version);
        } catch { /* best-effort：不阻断扫描 */ }
      }

      const authResult = probeAuth(def, cliPath);

      // #574: 模型清单探测（进程内缓存 key=binary@version，重扫命中缓存不重跑；
      // 失败/未声明回退静态 fallbackModels，best-effort 不阻断扫描）
      let modelsResult: { models: string[]; source: 'live' | 'fallback' } | undefined;
      try {
        modelsResult = getProviderModels(name, cliPath, version);
      } catch { /* best-effort：不阻断扫描 */ }

      return {
        provider: name,
        path: cliPath,
        version,
        ...authResult,
        ...(modelsResult ? { models: modelsResult.models, modelsSource: modelsResult.source } : {}),
      };
    } catch {
      // binary not found — try the next candidate
    }
  }
  return null;
}

/**
 * Scan all known providers and return the detected ones.
 */
export function scanAllProviders(): DetectedRuntime[] {
  const results: DetectedRuntime[] = [];
  for (const name of KNOWN_PROVIDERS) {
    const detected = detectProvider(name);
    if (detected) results.push(detected);
  }
  return results;
}

// ── 异步扫描链（2026-10-03 冷启动修复）──
// sync 链（execFileSync）在启动期阻塞事件循环：workspaces 重扫 + default-provider
// backfill 两处全量扫描串行 ≈9s，拖住 bootstrap 的 listen。异步链语义逐条对齐 sync 版
// （三态 auth、capability/model 探测共享同一进程内缓存），provider 级并行。
// sync 版保留给一次性/低频路径：cli/server.ts checkPrerequisites、run-web、
// agent-profile.service 的 resolveDefaultProvider。

/** probeAuth 的异步形态：三态判定逐条对齐 sync 版 */
async function probeAuthAsync(
  def: ReturnType<typeof resolveProviderDefinition>,
  binaryPath: string,
): Promise<Pick<DetectedRuntime, 'auth' | 'authHint' | 'authCheckedAt'>> {
  const authCheckedAt = new Date().toISOString();
  const probe = def.authProbe;
  if (!probe) return { auth: 'unknown', authCheckedAt };

  const notLoggedIn = (output: string): boolean =>
    (probe.notLoggedInPatterns ?? []).some(p => new RegExp(p).test(output));

  try {
    const { stdout } = await execFileAsync(binaryPath, probe.args, {
      encoding: 'utf-8',
      timeout: probe.timeoutMs ?? 10_000,
    });
    if (notLoggedIn(String(stdout))) {
      return { auth: 'failed', authHint: probe.authHint, authCheckedAt };
    }
    return { auth: 'ok', authCheckedAt };
  } catch (err) {
    // 进程跑了但非零退出（err.code 是数字）→ failed；spawn 失败/超时 → unknown
    const e = err as { code?: number };
    if (typeof e.code === 'number') {
      return { auth: 'failed', authHint: probe.authHint, authCheckedAt };
    }
    return { auth: 'unknown', authCheckedAt };
  }
}

/**
 * detectProvider 的异步形态。与 sync 版唯一差异：execFile 回调化；
 * capability/model 探测走 *Async 变体，与 sync 版共享进程内缓存。
 */
export async function detectProviderAsync(name: ProviderName): Promise<DetectedRuntime | null> {
  const def = resolveProviderDefinition(name);
  for (const binary of def.binaries) {
    try {
      const { stdout: whichOut } = await execFileAsync('which', [binary], { encoding: 'utf-8' });
      const cliPath = whichOut.trim();
      if (!cliPath) continue;

      let version = 'unknown';
      try {
        const { stdout } = await execFileAsync(binary, def.versionArgs, {
          encoding: 'utf-8',
          timeout: 5_000,
        });
        version = stdout.trim();
      } catch {
        // version command may not be supported; try -v
        try {
          const { stdout } = await execFileAsync(binary, ['-v'], {
            encoding: 'utf-8',
            timeout: 5_000,
          });
          version = stdout.trim();
        } catch {
          version = 'unknown';
        }
      }

      // capability/model/auth 三个探测互不依赖，并行跑（共享缓存语义同 sync 链）
      const [, authResult, modelsResult] = await Promise.all([
        def.capabilityProbe
          ? warmCapabilityProbeAsync(name, cliPath, version).catch(() => { /* best-effort */ })
          : Promise.resolve(),
        probeAuthAsync(def, cliPath),
        (async () => {
          try {
            return await getProviderModelsAsync(name, cliPath, version);
          } catch { return undefined; /* best-effort：不阻断扫描 */ }
        })(),
      ]);

      return {
        provider: name,
        path: cliPath,
        version,
        ...authResult,
        ...(modelsResult ? { models: modelsResult.models, modelsSource: modelsResult.source } : {}),
      };
    } catch {
      // binary not found — try the next candidate
    }
  }
  return null;
}

/**
 * scanAllProviders 的异步形态：provider 级并行，不阻塞事件循环。
 * 返回顺序与 KNOWN_PROVIDERS 一致（Promise.all 保序），消费方语义不变。
 */
export async function scanAllProvidersAsync(): Promise<DetectedRuntime[]> {
  const detected = await Promise.all(KNOWN_PROVIDERS.map(name => detectProviderAsync(name)));
  return detected.filter((d): d is DetectedRuntime => d !== null);
}

/**
 * Check if Docker is available on the system.
 */
export function hasDocker(): boolean {
  try {
    execSync('docker --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
