/**
 * WU 展示词表唯一出口（#358：7 份散装拷贝收口——WU_STATUS_LABELS ×3 + statusLabels ×4，
 * 及随附 statusColors/typeLabels；阅览室文档词表逐字同构随本模块一并收口）。
 * 挂 deriveDisplayState 旁：展示列由 deriveDisplayState().column 派生，本模块只负责 列/状态 → 文案/配色 映射。
 * 未知状态调用方兜底原样显示（labels[col] ?? col），表内容即渲染契约。
 * 注意：RequirementChainPanel / ProjectPipeline / mapUtils.DEP_STATUS_LABEL 存在有意方言
 * （pending 缺省、unassigned 配色 u-text-2、依赖图大白话文案）——行为对齐另议，不在 #358 范围。
 */

/** WU 状态（含派生列）→ 中文文案。failed/completed 为原始状态值（ProjectActivity 时间线条目直接消费）。 */
export const WU_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
  failed: '失败',
  completed: '已完成',
};

/** WU 状态 → chip 配色（u-* 工具类，定义在 apps/web 样式层） */
export const WU_STATUS_COLORS: Record<string, string> = {
  pending: 'u-warn-dim u-warn',
  unassigned: 'u-surface-2 u-text-3',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  done: 'u-ok-dim u-ok',
  closed: 'u-ok-dim u-ok',
  blocked: 'u-err-dim u-err',
};

/** WU 类型 → 中文文案 */
export const WU_TYPE_LABELS: Record<string, string> = {
  task: '任务',
  monitor: '监控',
  analysis: '分析',
  discussion: '讨论',
};

/** 阅览室文档状态 → 中文文案（LibraryPage / LibraryDocPage 同源） */
export const LIBRARY_DOC_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  done: '已完成',
  stale: '已过期',
};

/** 阅览室文档状态 → chip 配色 */
export const LIBRARY_DOC_STATUS_COLORS: Record<string, string> = {
  draft: 'u-warn-dim',
  confirmed: 'u-ok-dim',
  done: 'u-surface-2 u-text-3',
  stale: 'u-surface-2 u-text-3',
};
