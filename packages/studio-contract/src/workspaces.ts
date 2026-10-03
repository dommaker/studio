/**
 * workspaces 域契约——正本字段以 apps/api/src/modules/workspaces/local-workspace.ts
 * （本机记录写入形状）与 workspace.routes.ts 实际 wire 行为为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（原 `{ success, data, total }` / 平铺 `{ runtimes }` /
 *   平铺错误壳 `{ error: string, code }` 退役；list/runtimes 的 total 不再下发——无消费方）
 * - Workspace 记录本身是 schemaless JSON（~/.studio/workspaces/*.json），schema 用
 *   passthrough 放行历史扩展字段（hasDocker/os/arch/tokenId/repos 等）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

/**
 * CLI runtime 条目。两种出口共用：工作区记录内嵌 runtimes（cli-scanner 探测持久，
 * 字段较全：id/name/path/status）与 GET /runtimes 本机清单投影（provider/version/
 * auth/authHint/models/modelsSource）。除 provider 外均可缺省（旧记录无新字段）。
 */
export const workspaceRuntimeSchema = z.object({
  id: z.string().optional(),
  provider: z.string(),
  name: z.string().optional(),
  version: z.string().nullable().optional(),
  path: z.string().optional(),
  status: z.string().optional(),
  /** 登录态三态（旧记录无字段 → unknown） */
  auth: z.string().optional(),
  /** auth=failed 时的修复提示 */
  authHint: z.string().optional(),
  /** 模型清单（扫描期探测；无字段的旧记录不渲染该行） */
  models: z.array(z.string()).optional(),
  /** live = CLI 实测探测；fallback = 注册表静态兜底 */
  modelsSource: z.enum(['live', 'fallback']).optional(),
}).passthrough();
export type WorkspaceRuntime = z.infer<typeof workspaceRuntimeSchema>;

/**
 * Workspace wire 形状（本机记录已知字段；passthrough 放行历史扩展）。
 * 手写 interface（前端 WorkspacePage 按必填消费 id/name/workspaceRoot/status）；
 * runtimes 旧记录可缺省（消费方 `?? []` 兜底）。parity 测试见 __tests__/workspaces.test.ts。
 */
export interface Workspace {
  id: string;
  name: string;
  workspaceRoot: string;
  status: string;
  runtimes?: WorkspaceRuntime[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceRoot: z.string(),
  status: z.string(),
  runtimes: z.array(workspaceRuntimeSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

/** GET /runtimes 本机 CLI 清单响应 data（原平铺 `{ runtimes }` 无壳） */
export const workspaceRuntimesResultSchema = z.object({
  runtimes: z.array(workspaceRuntimeSchema),
});
export type WorkspaceRuntimesResult = z.infer<typeof workspaceRuntimesResultSchema>;

/** DELETE /:id 响应 data */
export const deleteWorkspaceResultSchema = z.object({ deleted: z.boolean() });
export type DeleteWorkspaceResult = z.infer<typeof deleteWorkspaceResultSchema>;

// ── 请求 ──

export const workspaceIdParamsSchema = z.object({ id: z.string().min(1) });
export type WorkspaceIdParams = z.infer<typeof workspaceIdParamsSchema>;

// ── 响应 ──

/** GET /：`{ data: Workspace[] }`（原 `{success,data,total}`；total 退役） */
export const workspaceListResponseSchema = dataBodySchema(z.array(workspaceSchema));

/** GET /:id：`{ data: Workspace }`（原 `{success,data}`） */
export const workspaceResponseSchema = dataBodySchema(workspaceSchema);

/** GET /:id/runtimes：`{ data: WorkspaceRuntime[] }`（原 `{success,data,total}`；total 退役） */
export const workspaceRuntimeListResponseSchema = dataBodySchema(z.array(workspaceRuntimeSchema));

/** GET /runtimes：`{ data: WorkspaceRuntimesResult }`（原平铺 `{runtimes}`） */
export const workspaceRuntimesResponseSchema = dataBodySchema(workspaceRuntimesResultSchema);

/** DELETE /:id：`{ data: { deleted } }`（原 `{success,data}`） */
export const deleteWorkspaceResponseSchema = dataBodySchema(deleteWorkspaceResultSchema);
