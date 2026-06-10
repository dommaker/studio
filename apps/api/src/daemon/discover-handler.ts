/**
 * Discover Handler — AS-020 P6-03: Local directory scanning
 *
 * Scans workspaceRoot/path/ and returns immediate children.
 * Each entry has type (directory/git-repo) and lastModified.
 *
 * AS-023: handleDiscoverRecursive for nested repo discovery.
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

export interface RecursiveDiscoverEntry extends DiscoverEntry {
  /** Directory name (last path component) */
  name: string;
  /** Category (parent directory name, e.g. "backend") */
  category?: string;
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

/**
 * Recursively scan for git repositories up to maxDepth levels.
 *
 * Supports company structure: workspace/category/repo(.git)
 * Also supports flat structure: workspace/repo(.git)
 *
 * @param workspaceRoot - The workspace root directory
 * @param maxDepth - Maximum directory depth to scan (default 3)
 * @returns Array of git repo entries with category info
 */
export async function handleDiscoverRecursive(
  workspaceRoot: string,
  maxDepth: number = 3,
): Promise<RecursiveDiscoverEntry[]> {
  const results: RecursiveDiscoverEntry[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (!item.isDirectory()) continue;

      const fullPath = path.join(dir, item.name);

      // Check for .git (directory or file for submodules)
      const gitPath = path.join(fullPath, '.git');
      let isGitRepo = false;
      try {
        const gitStat = fs.statSync(gitPath);
        isGitRepo = gitStat.isDirectory() || gitStat.isFile();
      } catch {
        // No .git
      }

      if (isGitRepo) {
        const relativePath = path.relative(workspaceRoot, fullPath);
        const pathParts = relativePath.split(path.sep);
        const category = pathParts.length > 1 ? pathParts[0] : undefined;

        let lastModified: string;
        try {
          lastModified = fs.statSync(fullPath).mtime.toISOString();
        } catch {
          lastModified = new Date().toISOString();
        }

        results.push({
          path: relativePath,
          name: item.name,
          category,
          type: 'git-repo',
          lastModified,
        });
      } else {
        // Recurse into non-git directories
        scan(fullPath, depth + 1);
      }
    }
  }

  scan(workspaceRoot, 1);
  return results;
}
