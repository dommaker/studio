// 频道 live 执行状态条（#242；#322 live 执行状态下沉）：useChannelLiveExecutions 由本组件
// 自持有（原调用点在 ChannelDetailPage）——workunit.execution.step 事件只重渲本组件边界，
// 不再触发 ChannelDetailPage 整树重渲。渲染/交互语义与原页面内 JSX 一致（过程明细仍在抽屉）。
import { useChannelLiveExecutions } from '../../hooks/useChannelLiveExecutions';
import { shortWuId } from '../../utils/id';

interface Props {
  channelId: string | null;
  /** 点击状态条 → 打开对应 WU 右抽屉 */
  onOpenWorkUnit: (workUnitId: string) => void;
}

export function ChannelLiveBars({ channelId, onOpenWorkUnit }: Props) {
  const liveExecs = useChannelLiveExecutions(channelId);
  if (liveExecs.length === 0) return null;
  return (
    <div className="mc-livebars">
      <div className="mc-livebars-inner">
        {liveExecs.map(e => (
          <button
            key={e.workUnitId}
            className="mc-livebar"
            onClick={() => onOpenWorkUnit(e.workUnitId)}
            title={`打开 ${e.workUnitId} 执行详情`}
          >
            <span className="mc-status mc-status-running"><span className="mc-dot" />执行中</span>
            <span>
              {shortWuId(e.workUnitId)} 正在执行
              {e.step !== undefined ? ` · 第 ${e.step} 步` : ''}
              {e.action ? ` · ${e.action}` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
