/**
 * Path Sandbox — AS-020 P6-02: Path traversal protection
 *
 * Ensures resolved paths never escape workspaceRoot.
 * Blocks ../../etc/passwd style traversal attacks.
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolve a relative path against workspaceRoot, blocking traversal.
 *
 * @param workspaceRoot - The root directory that must not be escaped
 * @param relativePath - User-provided relative path
 * @returns Resolved absolute path
 * @throws Error if path traversal is detected
 */
export function resolveSafePath(workspaceRoot: string, relativePath: string): string {
  // Normalize root (remove trailing slash)
  const root = path.resolve(workspaceRoot);

  // Empty or current dir → return root
  if (!relativePath || relativePath === '.' || relativePath === '/') {
    return root;
  }

  // Resolve the full path
  const resolved = path.resolve(root, relativePath);

  // Check resolved path starts with root
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Path traversal blocked');
  }

  // Also check with realpath to block symlink escapes
  try {
    const realResolved = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      throw new Error('Path traversal blocked (symlink escape)');
    }
  } catch (err: unknown) {
    // If path doesn't exist yet, that's OK — the resolved path check above is sufficient
    if (err instanceof Error && err.message.includes('Path traversal blocked')) {
      throw err;
    }
  }

  return resolved;
}
