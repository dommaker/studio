import fs from 'node:fs';
import * as path from 'node:path';
import { withDirectoryCapability } from '@dommaker/studio-shared/node';

const DIR_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Agent 执行根统一策略：PMO 顶层/交付腿与 channel.defaultPath 共用。
 * 写入配置时同步校验词法路径、真实父目录与 repo 根 no-follow；
 * 实际执行另经同文件 withExecutionRepo 在 callback 期间持有 fd，配置/metadata 仍保存原路径。
 */
export function validateExecutionRepo(repo: string): string | null {
  const roots = (process.env.PMO_GIT_REPO_ROOTS || '/root/projects')
    .split(':').map(root => root.trim()).filter(Boolean);
  const resolved = path.resolve(repo);
  const invalid = `gitRepo must be an existing directory under an allowed root (${roots.join(':')}), got: ${repo}`;
  const resolvedRoots = roots.map(root => path.resolve(root));
  if (!resolvedRoots.some(root => isWithin(root, resolved))) return invalid;

  let parentFd: number | undefined;
  let repoFd: number | undefined;
  try {
    const realRoots = resolvedRoots.map(root => fs.realpathSync(root));
    parentFd = fs.openSync(path.dirname(resolved), DIR_OPEN_FLAGS);
    const realParent = fs.realpathSync(`/proc/${process.pid}/fd/${parentFd}`);
    if (!realRoots.some(root => isWithin(root, realParent))) return invalid;

    repoFd = fs.openSync(`/proc/${process.pid}/fd/${parentFd}/${path.basename(resolved)}`, DIR_OPEN_FLAGS);
    if (!fs.fstatSync(repoFd).isDirectory()) return invalid;
    const realRepo = fs.realpathSync(`/proc/${process.pid}/fd/${repoFd}`);
    if (!realRoots.some(root => isWithin(root, realRepo))) return invalid;
    return null;
  } catch {
    return invalid;
  } finally {
    if (repoFd !== undefined) fs.closeSync(repoFd);
    if (parentFd !== undefined) fs.closeSync(parentFd);
  }
}

/** 真实执行入口：callback 期间持有 repo fd，禁止把 capability 路径持久化到配置/metadata。 */
export async function withExecutionRepo<T>(
  repo: string,
  callback: (capabilityPath: string) => Promise<T>,
): Promise<T> {
  const roots = (process.env.PMO_GIT_REPO_ROOTS || '/root/projects')
    .split(':').map(root => root.trim()).filter(Boolean);
  const resolved = path.resolve(repo);
  const invalid = `gitRepo must be an existing directory under an allowed root (${roots.join(':')}), got: ${repo}`;
  const resolvedRoots = roots.map(root => path.resolve(root));
  if (!resolvedRoots.some(root => isWithin(root, resolved))) throw new Error(invalid);

  let validated = false;
  try {
    const realRoots = resolvedRoots.map(root => fs.realpathSync(root));
    const realParent = fs.realpathSync(path.dirname(resolved));
    if (!realRoots.some(root => isWithin(root, realParent))) throw new Error(invalid);
    return await withDirectoryCapability(resolved, async capabilityPath => {
      const realRepo = fs.realpathSync(capabilityPath);
      if (!realRoots.some(root => isWithin(root, realRepo))) throw new Error(invalid);
      validated = true;
      return callback(capabilityPath);
    });
  } catch (err) {
    if (validated || (err instanceof Error && err.message === invalid)) throw err;
    throw new Error(invalid);
  }
}
