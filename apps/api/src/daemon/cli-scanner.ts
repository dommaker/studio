/**
 * CLI Scanner — auto-detect available agent CLIs on the system
 *
 * Scans the registry's default providers (F4): claude, kimi, codex, opencode
 * (openclaw is config-only now — re-add via ~/.studio/providers.json).
 * Uses `which` to find path, provider version command to get version string.
 */

import { execSync } from 'child_process';
import { listScanProviders, resolveProviderDefinition, type ProviderId } from '@dommaker/studio-shared/node';

/** Known agent CLI providers (from the provider registry, built-ins + user config) */
export const KNOWN_PROVIDERS: readonly string[] = listScanProviders();
export type ProviderName = ProviderId;

export interface DetectedRuntime {
  provider: ProviderName;
  path: string;
  version: string;
}

/**
 * Detect a single CLI provider.
 * Returns null if the binary is not found or fails to report version.
 */
export function detectProvider(name: ProviderName): DetectedRuntime | null {
  const def = resolveProviderDefinition(name);
  for (const binary of def.binaries) {
    try {
      const cliPath = execSync(`which ${binary}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (!cliPath) continue;

      let version = 'unknown';
      try {
        version = execSync(`${binary} ${def.versionArgs.join(' ')}`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5_000,
        }).trim();
      } catch {
        // version command may not be supported; try -v
        try {
          version = execSync(`${binary} -v`, {
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5_000,
          }).trim();
        } catch {
          version = 'unknown';
        }
      }

      return { provider: name, path: cliPath, version };
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
