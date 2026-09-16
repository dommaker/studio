/**
 * CLI Scanner — auto-detect available agent CLIs on the system
 *
 * Scans the registry's default providers (F4): claude, kimi, codex, opencode
 * (openclaw is config-only now — re-add via ~/.studio/providers.json).
 * Uses `which` to find path, provider version command to get version string.
 */

import { execFileSync, execSync } from 'child_process';
import { listScanProviders, resolveProviderDefinition, warmCapabilityProbe, type ProviderId } from '@dommaker/studio-shared/node';

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

      return { provider: name, path: cliPath, version, ...authResult };
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
