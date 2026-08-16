/**
 * #176（决策 #57 D3）：blocked 相关消息的统一行动召唤（CTA）模板 —— 按钮缺位期的正式交互替代。
 *
 * 三处同一模板（按 blockReason 类型前缀填充失败原因摘要）：
 *   1. blocked 里程碑（agent-loop 转 blocked / timeout-release 达上限）→ withBlockedCta
 *   2. 30min 提醒（waiting-input 扫描，同口径重发）→ withBlockedCta
 *   3. 24h 死信通知（autoAbandonStaleBlocked，已关闭 + 后续出路）→ buildDeadLetterNotice
 *
 * 零运行时依赖的叶子模块（同 wu-metadata），任何模块可安全引入。
 * 按钮通道是迭代方向（依赖 #61），落地后 CTA 文案与按钮并存。
 */

/** 继续/关闭 CTA 块（blocked 里程碑与 30min 提醒同口径，决策 #57 D3-1 原文） */
export const BLOCKED_CTA_CONTINUE =
  '回复本线程即可继续执行，回复内容会交给执行 agent；若任务无需继续，回复「关闭」即可；24 小时无介入将自动关闭并通知';

/** blockReason → 失败原因摘要（沿用类型前缀：timeout:/stuck:/verify-failed/need-input: 等，截断 120 字符） */
export function summarizeBlockReason(blockReason?: string | null): string {
  const raw = (blockReason ?? '').trim();
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

/** blocked 里程碑/30min 提醒消息：headline + 失败原因摘要（有则）+ 统一 CTA 块 */
export function withBlockedCta(headline: string, blockReason?: string | null): string {
  const reason = summarizeBlockReason(blockReason);
  return [headline, ...(reason ? [`失败原因：${reason}`] : []), BLOCKED_CTA_CONTINUE].join('\n');
}

/** 24h 死信通知（决策 #57 D4）：已关闭说明 + 失败原因摘要 + 后续出路 */
export function buildDeadLetterNotice(title: string, blockReason?: string | null): string {
  const reason = summarizeBlockReason(blockReason);
  return [
    `任务「${title}」24 小时无人工介入，已自动关闭${reason ? `（失败原因：${reason}）` : ''}。`,
    '如需继续请重新派发。',
  ].join('\n');
}
