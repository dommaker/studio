// 拆分来源：pages/MonitoringPage.tsx「注入预算占用」MonitorSection 整块（纯 JSX 平移）
import { SectionError } from '../ui';
import { MonitorSection } from './MonitorSection';
import { UsageBar } from './charts';
import type { OverheadStats } from '../../api/monitoring';

/** M2: 封装开销 → §7.3 图表化为预算用量条（承 §5.4 Token 面板模式） */
export function OverheadSection({ overhead, error, onRetry }: { overhead: OverheadStats | null; error: string | null; onRetry: () => void }) {
  return (
    <MonitorSection
      title="注入预算占用"
      subtitle="每次执行任务，背景注入占了多少上下文预算"
      stat={overhead && overhead.source === 'events' ? `${overhead.injectedBudgetUsedPct}%` : undefined}
      statTestId="overhead-stat"
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} />
      ) : overhead && overhead.source === 'events' ? (
        <>
          <UsageBar
            usedPct={overhead.injectedBudgetUsedPct}
            caption={`平均注入 ${overhead.avgInjectedTokens} / 红线 ${overhead.injectedBudget} tokens（统计 ${overhead.executions} 次执行，覆盖率 ${overhead.executionCoveragePct}%）`}
          />
          <div className="mt-2 text-xs u-text-2">
            开销比 = 注入估算 / 执行 tokens：{overhead.avgOverheadRatio !== null ? `${Math.round(overhead.avgOverheadRatio * 1000) / 10}%` : 'N/A'}
            （红线 {Math.round(overhead.overheadBudget * 100)}%，仅统计 CLI 回报 usage 的执行）；
            平均执行 {overhead.avgExecutionTokens ?? 'N/A'} tokens；提取开销单独核算（{overhead.extractionTokens} tokens / {overhead.windowDays}d），不计入注入红线
          </div>
        </>
      ) : (
        <div className="text-sm u-text-2">暂无 workunit:tokens 事件，开销数据不足</div>
      )}
    </MonitorSection>
  );
}
