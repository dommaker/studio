/**
 * @dommaker/studio-contract — API 契约唯一正本。
 *
 * 一份 zod schema 三用（docs/architecture/target-architecture.md）：
 * - 后端 core/http.ts defineRoute 做运行时校验
 * - 前后端 import type 拿静态类型
 * - OpenAPI 文档的生成源（派生物）
 *
 * 组织：envelope.ts 是响应壳；其余按域一个文件（workunit.ts、channel.ts…）。
 */

export * from './envelope.js';
export * from './workunit.js';
export * from './channels.js';
export * from './requirements.js';
export * from './pmo.js';
export * from './companies.js';
export * from './projects.js';
export * from './workspaces.js';
