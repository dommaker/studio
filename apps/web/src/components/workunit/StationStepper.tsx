// StationStepper / LifecycleEventChips — #396 WU 详情页顶部共享定位条（spec §5.1/§5.3）
// 横向四站：连线贯穿 + 已完成 accent 实心 + 当前站描边高亮 + 时间戳在站名下方；
// 关键事件 = stepper 下一行横排 chip（色点 + 文字 + mono 时间），无事件不占行。
// 数据全部来自 utils/wuLifecycle 纯函数，本文件只做渲染。
import type { WuKeyEvent, WuStation } from '../../utils/wuLifecycle';
import { formatShortTime } from '../../utils/datetime';

export function StationStepper({ stations }: { stations: WuStation[] }) {
  return (
    <div className="wu-stepper-bar">
      {stations.map((st, i) => (
        <div key={st.id} style={{ display: 'contents' }}>
          <div className={`wu-bstep wu-st-${st.state}`}>
            <div className="wu-bstep-head">
              <span className="wu-st-dot" />
              <span className="wu-st-label">{st.label}</span>
            </div>
            <span className="wu-st-time">{formatShortTime(st.time)}</span>
          </div>
          {i < stations.length - 1 && (
            <div className={`wu-bstep-line${stations[i].state === 'done' ? ' wu-bstep-line-reached' : ''}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export function LifecycleEventChips({ events }: { events: WuKeyEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="wu-chips">
      {events.map(ev => (
        <span key={ev.id} className={`wu-chip wu-ev-${ev.tone}`} title={ev.detail}>
          <span className="wu-chip-dot" />
          <span className="wu-chip-label">{ev.label}</span>
          <span className="wu-chip-time">{formatShortTime(ev.time)}</span>
        </span>
      ))}
    </div>
  );
}
