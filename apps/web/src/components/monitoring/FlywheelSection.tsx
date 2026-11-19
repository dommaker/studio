// 拆分来源：pages/MonitoringPage.tsx「学习成效」MonitorSection 整块（纯 JSX 平移，
// 错误行/加载不可用文案/数据体三分支原样保留）
import { StatCard, SectionError } from '../ui';
import { MonitorSection } from './MonitorSection';
import type { FlywheelStats } from '../../api/monitoring';

/** M1: 飞轮指标；§7.3 stat 减卡到 hitRate / improvement / 待审；#473 标题白话化（L1/L2/L3 不上界面先例） */
export function FlywheelSection({ flywheel, error, onRetry }: { flywheel: FlywheelStats | null; error: string | null; onRetry: () => void }) {
  return (
    <MonitorSection
      title="学习成效"
      subtitle="系统有没有越用越聪明"
      stat={flywheel ? `${flywheel.hitRate}%` : undefined}
      statTestId="flywheel-stat"
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} />
      ) : flywheel ? (
        <>
          <div className="grid grid-cols-4 gap-3">
            <StatCard label="知识命中率" value={`${flywheel.hitRate}%`} color="u-accent" variant="inline" />
            <StatCard
              label="成功率变化"
              value={`${flywheel.improvement > 0 ? '+' : ''}${flywheel.improvement}pp`}
              color={flywheel.improvement > 0 ? 'u-ok' : flywheel.improvement < 0 ? 'u-err' : 'u-text-3'}
              variant="inline"
            />
            <StatCard
              label="待审提案"
              value={flywheel.proposalsPendingReview}
              color={flywheel.proposalsPendingReview > 0 ? 'u-warn' : 'u-text-3'}
              variant="inline"
            />
          </div>
          {flywheel.source === 'insufficient-data' && (
            <div className="mt-2 text-xs u-text-2">事件数据不足：命中率 / 成功率变化为 0 占位而非实测</div>
          )}
        </>
      ) : (
        <div className="text-sm u-text-2">学习成效数据不可用</div>
      )}
    </MonitorSection>
  );
}
