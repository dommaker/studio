/**
 * Discover Handler — AS-020 P6-03: Local directory scanning
 *
 * Scans workspaceRoot/path/ and returns immediate children.
 * Each entry has type (directory/git-repo) and lastModified.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveSafePath } from './path-sandbox.js';

export interface DiscoverEntry {
  /** Relative path from workspaceRoot */
  path: string;
  /** Entry type */
  type: 'directory' | 'git-repo';
  /** Last modification time (ISO) */
  lastModified: string;
}

/**
 * Scan a directory and return its immediate children.
 *
 * @param workspaceRoot - The workspace root directory
 * @param relativePath - Subdirectory to scan (relative to root)
 * @returns Array of directory entries
 * @throws Error if path traversal is detected
 */
export async function handleDiscover(
  workspaceRoot: string,
  relativePath: string,
): Promise<DiscoverEntry[]> {
  const resolved = resolveSafePath(workspaceRoot, relativePath);

  // Check directory exists
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const entries: DiscoverEntry[] = [];
  const items = fs.readdirSync(resolved, { withFileTypes: true });

  for (const item of items) {
    if (!item.isDirectory()) continue;

    const fullPath = path.join(resolved, item.name);
    const relativeItem = path.relative(workspaceRoot, fullPath);

    // Detect git-repo: check for .git directory
    let type: 'directory' | 'git-repo' = 'directory';
    try {
      const gitPath = path.join(fullPath, '.git');
      const gitStat = fs.statSync(gitPath);
      if (gitStat.isDirectory()) {
        type = 'git-repo';
      }
    } catch {
      // No .git → stays 'directory'
    }

    // Get last modified time
    let lastModified: string;
    try {
      const stat = fs.statSync(fullPath);
      lastModified = stat.mtime.toISOString();
    } catch {
      lastModified = new Date().toISOString();
    }

    entries.push({
      path: relativeItem,
      type,
      lastModified,
    });
  }

  return entries;
}
