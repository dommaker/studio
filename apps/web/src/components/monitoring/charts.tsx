// charts — #398 监控页图表小组件（spec §7.4：div/CSS 手搓，零图表库，承 #396 TreeTokenChart 先例）
// 三件：UsageBar 预算用量条（封装开销 §7.3）/ DayBars byDay 柱图 / HBars 横条（缓存命中率 byRole）。
// 外观类 mc-chart-* 在 styles/mission-control.css；宽度/高度百分比走内联 style。

/** 阈值色：绿 = 预算内，黄 = 接近红线（≥70%），红 = 越线（>100%）——与 budgetColor 同口径 */
function usageColor(usedPct: number): string {
  if (usedPct > 100) return 'var(--error)';
  if (usedPct >= 70) return 'var(--warning)';
  return 'var(--accent-primary)';
}

/** 预算用量条：槽 + 百分比填充（封顶 100%）+ 可选说明小字 */
export function UsageBar({ usedPct, caption }: { usedPct: number; caption?: string }) {
  return (
    <div className="mc-usage-bar">
      <div className="mc-usage-bar-track">
        <span
          data-testid="usage-bar-fill"
          className="mc-usage-bar-fill"
          style={{ width: `${Math.min(usedPct, 100)}%`, background: usageColor(usedPct) }}
        />
      </div>
      {caption && <div className="mc-chart-caption">{caption}</div>}
    </div>
  );
}

export interface DayBarPoint {
  /** YYYY-MM-DD */
  day: string;
  /** 0–100 百分比；null = 当日无数据（空柱） */
  value: number | null;
}

/** byDay 柱图：柱高 = value%（固定高槽内），日期标签 MM-DD */
export function DayBars({ data }: { data: DayBarPoint[] }) {
  return (
    <div className="mc-daybars">
      {data.map(d => (
        <div key={d.day} className="mc-daybars-col">
          <div className="mc-daybars-slot">
            <span
              data-testid="day-bar-fill"
              className="mc-daybars-fill"
              style={{ height: `${d.value ?? 0}%` }}
            />
          </div>
          <span className="mc-daybars-label">{d.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

export interface HBarItem {
  label: string;
  /** 0–100 百分比；null → 空条 + N/A */
  value: number | null;
}

/** 横条：label 左、槽中、值右（0–100 口径直接作宽度） */
export function HBars({ data }: { data: HBarItem[] }) {
  return (
    <div className="mc-hbars">
      {data.map(d => (
        <div key={d.label} className="mc-hbars-row">
          <span className="mc-hbars-label">{d.label}</span>
          <span className="mc-hbars-track">
            <span data-testid="hbar-fill" className="mc-hbars-fill" style={{ width: `${d.value ?? 0}%` }} />
          </span>
          <span className="mc-hbars-value font-mono">{d.value !== null ? `${d.value}%` : 'N/A'}</span>
        </div>
      ))}
    </div>
  );
}
