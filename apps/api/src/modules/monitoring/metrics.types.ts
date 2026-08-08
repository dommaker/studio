/**
 * D16 监控指标类型契约（工单 30 自 metrics.service.ts 类型区抽出，纯搬运零逻辑变更）：
 * 9 个指标组接口 + Percentile + OverviewMetrics，供 service / 聚合纯函数 / 消费方共用。
 */

export interface Percentile {
  count: number;
  /** P50（小时，1 位小数；无数据 → null） */
  p50Hours: number | null;
  /** P95（小时，1 位小数；无数据 → null） */
  p95Hours: number | null;
}

export interface TaskFlowMetrics {
  description: string;
  /** 各状态 WU 数（当前快照） */
  byStatus: Record<string, number>;
  /** 非终态 WU 滞留时长（now - updatedAt） */
  dwell: Percentile & { description: string };
  /** 创建→认领时长（窗口内创建且已认领） */
  createToClaim: Percentile & { description: string };
  /** 认领→完成时长（窗口内完成） */
  claimToComplete: Percentile & { description: string };
  /** 失败按 errorType 分桶（窗口内更新过、failureType 列或 metadata.errorType 非空） */
  failuresByErrorType: { description: string; buckets: Record<string, number> };
  /** 执行步数统计（窗口内更新过且 metadata.stepCount > 0） */
  steps: { description: string; count: number; avgStepCount: number | null; stuckWorkUnits: number; avgStuckSteps: number | null };
}

export interface IntakeMetrics {
  description: string;
  /** 窗口内频道人类消息数（authorType=human） */
  humanMessages: number;
  /** 窗口内创建的 WU 数（workunits events created） */
  workUnitsCreated: number;
  /** 转化率 %（created/humanMessages；无消息 → null 不编造） */
  conversionPct: number | null;
}

export interface HumanInterventionMetrics {
  description: string;
  /** 窗口内完成的 WU 数（分母） */
  completedWorkUnits: number;
  /** NEED_INPUT 挂起次数（blocked 事件 metadata.waitingForInput；澄清期/执行期拆分见 roles） */
  needInputCount: number;
  /** review 驳回次数（完成 WU metadata._consecutiveReviewRejections 累计；含 dispatcher 自动驳回，数据源无法区分） */
  reviewRejections: number;
  /** 合并冲突转人工次数（完成 WU metadata.mergeConflict） */
  mergeConflicts: number;
  /** 北极星：每完成 WU 的平均人工干预次数；无完成 → null 不编造 */
  avgPerCompletedWu: number | null;
}

export interface CycleTimeMetrics {
  description: string;
  /** WU 创建→done 端到端时长（窗口内完成） */
  createToDone: Percentile;
  avgHours: number | null;
}

export interface RoleMetrics {
  description: string;
  roles: Array<{
    profileId: string;
    profileName: string;
    /** 窗口内认领数（claimed 事件归因） */
    claims: number;
    /** 窗口内完成数（completed 快照归因） */
    completions: number;
    /** 平均执行时长（小时，认领→完成；无 → null） */
    avgDurationHours: number | null;
    /** NEED_INPUT 次数：澄清期（waitingReason='ownership'，开工前问归属） */
    needInputClarify: number;
    /** NEED_INPUT 次数：执行期（执行中 agent 提问） */
    needInputExecution: number;
  }>;
}

export interface QualityMetrics {
  description: string;
  /** 自动验证通过数（窗口内更新、metadata.verifyReport 存在） */
  verifyPassed: number;
  /** 验证连续失败未通过数（verifyFailCount>0 且无 verifyReport） */
  verifyFailing: number;
  /** verifyReport 通过率 %（passed/(passed+failing)；无数据 → null） */
  verifyPassRatePct: number | null;
  /** 窗口内合并冲突转人工数（metadata.mergeConflict） */
  mergeConflicts: number;
  /** 窗口内完成自动合并数（metadata.mergedAt 落在窗口内） */
  merges: number;
}

export interface TokenMetrics {
  description: string;
  /** 窗口内合计 */
  totals: { injectedTokens: number; executionTokens: number; totalTokens: number };
  /** 有 token 事件归因的去重 WU 数 */
  workUnits: number;
  /** 每 WU 平均 token（executionTotals/workUnits；无 → null） */
  avgTokensPerWu: number | null;
  /** 缓存命中率 %（ΣcacheRead / Σ(cacheRead+cacheCreation+input)；无缓存数据 → null） */
  cacheHitRatePct: number | null;
  /** 缓存数据覆盖率（带 cache 字段的事件占比 %；<100 说明命中率为部分口径） */
  cacheCoveragePct: number;
  /** 按角色聚合（归因链同 token-usage.service：workUnitId → assigneeId → roleId） */
  byRole: Array<{ profileId: string; profileName: string; injectedTokens: number; executionTokens: number; totalTokens: number; workUnits: number }>;
}

export interface AlertMetrics {
  description: string;
  /** 近 24h 告警数（信噪比基础数据） */
  last24h: number;
  /** 窗口内告警数 */
  inWindow: number;
  /** 窗口内按级别分桶（payload.level） */
  byLevel: Record<string, number>;
}

/** F6（决策 1）证据台账指标：信任分层达成 + 双轨比对。派生口径一律过 deriveDisplayState */
export interface EvidenceMetrics {
  description: string;
  /** 证据模型已介入的 WU 数（有任何一层 attestation；存量 legacy 不计） */
  engaged: number;
  /** 各层达成数（approved 才算；当前快照口径，不按窗口） */
  l1Approved: number;
  l2Approved: number;
  l3Approved: number;
  /** l2 中自评数（决策 5：selfReview 占比高 = 评审独立性不足，频道该加成员或配评审 provider） */
  selfReviewCount: number;
  /** 人类待办 = 手写 in_review + done ∧ ¬l3（证据已介入） */
  needsHuman: number;
  /** 双轨比对：派生列 ≠ 存储状态的 WU 数。验证期观察——持续降到 0 附近才可停止手写 in_review */
  derivedMismatch: number;
  /** 派生列分布（展示口径；看板/列表应与之一致，不一致说明有 UI 绕派生函数） */
  derivedByColumn: Record<string, number>;
}

export interface OverviewMetrics {
  windowDays: number;
  generatedAt: string;
  taskFlow: TaskFlowMetrics;
  intake: IntakeMetrics;
  humanIntervention: HumanInterventionMetrics;
  cycleTime: CycleTimeMetrics;
  roles: RoleMetrics;
  quality: QualityMetrics;
  tokens: TokenMetrics;
  alerts: AlertMetrics;
  /** F6 证据台账（决策 1；双轨期与门模型并存比对） */
  evidence: EvidenceMetrics;
  /** 数据源状态：有任何 WU 或事件数据 → 'events'，全空 → 'insufficient-data' */
  source: 'events' | 'insufficient-data';
}
