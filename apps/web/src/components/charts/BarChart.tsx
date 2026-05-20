import { useMemo } from 'react';

export interface BarItem {
  label: string;
  value: number;
  color: string;
}

interface BarChartProps {
  items: BarItem[];
  width?: number;
  height?: number;
  title?: string;
}

export function BarChart({ items, width = 500, height = 240, title }: BarChartProps) {
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const { bars, yTicks, maxY } = useMemo(() => {
    const maxVal = Math.max(...items.map(i => i.value), 1);
    const niceMax = Math.ceil(maxVal / 5) * 5 || 5;
    const yTicks = Array.from({ length: 6 }, (_, i) => Math.round((niceMax / 5) * i));

    const barWidth = Math.min(40, (chartW / items.length) * 0.6);
    const gap = (chartW / items.length - barWidth) / 2;

    const bars = items.map((item, i) => {
      const x = padding.left + i * (chartW / items.length) + gap;
      const barH = (item.value / niceMax) * chartH;
      const y = padding.top + chartH - barH;
      return { x, y, width: barWidth, height: barH, color: item.color, label: item.label, value: item.value };
    });

    return { bars, yTicks, maxY: niceMax };
  }, [items, chartW, chartH]);

  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: '12px', padding: '20px', border: '1px solid var(--border-default)' }}>
      {title && (
        <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
        </h3>
      )}
      <svg width={width} height={height}>
        {/* Grid lines */}
        {yTicks.map((v, i) => {
          const y = padding.top + chartH - (v / maxY) * chartH;
          return (
            <g key={i}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="var(--border-default)" strokeDasharray="3,3" />
              <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">{v}</text>
            </g>
          );
        })}

        {/* Bars */}
        {bars.map((bar, i) => (
          <g key={i}>
            <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={4} fill={bar.color} />
            {bar.height > 20 && (
              <text x={bar.x + bar.width / 2} y={bar.y + 16} textAnchor="middle" fontSize="11" fontWeight="600" fill="white">
                {bar.value}
              </text>
            )}
            <text x={bar.x + bar.width / 2} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
              {bar.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
