/**
 * per-WU-type COMPLETE 收割注册表（#542，2026-09-15 架构评审候选 A2）
 *
 * agentStep 成功路径的 WU 输出解析 → metadataUpdates 落档，从 agent-loop.ts 的
 * 长串 if 分支改为「type → 收割器组」注册表调度：
 *   - 新 WU type 收割 = 在 COMPLETION_HARVEST_REGISTRY 注册一行；
 *   - 注册表键 = wu.type 单键（开放问题 1 决议）；变体走收割器内部读 ctx.metadata
 *     （inspection 标记），plan 与 analysis 共享同一收割器组（#471 一脉会话，契约不变）；
 *   - 失败语义（开放问题 2 决议）：单个收割器抛错仅 warn 跳过该收割器，其余收割器
 *     与整条收割链不受影响；解析器本身返回 null/[] 不抛（解析无获不落档、不阻断完成，
 *     语义与各分支原实现逐一对应）。
 *
 * 解析器全部复用现成品（agent-loop-parsers / pmo/map-opening / pmo/spec-materialization），
 * 本模块只做调度与落档形状组装，不新增解析契约。
 */

import { logger } from '@dommaker/studio-shared';
import type { WorkUnitMetadata } from '../../workunit/workunit.service.js';
import {
  parseReviewReport, parseTaskBreakdown, parseOpportunities, parseDecisionConclusion,
} from './agent-loop-parsers.js';
import { parseMapOpening } from '../../pmo/map-opening.js';
import { parseSpecTasks } from '../../pmo/spec-materialization.js';

export interface CompletionHarvestContext {
  wuId: string;
  wuType: string;
  /** 当前 metadata（变体判定用，如 inspection 标记） */
  metadata: WorkUnitMetadata;
}

/** 收割器：从 WU 最终输出解析出 metadataUpdates 贡献（无获返回 {}） */
export type CompletionHarvester = (outputText: string, ctx: CompletionHarvestContext) => Partial<WorkUnitMetadata>;

/** review：REVIEW_RESULT → reviewReport（ReviewDispatcher 路径 B 判定的唯一数据源） */
const reviewReportHarvester: CompletionHarvester = (outputText, ctx) => {
  const report = parseReviewReport(outputText);
  if (report) return { reviewReport: report };
  logger.warn(`[AgentLoop] Review WU ${ctx.wuId} completed without parseable REVIEW_RESULT — 由 ReviewDispatcher 转人工`);
  return {};
};

/** analysis/plan：TASK: 拆分行 → analysisTasks（analysis-handoff 派工数据源） */
const analysisTasksHarvester: CompletionHarvester = (outputText) => {
  const tasks = parseTaskBreakdown(outputText);
  return tasks.length > 0 ? { analysisTasks: tasks } : {};
};

/** analysis/plan：FOG:/DESTINATION: 行 → analysisFog/analysisDestination（确认弹窗预填） */
const mapOpeningHarvester: CompletionHarvester = (outputText) => {
  const opening = parseMapOpening(outputText);
  if (opening.fog.length === 0) return {};
  return {
    analysisFog: opening.fog,
    ...(opening.destination ? { analysisDestination: opening.destination } : {}),
  };
};

/** analysis/plan 巡检变体（metadata.inspection===true）：OPPORTUNITY: 行 → opportunities */
const inspectionOpportunitiesHarvester: CompletionHarvester = (outputText, ctx) => {
  if (ctx.metadata.inspection !== true) return {};
  const opps = parseOpportunities(outputText);
  if (opps.length === 0) return {};
  return {
    opportunities: opps.map((o, i) => ({
      id: `opp-${i + 1}`,
      ...o,
      status: 'pending' as const,
    })),
  };
};

/** decision：`## 结论摘要` 段 → decisionSuggestion（确认弹窗预填 agent 建议结论） */
const decisionSuggestionHarvester: CompletionHarvester = (outputText) => {
  const suggestion = parseDecisionConclusion(outputText);
  return suggestion ? { decisionSuggestion: suggestion } : {};
};

/** spec：TASK: 物化行 → specTasks（确认弹窗卡片墙预填，spec-materialization 同一解析器） */
const specTasksHarvester: CompletionHarvester = (outputText) => {
  const specTasks = parseSpecTasks(outputText);
  return specTasks.length > 0 ? { specTasks } : {};
};

/** analysis 与 plan 共享的收割器组（#471：plan 沿用 analysis 字段名与解析契约） */
const ANALYSIS_HARVESTERS: CompletionHarvester[] = [
  analysisTasksHarvester,
  mapOpeningHarvester,
  inspectionOpportunitiesHarvester,
];

/**
 * 收割注册表：wu.type → 收割器组。新 WU type 收割 = 注册一行。
 * 同 type 多收割器按序执行，结果合并（后写覆盖先写——同 type 内各收割器落不同字段，
 * 正常无覆盖）。
 */
export const COMPLETION_HARVEST_REGISTRY: Record<string, CompletionHarvester[]> = {
  review: [reviewReportHarvester],
  analysis: ANALYSIS_HARVESTERS,
  plan: ANALYSIS_HARVESTERS,
  decision: [decisionSuggestionHarvester],
  spec: [specTasksHarvester],
};

/**
 * 调度入口：按 wu.type 查注册表，逐收割器执行并合并 metadataUpdates。
 * 单个收割器抛错仅 warn 跳过（收割是落档增强，绝不让解析异常打断 agentStep 成功路径）；
 * 未注册 type → {}。
 */
export function harvestCompletionMetadata(outputText: string, ctx: CompletionHarvestContext): Partial<WorkUnitMetadata> {
  const harvesters = COMPLETION_HARVEST_REGISTRY[ctx.wuType];
  if (!harvesters) return {};
  const updates: Partial<WorkUnitMetadata> = {};
  for (const harvester of harvesters) {
    try {
      Object.assign(updates, harvester(outputText, ctx));
    } catch (err) {
      logger.warn(`[AgentLoop] completion harvest failed for WU ${ctx.wuId} (type=${ctx.wuType}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return updates;
}
