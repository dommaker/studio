// ChannelWorkBar — 频道工作条：合并 ChannelLiveBars（#242/#322 live 实况）与
// ChannelStageBar（#440/#447 阶段条）为频道顶部单一工作条（docs/plans/2026-09-channel-workbar.md）。
// 渲染规则：
//   - 无 currentWu 且无 active WU → 不渲染（沿用两条旧带的零占位语义）
//   - 无 currentWu（含 currentWuId 未命中 channelWus）→ fail-closed：主区不渲染，仅 live 列表
//   - 有 currentWu 无 active → 仅 stepper 主区
//   - 自身 active → 当前站旁叠加「第 N 步 · 动作」（点击开自身抽屉）
//   - 有其他 active → 「+N 进行中」chip，点击展开小列表（条目点击开对应抽屉）
// 阶段语义 = deriveDisplayState 展示列（与 WU 详情页同口径，不发明第二套阶段模型）；
// useChannelLiveExecutions 由本组件自持有（沿用 #322 重渲边界：step 事件只重渲本组件）。
import { useState } from 'react';
import { deriveDisplayState, parseAttestations } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../../api/workunit';
import { useChannelLiveExecutions } from '../../hooks/useChannelLiveExecutions';
import { shortWuId } from '../../utils/id';
import { buildLifecycle, type WuStation } from '../../utils/wuLifecycle';
import { parseWuMeta } from '../../utils/wuMeta';
import type { LiveExecution } from '../workunit/execution-rows';
import { StationStepper } from '../workunit/StationStepper';
// stepper 样式类（wu-stepper-bar/wu-bstep/wu-st-*）定义在 wu-detail.css，顶层作用域可直接复用
import '../../styles/wu-detail.css';

interface Props {
  channelId: string | null;
  /** 频道当前工单（端点 currentWuId × channelWus；未命中 → null，主区 fail-closed 不渲染） */
  currentWu: WorkUnit | null;
  /** 点击条目 → 打开对应 WU 右抽屉 */
  onOpenWorkUnit: (workUnitId: string) => void;
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

export function ChannelWorkBar({ channelId, currentWu, onOpenWorkUnit }: Props) {
  const liveExecs = useChannelLiveExecutions(channelId);
  const [overflowOpen, setOverflowOpen] = useState(false);
  if (!currentWu && liveExecs.length === 0) return null;

  const selfLive = currentWu ? liveExecs.find(e => e.workUnitId === currentWu.id) : undefined;
  const others = currentWu ? liveExecs.filter(e => e.workUnitId !== currentWu.id) : liveExecs;

  let stations: WuStation[] | null = null;
  if (currentWu) {
    const derived = deriveDisplayState({ status: currentWu.status, metadata: currentWu.metadata });
    stations = buildLifecycle(currentWu, derived, parseWuMeta(currentWu.metadata), parseAttestations(currentWu.metadata)).stations;
  }

  return (
    <div className="mc-workbar" aria-label="频道工作条">
      {currentWu && stations && (
        <div className="mc-workbar-main">
          <div className="mc-workbar-stepper" aria-label="工单阶段">
            <StationStepper stations={stations} />
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
