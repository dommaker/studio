// 项目级展示词表唯一出口（#472）：项目状态词 / 项目状态配色 / 交付策略文案。
// 消费方：ProjectCard（状态 chip + 策略标注）、ProjectDetailPage（MetaStrip 策略）、
// DeliveryPanel（台账策略）、PmoNumberBadge（tooltip + 徽章配色）。
// 项目状态词与 #399 §8.3 项目阶段词（讨论→开发→验收→交付）同族；delivered 归并已交付（同 ProjectDetailPage 步骤条口径）。
// 禁止消费方再写 `policy === 'auto-merge' ? '自动合并' : '分支交付'` 三元或裸输出策略值/英文状态。

/** 项目状态 → 中文词 */
export const PROJECT_STATUS_LABELS: Record<string, string> = {
  pending: '讨论中',
  active: '开发中',
  in_review: '验收中',
  completed: '已交付',
  delivered: '已交付',
  cancelled: '已取消',
};

/** 项目状态 → 徽章配色（u-* 工具类；沿用 PmoNumberBadge 原配色语义） */
export const PROJECT_STATUS_COLORS: Record<string, string> = {
  pending: 'u-surface-2 u-text',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  completed: 'u-ok-dim u-ok',
  delivered: 'u-ok-dim u-ok',
  cancelled: 'u-err-dim u-err',
};

/** 交付策略 → 中文文案（界面不出现裸 auto-merge / branch-only） */
export const DELIVERY_POLICY_LABELS: Record<string, string> = {
  'auto-merge': '自动合并',
  'branch-only': '分支交付',
};
