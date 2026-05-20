import { useMemo } from 'react';

export interface PieSlice {
  label: string;
  value: number;
  color: string;
}

interface PieChartProps {
  slices: PieSlice[];
  size?: number;
  title?: string;
  innerRadius?: number;
}

export function PieChart({ slices, size = 220, title, innerRadius = 0.5 }: PieChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 20;

  const paths = useMemo(() => {
    const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
    let cumAngle = -Math.PI / 2; // start at top

    return slices.map(s => {
      const angle = (s.value / total) * Math.PI * 2;
      const startAngle = cumAngle;
      const endAngle = cumAngle + angle;
      cumAngle = endAngle;

      const largeArc = angle > Math.PI ? 1 : 0;

      // Outer arc
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);

      // Inner arc
      const ir = r * innerRadius;
      const x3 = cx + ir * Math.cos(endAngle);
      const y3 = cy + ir * Math.sin(endAngle);
      const x4 = cx + ir * Math.cos(startAngle);
      const y4 = cy + ir * Math.sin(startAngle);

      const d = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${ir} ${ir} 0 ${largeArc} 0 ${x4} ${y4} Z`;

      // Label position (midpoint of arc)
      const midAngle = (startAngle + endAngle) / 2;
      const labelR = (r + ir) / 2;
      const lx = cx + labelR * Math.cos(midAngle);
      const ly = cy + labelR * Math.sin(midAngle);
      const pct = ((s.value / total) * 100).toFixed(0);

      return { d, color: s.color, label: s.label, value: s.value, pct, lx, ly };
    });
  }, [slices, cx, cy, r, innerRadius]);

  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: '12px', padding: '20px', border: '1px solid var(--border-default)' }}>
      {title && (
        <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
        </h3>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <svg width={size} height={size}>
          {paths.map((p, i) => (
            <g key={i}>
              <path d={p.d} fill={p.color} />
              {parseFloat(p.pct) > 5 && (
                <text x={p.lx} y={p.ly} textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="600" fill="white">
                  {p.pct}%
                </text>
              )}
            </g>
          ))}
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {paths.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '3px', background: p.color }} />
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                {p.label}: {p.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
