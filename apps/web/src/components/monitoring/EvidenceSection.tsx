// 拆分来源：pages/MonitoringPage.tsx「证据台账（信任分层）」MonitorSection 整块（纯 JSX 平移）
import { StatCard } from '../ui';
import { MonitorSection } from './MonitorSection';
import type { EvidenceStats } from '../../api/monitoring';

/** F6 证据台账（决策 1）：信任分层达成 + 双轨比对；§7.3 stat 减卡 7→5 */
export function EvidenceSection({ evidence }: { evidence: EvidenceStats }) {
  return (
    <MonitorSection
      title="证据台账（信任分层）"
      subtitle="每个任务有多少人/机器确认过"
      stat={evidence.engaged > 0 ? `${Math.round((evidence.l3Approved / evidence.engaged) * 100)}%` : 'N/A'}
      statTestId="evidence-stat"
    >
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="自动验证" value={evidence.l1Approved} color="u-ok" variant="inline" />
        <StatCard label="Agent 评审" value={evidence.l2Approved} color="u-ok" variant="inline" />
        <StatCard label="人工确认" value={evidence.l3Approved} color="u-ok" variant="inline" />
        {/* #472：待人工确认 warning（非真错误，error 红留给 blocked/failed） */}
        <StatCard label="待人工确认" value={evidence.needsHuman} color="u-warn" variant="inline" />
        <StatCard label="状态不一致" value={evidence.derivedMismatch} color="u-warn" variant="inline" />
      </div>
      <p className="text-xs u-text-3 mt-2">
        主数字 = 已验收任务占比（人工确认 ÷ 已介入 {evidence.engaged} 个任务）；
        状态不一致 = 界面显示状态与实际记录不符的任务数（验证期指标，持续为 0 才可信）；
        合并记录分歧 {evidence.mergeDivergence}，完成缺合并回执 {evidence.doneWithoutReceipt}
      </p>
    </MonitorSection>
  );
}
