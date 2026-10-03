/**
 * projects 域契约——正本字段以 apps/api/src/modules/projects/project-discovery.service.ts
 * （LocalProject）与 project.routes.ts 实际 wire 行为为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（原 `{ success: true, data }` 平铺壳退役；前端消费方
 *   原本就读 res.data.data，运行时解包不变）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

/**
 * 本地发现工程 wire 形状（= ProjectDiscoveryService LocalProject；扫描命中
 * CLAUDE.md/package.json/.git 标记，工程即叶子不递归内部）。手写 interface
 * （前端 CreateChannelForm/CreateProjectDialog/候选管理按必填消费 name/path/hasClaudeMd）；
 * parity 测试见 __tests__/projects.test.ts。
 */
export interface LocalProject {
  name: string;
  path: string;
  hasClaudeMd: boolean;
  language?: string;
}

export const localProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  hasClaudeMd: z.boolean(),
  language: z.string().optional(),
});

/** 归属候选排除清单形状（GET/PUT /exclude 的 data） */
export const projectExcludeSchema = z.object({
  exclude: z.array(z.string()),
});
export type ProjectExclude = z.infer<typeof projectExcludeSchema>;

// ── 请求 ──

/** GET /discover（search 子串过滤 name/path；缺省全量，60s 缓存 + PMO 绑定兜底排序） */
export const discoverProjectsQuerySchema = z.object({
  search: z.string().optional(),
});
export type DiscoverProjectsQuery = z.infer<typeof discoverProjectsQuerySchema>;

/** PUT /exclude 全量保存（handler 内 trim + 滤空白段后落盘，保存后主动 invalidateCache） */
export const putProjectExcludeBodySchema = z.object({
  exclude: z.array(z.string()),
});
export type PutProjectExcludeBody = z.infer<typeof putProjectExcludeBodySchema>;

// ── 响应 ──

/** GET /discover：`{ data: LocalProject[] }`（原 `{success,data}`） */
export const localProjectListResponseSchema = dataBodySchema(z.array(localProjectSchema));

/** GET/PUT /exclude：`{ data: ProjectExclude }`（原 `{success,data}`） */
export const projectExcludeResponseSchema = dataBodySchema(projectExcludeSchema);
