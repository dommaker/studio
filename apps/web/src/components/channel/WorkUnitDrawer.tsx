// WorkUnitDrawer — Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路
// 只展示真实 API 数据（workunitApi / requirementApi / monitoringApi / channelApi），无对应数据的维度不展示、不编造
// 2026-09 页面重设计 E2（docs/plans/2026-09-page-redesign.md）：列表页行点击同挂本抽屉（props 自包含自取数）；
// 闸门动作合一走 WuGateActions；ReviewHint（in_review 且频道无 reviewer）自列表展开区挪入闸门动作区上方；
// ExecutionSteps 后补「会话原文」折叠节（TranscriptViewer，原详情页独有）。
// 本体拆分：WuDetail / ReqChain 两个子组件按原文件内分隔注释各归其文件（WuDetail.tsx / ReqChain.tsx），
// 共享状态派生（wuStatusClass / deriveWuColumn）在 wuStatus.ts
import { useEffect } from 'react';
import { IconCheck } from '../ui/icons';
import { WuDetail } from './WuDetail';
import { ReqChain } from './ReqChain';

export type DrawerState =
  // #284（决策 #250 D6）：autoApprove = analysis_confirm 接力卡「去确认」的「打开即弹」入参
  // #467：autoRuling = plan_ruling 裁决轮接力卡「去裁决」的「打开即弹」入参
  // #567：autoDirection = plan_direction 方向锁定接力卡「去选定」的「打开即弹」入参
  | { kind: 'wu'; id: string; autoApprove?: boolean; autoRuling?: boolean; autoDirection?: boolean }
  | { kind: 'req'; id: string }
  | null;

interface Props {
  drawer: DrawerState;
  onClose: () => void;
  onOpenWu: (id: string) => void;
  onOpenReq: (id: string) => void;
  /** D-2 项3（行动中心串办，可选）：host 仅在「当前 WU 已处理完（掉出待办池）」时传入——
   *  抽屉内给「下一个 →」同池导航（不关抽屉换 WU）；next=null → 收口文案 */
  todoNav?: DrawerTodoNav;
}

/** D-2 项3：抽屉内「下一个待办」导航数据（host 计算，组件只渲染） */
export interface DrawerTodoNav {
  /** 下一个待办（host 侧同池第一项）；null = 待办池已清空 */
  next: { wuId: string; label: string } | null;
  onOpenNext: (wuId: string) => void;
}

export function WorkUnitDrawer({ drawer, onClose, onOpenWu, onOpenReq, todoNav }: Props) {
  // 批次 F-2：Escape 关闭抽屉；事件源在弹层（.modal-overlay）内时让给弹层自管，避免一按双关
  useEffect(() => {
    if (!drawer) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 事件源在弹层（.modal-overlay）内、或 Select 选项面板在岗时让弹层自管，避免一按双关
      if (e.target instanceof Element && e.target.closest('.modal-overlay')) return;
      if (document.querySelector('.select-panel')) return;
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [drawer, onClose]);

  if (!drawer) return null;
  return (
    <aside className="mc-drawer" aria-label="详情抽屉">
      <div className="mc-drawer-head">
        {/* #395（spec §4.6）：<768 抽屉全屏化的左上返回（≥768 CSS 隐藏，DOM 常驻） */}
        <button className="mc-drawer-back" aria-label="返回" onClick={onClose}>← 返回</button>
        <h3 className="mc-drawer-title" title={drawer.kind === 'wu' ? drawer.id : `${drawer.id} 全链路`}>
          {drawer.kind === 'wu' ? drawer.id : `${drawer.id} 全链路`}
        </h3>
        <button className="mc-drawer-close" aria-label="关闭抽屉" onClick={onClose}>×</button>
      </div>
      {/* D-2 项3：行动中心串办导航条（host 在当前 WU 处理完后才传 todoNav） */}
      {drawer.kind === 'wu' && todoNav && (
        <div className="ac-todo-nav">
          {todoNav.next ? (
            <button
              className="btn btn-secondary btn-sm ac-todo-nav-btn"
              onClick={() => todoNav.onOpenNext(todoNav.next!.wuId)}
            >
              下一个 → {todoNav.next.label}
            </button>
          ) : (
            <span className="mc-drawer-note">待办都处理完了 <IconCheck size={12} /></span>
          )}
        </div>
      )}
      <div className="mc-drawer-body">
        {drawer.kind === 'wu'
          ? <WuDetail id={drawer.id} autoApprove={drawer.autoApprove === true} autoRuling={drawer.autoRuling === true} autoDirection={drawer.autoDirection === true} onOpenReq={onOpenReq} />
          : <ReqChain id={drawer.id} onOpenWu={onOpenWu} />}
      </div>
    </aside>
  );
}
