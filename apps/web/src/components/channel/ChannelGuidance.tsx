// ChannelGuidance — 频道引导片区（P3-b 自 ChannelDetailPage 切出）：
// #443–#447 引导片（唯一来源 = 建议端点派生片；renderSuggestionCopy 模板渲染，未知模板 fail-closed）
// + #484 片粒度 dismiss（会话级台账 key = `ep:{wuId}:{suggestionId}`）
// + #444 动作片一次确认（ConfirmDialog 说清后果 → 直调确定性接口，与自动化同原语不经消息路由；
//   生效后 refreshSuggestions 状态回扫；失败原因内联进弹窗不静默）。
// 数据注入：suggestions 来自 channelWorkStore suggestions slice（页面订阅）；prefill 经回调上送页面
// （ChannelInput prefill 通道，点击不自动发送）。
import { useCallback, useMemo, useState } from 'react';
import axios from 'axios';
import { SuggestionChips, type SuggestionChipItem } from './SuggestionChips';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { renderSuggestionCopy } from '../../utils/suggestionCopy';
import { getSuggestionAction } from '../../utils/suggestionActions';
import { useChannelWorkStore } from '../../stores/channelWorkStore';
import type { ChannelSuggestion } from '../../api/channel';

/** #444：动作片执行错误文案——优先服务端 error 信封 message（409 拒绝原因对人可读） */
function suggestionActionErrorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const msg = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (msg) return msg;
  }
  return e instanceof Error ? e.message : String(e);
}

/** #443：带 dismiss 台账 key 的引导片（key = `ep:{wuId}:{suggestionId}`，端点派生片唯一来源 #447） */
type DismissibleChip = SuggestionChipItem & { dismissKey: string };

interface ChannelGuidanceProps {
  channelId: string;
  /** 建议端点派生片（channelWorkStore suggestions slice，resolved 旗标不在本组件消费） */
  suggestions: ChannelSuggestion[];
  /** prompt 片点击 / 文案上送：经页面 prefill 通道填入输入框（不自动发送） */
  onPrefill: (text: string) => void;
}

export function ChannelGuidance({ channelId, suggestions, onPrefill }: ChannelGuidanceProps) {
  // #440：建议片 dismiss 台账（会话级，key = `ep:{wuId}:{suggestionId}`，同 key 不复活）
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(new Set());

  // #444：确定性动作片（补派评审等）——点击 → 一次确认 → 直调确定性接口（与自动化同原语），
  // 不经消息路由；生效后重拉建议，前置条件转假片消失/更新。失败原因内联进弹窗，不静默。
  const [pendingSuggestionAction, setPendingSuggestionAction] = useState<{ id: string; wuId: string; wuTitle: string } | null>(null);
  const [suggestionActionError, setSuggestionActionError] = useState<string | null>(null);
  const [suggestionActionRunning, setSuggestionActionRunning] = useState(false);

  // #443：端点派生建议 → 文案模板渲染成引导片（未知模板 id → 跳过，fail-closed）
  // #446：prompt 形态的预填指令本体由后端 text 字段承载，透传给 SuggestionChips（点击 → onPick(text)）
  const endpointChips = useMemo<DismissibleChip[]>(() => suggestions.flatMap(s => {
    const copy = renderSuggestionCopy(s);
    if (!copy) return [];
    return [{ id: s.id, kind: s.kind, text: s.text, label: copy.label, hint: copy.hint, dismissKey: `ep:${s.params.wuId ?? ''}:${s.id}` }];
  }), [suggestions]);
  // #447：引导片 = 端点派生片（唯一来源；dismiss 台账按 dismissKey 过滤，会话级）
  const visibleChips = useMemo<DismissibleChip[]>(
    () => endpointChips.filter(c => !dismissedSuggestionKeys.has(c.dismissKey)),
    [endpointChips, dismissedSuggestionKeys],
  );

  const handleSuggestionAction = useCallback((item: SuggestionChipItem) => {
    const def = getSuggestionAction(item.id);
    if (!def) return; // fail-closed：未注册动作不执行
    const s = suggestions.find(x => x.id === item.id);
    if (!s?.params.wuId) return; // 缺工单上下文不执行
    setSuggestionActionError(null);
    setPendingSuggestionAction({ id: item.id, wuId: s.params.wuId, wuTitle: s.params.wuTitle ?? s.params.wuId });
  }, [suggestions]);

  const runSuggestionAction = useCallback(async () => {
    if (!pendingSuggestionAction) return;
    const def = getSuggestionAction(pendingSuggestionAction.id);
    if (!def) return;
    setSuggestionActionRunning(true);
    try {
      await def.run(pendingSuggestionAction.wuId);
      setPendingSuggestionAction(null);
      // 状态回扫：子单建出 → 前置条件转假 → 片消失/更新（#528 边界 5：store 暴露即时重拉）
      void useChannelWorkStore.getState().refreshSuggestions(channelId);
    } catch (e) {
      setSuggestionActionError(suggestionActionErrorMessage(e));
    } finally {
      setSuggestionActionRunning(false);
    }
  }, [pendingSuggestionAction, channelId]);

  const pendingActionDef = pendingSuggestionAction ? getSuggestionAction(pendingSuggestionAction.id) : null;

  return (
    <>
      {/* #443–#447：引导片（prompt 点击填入输入框，status 只读，action 点击走确认弹窗直调确定性接口；
          会话级 dismiss）#484：片粒度 dismiss——每片独立 ✕，按片 dismissKey 记账，不再一键清全部 */}
      {visibleChips.length > 0 && (
        <SuggestionChips
          suggestions={visibleChips}
          onPick={onPrefill}
          onAction={handleSuggestionAction}
          onDismiss={(item) => {
            const key = visibleChips.find(c => c.id === item.id)?.dismissKey;
            if (!key) return; // fail-closed：找不到台账 key 不记（不静默吞掉别片）
            setDismissedSuggestionKeys(prev => new Set(prev).add(key));
          }}
        />
      )}

      {/* #444：动作片一次确认——文案说清点了会发生什么；失败原因内联进弹窗不静默 */}
      {pendingSuggestionAction && pendingActionDef && (
        <ConfirmDialog
          open
          title={pendingActionDef.title}
          confirmLabel={pendingActionDef.confirmLabel}
          loading={suggestionActionRunning}
          message={
            <>
              {pendingActionDef.confirmMessage(pendingSuggestionAction.wuTitle)}
              {suggestionActionError && (
                <div className="text-xs u-err" style={{ marginTop: 8 }}>{suggestionActionError}</div>
              )}
            </>
          }
          onConfirm={() => { void runSuggestionAction(); }}
          onCancel={() => setPendingSuggestionAction(null)}
        />
      )}
    </>
  );
}
