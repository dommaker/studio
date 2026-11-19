// WorkUnitDrawer 共享状态派生工具（WuDetail / ReqChain 两份拆分共用）
import { deriveDisplayState } from '@dommaker/studio-shared/web';

/** wu 状态 → 状态 chip 修饰类（active=执行中 pulse / blocked=待确认 / done|closed=完成 / 其余=待定） */
export function wuStatusClass(status: string): string {
  if (status === 'active') return 'mc-status mc-status-running';
  if (status === 'blocked') return 'mc-status mc-status-need';
  if (status === 'done' || status === 'closed') return 'mc-status mc-status-done';
  return 'mc-status mc-status-pending';
}

/** F6：WU 展示状态唯一派生口径（铁律：徽章/样式只准看派生列，禁止各自解释 attestations） */
export function deriveWuColumn(wu: { status: string; metadata?: string | null }): string {
  return deriveDisplayState({ status: wu.status, metadata: wu.metadata }).column;
}
