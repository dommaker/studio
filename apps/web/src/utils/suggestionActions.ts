// 动作片 → 确定性接口注册表（#444 / spec #441）：每条 action 形态建议的点击效果登记于此。
// 交互范式：点击 → 一次确认（ConfirmDialog，文案说清会发生什么）→ 直调确定性接口 →
// 等状态回扫后片消失/更新。契约：redispatch-review 直调 dispatch-review 端点——
// 与 ReviewDispatcher 自动派发同一原语（dispatchReviewNow），不经 @mention 消息路由、
// 不新建普通工单、不产生频道噪音。fail-closed：未注册 id → null（不执行、不编造）。
import { workunitApi } from '../api/workunit';

export interface SuggestionActionDef {
  /** 确认弹窗标题 */
  title: string;
  /** 确认键文案 */
  confirmLabel: string;
  /** 确认弹窗正文（说清点了会发生什么，带工单上下文） */
  confirmMessage: (wuTitle: string) => string;
  /** 执行：直调确定性接口 */
  run: (wuId: string) => Promise<unknown>;
}

const ACTIONS: Record<string, SuggestionActionDef> = {
  'redispatch-review': {
    title: '补派评审',
    confirmLabel: '确认补派',
    confirmMessage: wuTitle =>
      `立即为《${wuTitle}》创建一张审查工单，交给频道里的成员审查；不会新建普通工单，也不会在频道里发消息。`,
    run: wuId => workunitApi.dispatchReview(wuId),
  },
  // #445：认领动作片 —— 直调 claim 端点（认领即发声原语，与 loop 自动认领同一路径）；
  // 前端不带身份：认领人由服务端按会话用户解析（诚实归因，不可伪造）
  'claim-wu': {
    title: '认领工单',
    confirmLabel: '确认认领',
    confirmMessage: wuTitle =>
      `把《${wuTitle}》认领到你的名下，由你接着处理；频道里会发一条认领说明，告诉大家这张工单已经有人接手。`,
    run: wuId => workunitApi.claim(wuId),
  },
};

/** 查动作定义；未注册 → null（fail-closed） */
export function getSuggestionAction(id: string): SuggestionActionDef | null {
  return ACTIONS[id] ?? null;
}
