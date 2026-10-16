// 拆分来源：pages/MonitoringPage.tsx「人工干预」MonitorSection 整块（纯 JSX 平移）
import { MonitorSection } from './MonitorSection';
import type { HumanInterventionMetrics } from '../../api/monitoring';

/** §7.3 新引入：人工干预北极星卡 */
export function InterventionSection({ intervention }: { intervention: HumanInterventionMetrics }) {
  return (
    <MonitorSection
      title="人工干预"
      subtitle="每完成一个任务，平均需要人插手几次"
      stat={intervention.avgPerCompletedWu !== null ? Math.round(intervention.avgPerCompletedWu * 100) / 100 : 'N/A'}
      statTestId="intervention-stat"
    >
      <div className="text-xs u-text-2">
        窗口内完成 {intervention.completedWorkUnits} 个任务
        · NEED_INPUT 挂起 {intervention.needInputCount} 次
        · review 驳回 {intervention.reviewRejections} 次
        · 合并冲突转人工 {intervention.mergeConflicts} 次
      </div>
    </MonitorSection>
  );
}
