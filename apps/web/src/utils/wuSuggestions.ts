// 频道建议 prompt 片数据层（#440 Phase 1）：
// MVP = 按 WU 展示列（deriveDisplayState().column）静态映射建议列表，映射表集中于本文件，
// 后续换后端推导时只动这里；前端各组件不硬编码规则。
// pickCurrentWu = 频道「当前工单」拣选（建议片与阶段条共用同一数据源与口径）。
// #442 止血：in_review 片收窄——标注「可选」+ 说明点击后果；已有活跃 review 子工单时不出片
// （自动评审在途，防重复派单；子工单判据与后端 dispatch-reconciliation 同款）。
import { deriveDisplayState, type WuDisplayColumn } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../api/workunit';

export interface WuSuggestion {
  id: string;
  /** 点击后预填进输入框的内容（发给 agent 的指令本体），不被展示文案污染 */
  text: string;
  /** 片上展示文案（缺省 = text）；如 in_review 片冠以「可选」避免误导为下一步必做 */
  label?: string;
  /** 片内说明小字（可选语义 / 点击后果），说人话、无内部术语 */
  hint?: string;
}

/**
 * 展示列 → 下一步指令建议。空数组 = 不给建议：
 * pending（待确认人闸，人决定）/ done / closed（终态）不出片；
 * blocked + waitingForInput 由 NeedInputOptions 内嵌回复覆盖，不重复出片；
 * in_review + 已有活跃 review 子工单（hasActiveReview）不出片（#442，自动评审在途）。
 */
export function suggestionsForWu(
  column: WuDisplayColumn,
  meta: { waitingForInput?: unknown; hasActiveReview?: boolean },
): WuSuggestion[] {
  switch (column) {
    case 'unassigned':
      return [{ id: 'claim-start', text: '@developer 认领这张工单并开始实现' }];
    case 'active':
      return [{ id: 'contract-lock', text: '@developer 锁定实现契约（Invariant / Failure mode / Test evidence）' }];
    case 'in_review':
      return meta.hasActiveReview
        ? []
        : [{
            id: 'review-checklist',
            text: '@reviewer 把 AC 转写成审查清单',
            label: '可选：@reviewer 把 AC 转写成审查清单',
            hint: '自动评审通常已在进行，不点也会继续；点了会把这句话预填到输入框，可修改后再发送',
          }];
    case 'blocked':
      return meta.waitingForInput
        ? []
        : [{ id: 'diagnose-block', text: '@developer 诊断阻塞原因并给出修复方案' }];
    case 'pending':
    case 'done':
    case 'closed':
      return [];
  }
}

/**
 * 频道当前 WU = 非终态（派生列非 done/closed）中 updatedAt 最新者；全终态回退最新者；空 → null。
 * 终态判定走 deriveDisplayState 派生列（done 缺 l3 = in_review 仍算非终态），不读裸 status。
 */
export function pickCurrentWu(wus: WorkUnit[]): WorkUnit | null {
  if (wus.length === 0) return null;
  const byUpdated = [...wus].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const terminal = (w: WorkUnit) => {
    const c = deriveDisplayState({ status: w.status, metadata: w.metadata }).column;
    return c === 'done' || c === 'closed';
  };
  return byUpdated.find(w => !terminal(w)) ?? byUpdated[0];
}
