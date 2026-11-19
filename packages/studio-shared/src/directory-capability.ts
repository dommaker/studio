import fs from 'node:fs';
import path from 'node:path';

const DIR_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

/**
 * 在回调期间持有一个已校验目录的 fd。capabilityPath 只能在回调内使用；
 * 原路径随后被改名或替换为 symlink 也不会把后续 Git/文件操作改道。
 */
export async function withDirectoryCapability<T>(
  dir: string,
  callback: (capabilityPath: string) => Promise<T>,
): Promise<T> {
  const resolved = path.resolve(dir);
  const handle = await fs.promises.open(resolved, DIR_OPEN_FLAGS);
  const capabilityPath = `/proc/${process.pid}/fd/${handle.fd}`;
  try {
    if (await fs.promises.realpath(capabilityPath) !== resolved) {
      throw new Error(`Unsafe directory capability: real path differs from ${resolved}`);
    }
    return await callback(capabilityPath);
  } finally {
    await handle.close();
  }
}
