/**
 * Workspace Store — F6: 共享的 workspace 记录读取
 *
 * 存储：~/.studio/workspaces/{id}.json（见 workspace.routes.ts）
 * F6 的频道绑定与 AgentLoop 执行 cwd 解析也需要同样的读取逻辑，
 * 抽出一个最小只读 helper 共用。
 */

import { FileStore } from '@dommaker/studio-shared';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const WORKSPACES_DIR = studioPath('workspaces');
const fileStore = new FileStore();

export interface WorkspaceRecord {
  id: string;
  name?: string;
  workspaceRoot?: string;
  [key: string]: unknown;
}

/** 按 id 读取 workspace 记录；不存在/损坏返回 null */
export async function getWorkspaceRecord(id: string): Promise<WorkspaceRecord | null> {
  return fileStore.readJson<WorkspaceRecord>(path.join(WORKSPACES_DIR, `${id}.json`));
}

/** 解析 workspace 的执行根目录（repo 路径）；记录缺失或无 workspaceRoot 返回 null */
export async function resolveWorkspaceRoot(workspaceId: string): Promise<string | null> {
  const ws = await getWorkspaceRecord(workspaceId);
  return typeof ws?.workspaceRoot === 'string' && ws.workspaceRoot.length > 0
    ? ws.workspaceRoot
    : null;
}
