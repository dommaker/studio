import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Agent 执行根统一策略：PMO 顶层/交付腿与 channel.defaultPath 共用。
 * resolve 后必须位于 PMO_GIT_REPO_ROOTS 允许根内，且是已存在目录。
 */
export function validateExecutionRepo(repo: string): string | null {
  const roots = (process.env.PMO_GIT_REPO_ROOTS || '/root/projects')
    .split(':').map(root => root.trim()).filter(Boolean);
  const resolved = path.resolve(repo);
  const allowed = roots.some(root => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
  if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return `gitRepo must be an existing directory under an allowed root (${roots.join(':')}), got: ${repo}`;
  }
  return null;
}
