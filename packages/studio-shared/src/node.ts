/**
 * Node.js 专用入口 — 包含 Config 等 Node-only 模块
 *
 * 后端消费者需要运行时配置时使用：
 *   import { loadConfigEnv } from '@dommaker/studio-shared/node'
 *
 * 前端请使用主入口 '@dommaker/studio-shared'（不包含 fs/path 等 Node 依赖）
 */
export * from './vps-workspace';
export * from './config/index';
export * from './providers';
export * from './capability-probe';
export * from './model-probe';
export * from './utils/index';
export * from './llm/index';
export * from './harness/index';
export * from './constants/levels';
export type { ConstraintSeverity, ConstraintContext, ConstraintResult } from '@dommaker/harness';
// #361 事件写口唯一入口 + 日志路径隔离 + RKB 匹配核心（自 apps/api 下沉）
export * from './studio-events';
export * from './log-path';
export * from './resolutions';
