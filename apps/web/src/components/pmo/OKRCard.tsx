// OKR 卡片 — 标题 / 季度 / 进度 + B8 KR 列表（从 pages/PMOPage.tsx 抽出，纯代码移动）
import type { KR, OKR } from './types';

interface OKRCardProps {
  okr: OKR;
}

export function OKRCard({ okr }: OKRCardProps) {
  return (
    <div
      className="card p-3"
    >
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="font-medium u-text">
            {okr.title}
          </div>
          <div className="text-xs u-text-3">
            {okr.quarter} · {okr.projectCount} 个项目
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-ok">
              {Math.round(okr.progress * 100)}%
            </div>
            <div className="text-xs u-text-3">
              进度
            </div>
          </div>
        </div>
      </div>
      {/* 🆕 B8: KR 列表 */}
      {okr.keyResults && okr.keyResults.length > 0 && (
        <div className="space-y-1 mt-2 pt-2 border-t u-border">
          {okr.keyResults.map((kr: KR) => (
            <div key={kr.id} className="flex items-center justify-between text-xs">
              <span className="u-text-2">
                {kr.title}
                {kr.metricType && (
                  <span className="ml-1 px-1 py-0.5 rounded u-accent-dim" style={{ fontSize: 'var(--fs-xs)' }}>
                    auto
                  </span>
                )}
              </span>
              <span className="font-mono u-text-3">
                {kr.current}/{kr.target}{kr.unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
