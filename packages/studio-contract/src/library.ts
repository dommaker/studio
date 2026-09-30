/**
 * library 域契约——正本以 apps/api/src/modules/library/library.service.ts
 * （LibraryListItem/LibraryDocDetail）与 library.routes.ts 实测 wire 为准。
 *
 * 阅览室（#155 T5）：跨项目 .studio/ 文档面的聚合只读层，无写路径。
 *   GET /api/v1/library        聚合列表（?project= 收窄单项目，?search= 匹配 title/正文）
 *   GET /api/v1/library/*splat 文档详情；id = `${projectId}:${relPath}`
 *
 * 通配路由为 Express 5 写法 `GET /*splat`（path-to-regexp v8：通配必须命名）：
 * nginx proxy_pass 带 URI 会先解码 %2F→/ 再转发，id 以多段路径原形到达；
 * req.params.splat 是已解码的段数组，join('/') 还原多段 id——splat 段数组
 * 不进 zod params 校验（zod params 是对象形状），query 照常校验。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - `{ data: LibraryListItem[] }` / `{ data: LibraryDocDetail }`
 *   （原 `{ success: true, data }` 壳的 success 标志退役）
 * - 错误统一 `{ error: { code, message } }`（原 `{ success: false, error: string }`）：
 *   未命中 → 404 NOT_FOUND；服务异常 → 500 INTERNAL
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

export const libraryKindSchema = z.enum(['spec', 'research', 'adr', 'context', 'legacy']);
export type LibraryKind = z.infer<typeof libraryKindSchema>;

export const libraryListItemSchema = z.object({
  /** `${projectId}:${relPath}`（relPath 相对 .studio/；adr 相对仓根 docs/adr/；legacy 为 legacy-sdd/<slug>） */
  id: z.string(),
  title: z.string(),
  kind: libraryKindSchema,
  legacy: z.boolean(),
  /** PMO 项目真值 id */
  projectId: z.string(),
  pmoNumber: z.string(),
  /** relPath（相对 .studio/；adr 为 docs/adr/<name>.md 相对仓根） */
  path: z.string(),
  status: z.string().optional(),
  tags: z.array(z.string()).optional(),
  updatedAt: z.string(),
});

/** 手写 interface（前端 LibraryPage 按必填消费 id/title/kind/projectId/pmoNumber/
 * updatedAt；z.infer 在本仓退化全可选）；parity 测试见 __tests__ */
export interface LibraryListItem {
  id: string;
  title: string;
  kind: LibraryKind;
  legacy: boolean;
  projectId: string;
  pmoNumber: string;
  path: string;
  status?: string;
  tags?: string[];
  updatedAt: string;
}

export const libraryDocDetailSchema = libraryListItemSchema.extend({
  /** 普通文档 = 去 frontmatter 正文；legacy = requirement body */
  content: z.string(),
  /** legacy 三段 */
  requirement: z.string().nullable().optional(),
  design: z.string().nullable().optional(),
  task: z.string().nullable().optional(),
});

/** 手写 interface（前端 LibraryDocPage 按必填消费 content）；parity 测试见 __tests__ */
export interface LibraryDocDetail extends LibraryListItem {
  content: string;
  requirement?: string | null;
  design?: string | null;
  task?: string | null;
}

// ── 请求：query ──

/** GET /（project 收窄单项目；search 匹配 title/正文，大小写不敏感） */
export const listLibraryDocsQuerySchema = z.object({
  project: z.string().optional(),
  search: z.string().optional(),
});
export type ListLibraryDocsQuery = z.infer<typeof listLibraryDocsQuerySchema>;

// ── 响应 ──

export const libraryListResponseSchema = dataBodySchema(z.array(libraryListItemSchema));
export const libraryDocDetailResponseSchema = dataBodySchema(libraryDocDetailSchema);
