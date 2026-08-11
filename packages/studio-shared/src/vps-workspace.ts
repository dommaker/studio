/**
 * VPS Workspace 解析 — 'VPS' 命名约定 + ~/.studio/workspaces 读取的唯一属主
 *
 * 存储格式由 apps/api workspaces 模块写入（~/.studio/workspaces/{id}.json，
 * 见 workspace.routes.ts / local-workspace.ts），但"哪条记录是本机 VPS workspace"
 * 的判定（name === 'VPS' 且无 tokenId）只在本文件定义一次。消费方：
 *   - studio-agent worktree-resolver：resolveWorkspace Priority-2 回退（执行隔离边界）
 *   - apps/api local-workspace：启动时查找/复用本地 workspace
 * 重命名 VPS workspace 的行为变化收敛在本函数，不再有模块各自手扫 JSON。
 *
 * Node-only（fs/os）——仅从 '@dommaker/studio-shared/node' 导出，不进 web 入口。
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { FileStore } from './file-store.js';
import { studioPath } from './config/studio-dir';

/** workspace 记录中与本判定相关的字段（记录其余字段经索引签名原样保留） */
export interface VpsWorkspaceRecord {
  id: string;
  name?: string;
  workspaceRoot?: string;
  tokenId?: unknown;
  updatedAt?: string;
  [key: string]: unknown;
}

const fileStore = new FileStore();

/** workspaces 存储目录（~/.studio/workspaces） */
export function resolveWorkspacesDir(): string {
  return studioPath('workspaces');
}

/**
 * 查找本机 VPS workspace（name === 'VPS' 且未绑定 token）。
 * 多条匹配取 updatedAt 最新；目录不存在/记录损坏 → null，绝不抛错。
 *
 * @param opts.workspacesDir 测试注入点：覆盖默认 homedir 目录
 */
export async function resolveVpsWorkspace(opts?: { workspacesDir?: string }): Promise<VpsWorkspaceRecord | null> {
  const dir = opts?.workspacesDir ?? resolveWorkspacesDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let best: VpsWorkspaceRecord | null = null;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = await fileStore.readJson<VpsWorkspaceRecord>(path.join(dir, e.name));
      if (data && data.name === 'VPS' && !data.tokenId) {
        if (!best || mtime(data) > mtime(best)) best = data;
      }
    }
    return best;
  } catch { /* no workspace dir */ }
  return null;
}

/** updatedAt 时间戳；缺失/非法 → NaN（NaN 比较恒 false，与原手扫实现口径一致） */
function mtime(ws: VpsWorkspaceRecord): number {
  return new Date(ws.updatedAt as string).getTime();
}
