// 批次 D-1.5（docs/plans/2026-09-ui-interaction-polish.md）：系统播报行首严重度前缀解析。
// 告警频道消息（api utils/notifier.ts formatLevelTag，形如 `[CRITICAL] **[Monitor]** …`）的裸文本
// 前缀在渲染层 chip 化；仅 critical/warning 出 chip，[INFO] 及其余文本原样透传。
// 纯解析、仅用于展示（剥前缀后的 rest 进渲染），不改消息数据本身。
export interface SeverityPrefix {
  level: 'critical' | 'warning';
  /** 剥掉 `[XXX]` 前缀（含其后的空白）后的正文 */
  rest: string;
}

const SEV_PREFIX_RE = /^\[(CRITICAL|WARNING)\]\s*/;

export function parseSeverityPrefix(content: string): SeverityPrefix | null {
  const m = SEV_PREFIX_RE.exec(content);
  if (!m) return null;
  return { level: m[1] === 'CRITICAL' ? 'critical' : 'warning', rest: content.slice(m[0].length) };
}
