// studio-meeting 入口

export {
  MeetingTimeoutChecker,
  startTimeoutChecker,
  stopTimeoutChecker,
} from './services/meeting-timeout-checker.js';
export { 
  loadReviewRules,
  getRequiredParticipants,
  calculateVerdict,
  calculateBusinessHours,
  parseDuration,
  clearRulesCache,
  ReviewRules,
} from './services/review-rules-loader.js';

// 🆕 DD-008: DiscussionDriver
export { 
  DiscussionDriver,
  createDiscussionDriver,
  DiscussionDriverConfig,
  DiscussionResult,
  LLMClientInterface,
  // 🆕 AS-009: 争议检查
  ControversyCheckResult,
} from './discussion/discussion-driver.js';

export {
  ContextSharerImpl as RedisContextSharer,  // 向后兼容: RedisContextSharer 别名
  ContextSharer,
  contextSharer,
} from './discussion/context-sharer.js';

// 🆕 DD-020: 两级缓存
export {
  TwoLevelContextSharer,
  DataLoaderCache,
} from './discussion/two-level-cache.js';

export {
  MeetingMessageSender,
  MessageSender,
  messageSender,
} from './discussion/meeting-message-sender.js';

export {
  MeetingFileStorage,
  meetingFileStorage,
} from './discussion/meeting-file-storage.js';

export {
  discussionEventPublisher,
  discussionEventSubscriber,
  DiscussionEvent,
  DiscussionEventType,
} from './events/discussion-events.js';

export {
  initDiscussionEventHandlers,
  handleAutoStart,
  handleStopped,
  handleCompleted,
} from './events/discussion-event-handlers.js';

// 🆕 风险评估
export {
  assessMeetingRisk,
  getRiskLevelDescription,
  type RiskAssessment,
  type DecisionLike,
  type TaskLike,
} from './services/risk-assessor.js';

export type {
  TimeoutCheckerConfig,
} from './services/meeting-timeout-checker.js';

// RequirementsDoc（Goal 驱动执行流）
export type {
  RequirementsDoc,
  AcGroup,
} from './services/requirements-doc';

export type {
  MeetingDecision,
  MeetingMessage,
} from './orchestration/meeting-store';

export type { RedisClient } from './orchestration/context-sharer';

export type { TaskOutput } from './orchestration/task-output';

export type {
  GateChecker,
  GateResult,
  PerformanceThresholds,
} from './orchestration/gate-checker';
export * from './orchestration/meeting-core';
export * from './orchestration/meeting-state-machine';
export * from './orchestration/meeting-store';
export * from './orchestration/context-bridge';
export * from './orchestration/context-sharer';
export * from './orchestration/task-queue';
export * from './orchestration/task-worker';
export * from './orchestration/task-output';
export * from './orchestration/gate-checker';
export * from './orchestration/gate-bypass-manager';
export * from './orchestration/spec-constraint-layer';
export * from './orchestration/performance-monitor';
export * from './orchestration/failure-handler';
export * from './orchestration/workflow-blocker';
export * from './orchestration/state-listener';