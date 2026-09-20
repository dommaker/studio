/**
 * audit-logs/agent-decision (#591 B 类) — agent 自主决策埋点统一入口
 *
 * 依据 docs/adr/2026-09-17-decision-audit-consolidation.md 决策 2/3：自主决策埋点
 * 统一落 audit-logs 轨（形状对齐审计行 + actorType 维度），不重建 events:audit 链、
 * 不写 KnowledgeStore。决策词表（增删走治理变更流程，正本 = 本模块 CONTEXT.md）：
 *   claim（WU 认领）/ transition（WU 状态机流转）/ dispatch（@mention 派单与决策12 默认角色）/
 *   create|execute|update（trigger 触发）/ auto_apply（auditor 低风险自动应用）
 *
 * fire-and-forget：失败只记日志，绝不阻断业务链路（对齐 claim-announce 出声先例）。
 */
import { AuditService } from '@dommaker/studio-audit';
import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { createLazyService } from '../../utils/services.js';

const getAuditService = createLazyService(() => new AuditService(new FileStore()));

/** 决策主体（认领人/流转操作人/被指名 profile 等）；缺省视为 agent 自主决策 */
export interface AuditActor {
  id: string;
  type: 'human' | 'agent';
}

export interface AgentDecisionRecord {
  /** 决策动作（词表见头注释） */
  action: string;
  /** 决策对象类型 */
  resource: string;
  resourceId?: string;
  actor?: AuditActor;
  /** 结果（缺省 success） */
  status?: 'success' | 'failure';
  /** 依据摘要（关键 id + 判定条件；不落全 payload，防噪音/PII 膨胀） */
  details?: Record<string, unknown>;
  /** traceId：频道链路复用 ctx.traceId，trigger/auditor 现场生成 randomUUID */
  requestId?: string;
}

export function recordAgentDecision(input: AgentDecisionRecord): void {
  getAuditService().log({
    actorType: input.actor?.type ?? 'agent',
    userId: input.actor?.type === 'human' ? input.actor.id : undefined,
    roleId: input.actor?.type === 'agent' ? input.actor.id : undefined,
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId,
    status: input.status ?? 'success',
    details: input.details,
    requestId: input.requestId,
  }).catch(err =>
    logger.warn({ err, action: input.action, resource: input.resource }, '[audit] agent decision record failed (non-blocking)'));
}
