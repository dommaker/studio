/**
 * Workspace Registration — HTTP registration flow
 *
 * POST /api/v1/workspaces/register with token in Authorization header.
 * Handles same-token re-registration (update, not duplicate).
 */

import type { WorkspaceConfig } from './workspace-config.js';

export interface RepoInfo {
  path: string;
  name: string;
  category?: string;
  description?: string;
  defaultBranch: string;
  remoteUrl?: string;
}

export interface RegistrationPayload {
  name: string;
  workspaceRoot: string;
  runtimes: Array<{ provider: string; version: string }>;
  hasDocker: boolean;
  os: string;
  arch: string;
  repos?: RepoInfo[];
}

export interface RegistrationResponse {
  success: boolean;
  workspaceId?: string;
  error?: string;
}

/**
 * Register workspace with Studio server.
 * Sends POST /api/v1/workspaces/register.
 *
 * @param config - Workspace configuration
 * @param detectedRuntimes - Runtime details with version info
 * @param repos - Discovered git repositories (optional)
 */
export async function registerWorkspace(
  config: WorkspaceConfig,
  detectedRuntimes: Array<{ provider: string; version: string }>,
  repos?: RepoInfo[],
): Promise<RegistrationResponse> {
  const url = `${config.serverUrl.replace(/\/$/, '')}/api/v1/workspaces/register`;

  const payload: RegistrationPayload = {
    name: config.name,
    workspaceRoot: config.workspaceRoot,
    runtimes: detectedRuntimes,
    hasDocker: config.hasDocker,
    os: config.os,
    arch: config.arch,
    ...(repos && repos.length > 0 ? { repos } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: `Registration failed (${response.status}): ${body.slice(0, 200)}`,
      };
    }

    const data = await response.json() as { workspaceId?: string; id?: string };
    return {
      success: true,
      workspaceId: data.workspaceId || data.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Registration request failed: ${message}`,
    };
  }
}
