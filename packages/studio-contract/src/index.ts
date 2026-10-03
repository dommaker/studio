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
export * from './openapi.js';
export * from './workunit.js';
export * from './channels.js';
export * from './requirements.js';
export * from './pmo.js';
export * from './companies.js';
export * from './projects.js';
export * from './workspaces.js';
export * from './skills.js';
export * from './specs.js';
export * from './triggers.js';
export * from './evolution.js';
export * from './knowledge.js';
export * from './review-proposals.js';
export * from './action-center.js';
export * from './library.js';
export * from './events.js';
export * from './transcripts.js';
export * from './monitoring.js';
export * from './notifications.js';
export * from './notify-channels.js';
export * from './outbound-notify.js';
export * from './auth.js';
export * from './audit-logs.js';
export * from './admin.js';
export * from './harness.js';
export * from './cso.js';
export * from './iron-laws.js';
export * from './mcp.js';
export * from './builtin-tools.js';
export * from './executions.js';
export * from './discord.js';
export * from './lark.js';
export * from './dingtalk.js';
export * from './deploy.js';
export * from './agents.js';
export * from './agent-profiles.js';
