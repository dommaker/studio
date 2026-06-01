/**
 * CLI Scanner — auto-detect available agent CLIs on the system
 *
 * Scans for: claude, codex, opencode, openclaw
 * Uses `which` to find path, `--version` to get version string.
 */

import { execSync } from 'child_process';

/** Known agent CLI providers */
export const KNOWN_PROVIDERS = ['claude', 'codex', 'opencode', 'openclaw'] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number];

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
  try {
    const cliPath = execSync(`which ${name}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!cliPath) return null;

    let version = 'unknown';
    try {
      version = execSync(`${name} --version`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5_000,
      }).trim();
    } catch {
      // --version may not be supported; try -v
      try {
        version = execSync(`${name} -v`, {
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
    return null;
  }
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
