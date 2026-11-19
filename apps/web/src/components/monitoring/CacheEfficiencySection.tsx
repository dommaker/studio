// 拆分来源：pages/MonitoringPage.tsx「输入缓存命中率」区块整块（含外层 error 三元，纯 JSX 平移）
import { SectionError } from '../ui';
import { MonitorSection } from './MonitorSection';
import { DayBars, HBars } from './charts';
import type { CacheHitRateStats } from '../../api/monitoring';

/** #120: 输入缓存命中率；§7.3 图表化 = byDay 柱 + byRole 横条（时间序列仅 byDay 一组可用，§7.1） */
export function CacheEfficiencySection({ cacheHit, error, onRetry }: { cacheHit: CacheHitRateStats | null; error: string | null; onRetry: () => void }) {
  return error ? (
    <SectionError error={error} onRetry={onRetry} />
  ) : cacheHit && (
    <MonitorSection
      title="输入缓存命中率"
      subtitle="重复内容有没有被缓存省下 token"
      stat={cacheHit.source === 'events'
        ? (cacheHit.overall.hitRatePct !== null ? `${cacheHit.overall.hitRatePct}%` : 'N/A')
        : undefined}
      statTestId="cache-stat"
    >
      {cacheHit.source === 'events' ? (
        <>
          {cacheHit.byDay.length > 0 && (
            <div>
              <div className="text-sm u-text-3 mb-1">按天</div>
              <DayBars data={cacheHit.byDay.map(d => ({ day: d.day, value: d.hitRatePct }))} />
            </div>
          )}
          {cacheHit.byRole.length > 0 && (
            <div className="mt-3">
              <div className="text-sm u-text-3 mb-1">按角色</div>
              <HBars data={cacheHit.byRole.map(r => ({ label: r.profileName, value: r.hitRatePct }))} />
            </div>
          )}
          <div className="mt-2 text-xs u-text-2">
            缓存读取 {cacheHit.overall.cacheReadTokens} / 输入 {cacheHit.overall.inputTokens} tokens
            · 覆盖率 {cacheHit.coveragePct}%
            {cacheHit.coveragePct < 100 && '（部分执行无 CLI usage 回报，命中率口径不含这些事件）'}
          </div>
        </>
      ) : (
        <div className="text-sm u-text-2">暂无带缓存字段的 workunit:tokens 事件，命中率数据不足</div>
      )}
    </MonitorSection>
  );
}
