/**
 * agent-ops 模块公共出口（P2-d 刀3：自 modules/agents/ops 提升）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 提升时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { createOpsService } from './ops.service.js';
