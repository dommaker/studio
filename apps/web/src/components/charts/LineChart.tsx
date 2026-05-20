import { useMemo } from 'react';

export interface DataPoint {
  label: string;
  value: number;
}

export interface LineSeries {
  name: string;
  data: DataPoint[];
  color: string;
}

interface LineChartProps {
  series: LineSeries[];
  width?: number;
  height?: number;
  title?: string;
}

export function LineChart({ series, width = 500, height = 240, title }: LineChartProps) {
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const { points, yTicks, xLabels, maxY } = useMemo(() => {
    const allValues = series.flatMap(s => s.data.map(d => d.value));
    const maxY = Math.max(...allValues, 1);
    const niceMax = Math.ceil(maxY / 5) * 5 || 5;
    const yTicks = Array.from({ length: 6 }, (_, i) => Math.round((niceMax / 5) * i));
    const xLabels = series[0]?.data.map(d => d.label) || [];

    const points = series.map(s =>
      s.data.map((d, i) => ({
        x: padding.left + (i / Math.max(s.data.length - 1, 1)) * chartW,
        y: padding.top + chartH - (d.value / niceMax) * chartH,
      }))
    );

    return { points, yTicks, xLabels, maxY: niceMax };
  }, [series, chartW, chartH]);

  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: '12px', padding: '20px', border: '1px solid var(--border-default)' }}>
      {title && (
        <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
        </h3>
      )}
      <svg width={width} height={height} style={{ overflow: 'visible' }}>
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

        {/* X labels */}
        {xLabels.map((label, i) => {
          const x = padding.left + (i / Math.max(xLabels.length - 1, 1)) * chartW;
          return (
            <text key={i} x={x} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
              {label}
            </text>
          );
        })}

        {/* Lines */}
        {series.map((s, si) => {
          const pts = points[si];
          if (!pts?.length) return null;
          const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
          return (
            <g key={si}>
              <path d={pathD} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="3" fill={s.color} />
              ))}
            </g>
          );
        })}

        {/* Legend */}
        {series.map((s, i) => (
          <g key={i} transform={`translate(${padding.left + i * 120}, ${height - 2})`}>
            <rect x={0} y={-8} width={10} height={10} rx={2} fill={s.color} />
            <text x={14} y={1} fontSize="11" fill="var(--text-secondary)">{s.name}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
