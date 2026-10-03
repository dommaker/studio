// useChannelDrawers — 频道页右抽屉与转任务弹窗状态（P3-b 自 ChannelDetailPage 切出）：
// Mission Control 右抽屉（WorkUnit 详情 / REQ 全链路）+ 四种自动动作入口
// （#284 analysis_confirm 去确认 / #467 plan_ruling 去裁决 / #567 plan_direction 去选定）
// + B3 AC-E3 转任务弹窗页面级单例（原每条可见消息各挂一个实例：关闭态仍跑 2 个 store 订阅 +
// key 比较，roster/members 更新扇出 N 份）。
// 全部回调 useCallback 空依赖——#322/#547 memo 稳定 props 契约（messageEnv 成员禁逐帧换引用）。
import { useCallback, useState } from 'react';
import type { DrawerState } from '../components/channel/WorkUnitDrawer';
import type { ChannelMessage } from '../api/channel';

export function useChannelDrawers() {
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [convertTarget, setConvertTarget] = useState<ChannelMessage | null>(null);

  const openWu = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId }), []);
  // #284（决策 #250 D6）：analysis_confirm 接力卡「去确认」——打开即弹确认对话框
  const openWuConfirm = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoApprove: true }), []);
  // #467：plan_ruling 裁决轮接力卡「去裁决」——打开即弹 PlanRulingDialog
  const openWuRuling = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoRuling: true }), []);
  // #567：plan_direction 方向锁定接力卡「去选定」——打开即弹 PlanDirectionDialog
  const openWuDirection = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoDirection: true }), []);
  const openReq = useCallback((reqId: string) => setDrawer({ kind: 'req', id: reqId }), []);
  const closeDrawer = useCallback(() => setDrawer(null), []);

  const openConvert = useCallback((m: ChannelMessage) => setConvertTarget(m), []);
  const closeConvert = useCallback(() => setConvertTarget(null), []);

  return {
    drawer, openWu, openWuConfirm, openWuRuling, openWuDirection, openReq, closeDrawer,
    convertTarget, openConvert, closeConvert,
  };
}
