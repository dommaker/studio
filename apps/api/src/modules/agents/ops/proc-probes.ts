/**
 * /proc 系统探测单出口 —— 门面转介。
 * 实现已下沉 core/proc-probes.ts（P2-c：agents/knowledge 双方消费的零依赖原语），
 * agents 模块内消费方与 agents/index.ts 公共面路径不变。
 */
export * from '../../../core/proc-probes.js';
