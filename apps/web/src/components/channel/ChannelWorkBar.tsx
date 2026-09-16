// ChannelWorkBar — 频道工作条：合并 ChannelLiveBars（#242/#322 live 实况）与
// ChannelStageBar（#440/#447 阶段条）为频道顶部单一工作条（docs/plans/2026-09-channel-workbar.md）。
// 渲染规则：
//   - 无 currentWu 且无 active WU → #474 占位（原整条静默消失，用户无法区分「真的没事」与
//     「状态还没拉到」）；#488 起占位分三态——wuIdle=true（建议端点已返回且 currentWuId=null）
//     → 空闲文案「频道暂无进行中的工作」；否则（端点未返回/请求失败/currentWuId 时序 skew 未命中）
//     → 加载态「状态同步中…」
//   - 无 currentWu（含 currentWuId 未命中 channelWus）→ fail-closed：主区不渲染，仅 live 列表
//   - 有 currentWu 无 active → 仅 stepper 主区
//   - 自身 active → 当前站旁叠加「第 N 步 · 动作」（点击开自身抽屉）
//   - 有其他 active → 「+N 进行中」chip，点击展开小列表（条目点击开对应抽屉）
// 阶段语义 = deriveDisplayState 展示列（与 WU 详情页同口径，不发明第二套阶段模型）；
// useChannelLiveExecutions 由本组件自持有（沿用 #322 重渲边界：step 事件只重渲本组件）。
// 批次 D-2 项6（频道内闸门 1 击化，docs/plans/2026-09-ui-interaction-polish.md）：currentWu 处于闸门态
// （pending / in_review / done 缺 l3）时工作条右端直挂共享 WuGateActions（btn-sm 紧凑动作，不离开消息流
// 完成闸门）；#545 起写路径内建于 WuGateActions（gateWriter 双写落点），本组件只挂载。
import { useState } from 'react';
import { deriveDisplayState, parseAttestations } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../../api/workunit';
import { useChannelLiveExecutions } from '../../hooks/useChannelLiveExecutions';
import { shortWuId } from '../../utils/id';
import { buildLifecycle, type WuStation } from '../../utils/wuLifecycle';
import { parseWuMeta } from '../../utils/wuMeta';
import type { LiveExecution } from '../workunit/execution-rows';
import { StationStepper } from '../workunit/StationStepper';
import { WuGateActions } from '../workunit/WuGateActions';
// stepper 样式类（wu-stepper-bar/wu-bstep/wu-st-*）定义在 wu-detail.css，顶层作用域可直接复用
import '../../styles/wu-detail.css';

interface Props {
  channelId: string | null;
  /** 频道当前工单（端点 currentWuId × channelWus；未命中 → null，主区 fail-closed 不渲染） */
  currentWu: WorkUnit | null;
  /** 点击条目 → 打开对应 WU 右抽屉 */
  onOpenWorkUnit: (workUnitId: string) => void;
  /** #488：空闲信号——调用方保证语义 = 建议端点已成功返回且 currentWuId=null（频道确实无工作）；
   *  缺省 false → 占位保持加载态「状态同步中…」（端点未返回/请求失败/skew 未命中均不误显空闲） */
  wuIdle?: boolean;
}

/** live 条目文案：WU 短 id + 正在执行 + 步号（缺省不显）+ 动作（缺省不显），沿用 #242 口径 */
function liveItemText(e: LiveExecution): string {
  return `${shortWuId(e.workUnitId)} 正在执行${e.step !== undefined ? ` · 第 ${e.step} 步` : ''}${e.action ? ` · ${e.action}` : ''}`;
}

function LiveItem({ exec, onOpenWorkUnit }: { exec: LiveExecution; onOpenWorkUnit: (id: string) => void }) {
  return (
    <button
      className="mc-workbar-item"
      onClick={() => onOpenWorkUnit(exec.workUnitId)}
      title={`打开 ${exec.workUnitId} 执行详情`}
    >
      <span className="mc-status mc-status-running"><span className="mc-dot" />进行中</span>
      <span>{liveItemText(exec)}</span>
    </button>
  );
}

export function ChannelWorkBar({ channelId, currentWu, onOpenWorkUnit, wuIdle = false }: Props) {
  const liveExecs = useChannelLiveExecutions(channelId);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // #474：未命中时不再整条静默消失——留占位条；#488：wuIdle 区分加载/空闲文案
  if (!currentWu && liveExecs.length === 0) {
    return (
      <div className="mc-workbar" aria-label="频道工作条">
        <div className="mc-workbar-placeholder">{wuIdle ? '频道暂无进行中的工作' : '状态同步中…'}</div>
      </div>
    );
  }

  const selfLive = currentWu ? liveExecs.find(e => e.workUnitId === currentWu.id) : undefined;
  const others = currentWu ? liveExecs.filter(e => e.workUnitId !== currentWu.id) : liveExecs;

  let stations: WuStation[] | null = null;
  // D-2 项6：闸门态判定与 WuGateActions 内部渲染分支同口径（非闸门态挂空壳防 flex 占位）
  let gateState = false;
  if (currentWu) {
    const derived = deriveDisplayState({ status: currentWu.status, metadata: currentWu.metadata });
    gateState = currentWu.status === 'pending' || currentWu.status === 'in_review'
      || (currentWu.status === 'done' && derived.needsHuman);
    stations = buildLifecycle(currentWu, derived, parseWuMeta(currentWu.metadata), parseAttestations(currentWu.metadata)).stations;
  }

  return (
    <div className="mc-workbar" aria-label="频道工作条">
      {currentWu && stations && (
        <div className="mc-workbar-main">
          {/* 2026-09 视觉层次批次：stepper 归属标识——进度条属于哪个任务一眼可辨，
              点击开 WU 抽屉（与站点/live 徽标统一入口） */}
          <button
            className="mc-workbar-wu"
            onClick={() => onOpenWorkUnit(currentWu.id)}
            title={`打开任务详情：${currentWu.id}`}
          >
            {shortWuId(currentWu.id)}
          </button>
          <div className="mc-workbar-stepper" aria-label="工单阶段">
            {/* E1：workbar 内站点可点（点击开对应 WU 抽屉，与 live 徽标统一入口）；
                StationStepper 与 WU 详情页共享——可点化仅经 onStationClick 作用域限定在此，详情页不传保持纯展示 */}
            <StationStepper stations={stations} onStationClick={() => onOpenWorkUnit(currentWu.id)} />
          </div>
          {selfLive && (
            <button
              className="mc-workbar-selflive"
              onClick={() => onOpenWorkUnit(currentWu.id)}
              title={`打开 ${currentWu.id} 执行详情`}
            >
              <span className="mc-status mc-status-running"><span className="mc-dot" />进行中</span>
              <span>
                {selfLive.step !== undefined ? `第 ${selfLive.step} 步` : '执行中'}
                {selfLive.action ? ` · ${selfLive.action}` : ''}
              </span>
            </button>
          )}
          {others.length > 0 && (
            <div className="mc-workbar-overflow">
              <button
                className="mc-workbar-chip"
                onClick={() => setOverflowOpen(o => !o)}
                aria-expanded={overflowOpen}
              >
                +{others.length} 进行中 {overflowOpen ? '▴' : '▾'}
              </button>
              {overflowOpen && (
                <div className="mc-workbar-overflow-list">
                  {others.map(e => (
                    <LiveItem key={e.workUnitId} exec={e} onOpenWorkUnit={onOpenWorkUnit} />
                  ))}
                </div>
              )}
            </div>
          )}
          {/* D-2 项6：闸门态 currentWu 的 1 击处置位（共享 WuGateActions；pending 锁存/失败内联/结构化
              确认弹窗均为组件自带；#545 起写路径内建 gateWriter——store 双写更新 channelWus，
              status_changed SSE 兜底） */}
          {gateState && currentWu && (
            <div className="mc-workbar-gate">
              <WuGateActions wu={currentWu} />
            </div>
          )}
        </div>
      )}
      {!currentWu && (
        <div className="mc-workbar-livelist">
          {liveExecs.map(e => (
            <LiveItem key={e.workUnitId} exec={e} onOpenWorkUnit={onOpenWorkUnit} />
          ))}
        </div>
      )}
    </div>
  );
}
