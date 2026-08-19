/**
 * FL-029: Harness Monitoring Routes (T-015)（挂载门面）
 *
 * 本文件为路由门面：创建 Router、按原注册顺序挂载子路由、默认导出不变
 * （route-registry.ts 将其挂载于 /api/v1/harness（requireAuth+requireAdmin）。
 * 2026-07 收紧：/api/v1/cso 不再整挂本 router，只挂 cso.routes 的
 * GET /validate——否则本文件的 Admin 收紧可被 /cso/* 双挂载绕过）：
 * 处理器实现已按资源拆分为子路由（T3 大文件拆分序列 5/N，零行为变更）：
 *
 * - runtime.ts           共享运行时：@dommaker/harness 懒加载、Collector/Analyzer/
 *                        KnowledgeStore 单例、TTL 响应缓存
 * - traces.routes.ts     轨迹采集/分析/诊断（T-015）：GET|POST /traces、
 *                        GET /analysis、GET /analysis/anomalies、POST /diagnose
 * - proposals.routes.ts  约束提案（T-002）：GET /proposals、
 *                        POST /proposals/:id/review、POST /proposals/:id/execute（410）
 * - constraints.routes.ts 约束清单 + 质量门（T-002/M2）：GET /constraints、
 *                        GET /constraints/stats、GET /constraints/retired、
 *                        GET /constraints/:id、POST /constraints/:id/rollback、
 *                        POST /check-constraints
 * - knowledge.routes.ts  知识引擎（T-010）：POST /knowledge/query、GET /knowledge、
 *                        GET /knowledge/:id、POST /knowledge、
 *                        DELETE /knowledge/:id、POST /knowledge/lint
 * - sessions.routes.ts   上下文管理（T-011）：POST /estimate-tokens、POST /sessions、
 *                        POST /sessions/:id/events、GET /sessions/:id、
 *                        POST /sessions/:id/checkpoint
 * - agents.routes.ts     Agent 生命周期（T-014）：POST /agents、
 *                        POST /agents/:id/start|complete|fail、
 *                        GET /agents、GET /agents/:id
 * - diagnostics.routes.ts 错误分类/规格检查/验证（T-016/T-018/T-013）：
 *                        POST /classify、POST /failures、POST /check-spec、
 *                        POST /verify、GET /verify/rules
 * - dashboard.routes.ts  仪表盘/健康（T-017）：GET /dashboard、GET /health
 * - cso.routes.ts        CSO 验证（Decision #5）：GET /validate
 *
 * 挂载顺序等价性（Express 路由匹配顺序敏感）：
 * 各子路由的路径首段字面前缀互不重叠（traces/analysis/diagnose/proposals/
 * constraints/check-constraints/knowledge/
 * estimate-tokens/sessions/agents/classify/failures/check-spec/verify/dashboard/
 * health/validate），router.use 无匹配时自动 fallthrough；唯一的前缀包含关系
 * GET /constraints/stats 与 GET /constraints/:id 位于同一子路由内且保持
 * stats 在前。因此任一 method+path 的第一个匹配处理器与原单文件注册顺序完全一致。
 */

import { Router } from 'express';
import { tracesRoutes } from './traces.routes.js';
import { proposalsRoutes } from './proposals.routes.js';
import { constraintsRoutes } from './constraints.routes.js';
import { knowledgeRoutes } from './knowledge.routes.js';
import { sessionsRoutes } from './sessions.routes.js';
import { agentsRoutes } from './agents.routes.js';
import { diagnosticsRoutes } from './diagnostics.routes.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { csoRoutes } from './cso.routes.js';

const router = Router();

// 挂载顺序 = 原文件注册顺序
router.use(tracesRoutes);
router.use(proposalsRoutes);
router.use(constraintsRoutes);
router.use(knowledgeRoutes);
router.use(sessionsRoutes);
router.use(agentsRoutes);
router.use(diagnosticsRoutes);
router.use(dashboardRoutes);
router.use(csoRoutes);

export default router;
