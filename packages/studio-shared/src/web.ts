/**
 * 前端专用入口 - 仅导出无 Node 依赖的纯逻辑/类型模块
 *
 * 前端请使用此入口：import { deriveDisplayState } from '@dommaker/studio-shared/web'
 * 后端请使用 '@dommaker/studio-shared' 或 '@dommaker/studio-shared/node'
 *
 * 添加新导出前必须确认：模块无 fs/path/os/child_process/crypto 等 Node 内置依赖，
 * 且无 top-level 副作用（模块加载时不执行任何 Node API 调用）。
 */

// F6 信任证据模型（纯逻辑：parseAttestations / deriveDisplayState 等）
export * from './attestation';

// 监控探针阈值常量（纯常量，无 Node 依赖；Web 下钻口径与 api 探针同源）
export * from './constants/monitoring';
