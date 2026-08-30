// MonitoringPage — Agent Network MVP-6；#180 Tab 化「概览 / 事件检索」（#60 决策 Q3a）
// #398 重构（spec redesign-2026-08 §7）：首屏 = 行动面（需要处理 + 知识提案待审）；
// 度量降下方「健康度量」默认折叠分区。删 WU 状态分布/Agent 状态/最近 24h/段 trim 四区块（§7.3）。
// 文案按 §7.5：术语标题 + 大白话副标题 + 每区一个 22px 主数字。不扩监控 API。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { monitoringApi } from '../api/monitoring';
import { knowledgeApi } from '../api/knowledge';
import { EventSearchPanel } from '../components/monitoring/EventSearchPanel';
import { NeedsAttentionSection } from '../components/monitoring/NeedsAttentionSection';
import { MonitorSection } from '../components/monitoring/MonitorSection';
import { UsageBar, DayBars, HBars } from '../components/monitoring/charts';
import { useAsyncData } from '../hooks/useAsyncData';
import { formatAge } from '@dommaker/studio-shared/web';

type MonitoringTab = 'overview' | 'events';

export function MonitoringPage() {
  const [activeTab, setActiveTab] = useState<MonitoringTab>('overview');
  // 健康度量分区默认折叠（§7.2：度量区整体降为下方分区）
  const [metricsOpen, setMetricsOpen] = useState(false);
  // #350 useAsyncData 收一次性拉取样板：各区块独立加载、失败静默（fetcher 内 catch 落 null，区块内提示）
  const overviewQ = useAsyncData(() => monitoringApi.getOverview().then(r => r.data).catch(() => null), []);
  const flywheelQ = useAsyncData(() => monitoringApi.getFlywheel().then(r => r.data).catch(() => null), []);
  const overheadQ = useAsyncData(() => monitoringApi.getOverhead().then(r => r.data).catch(() => null), []);
  const efficiencyQ = useAsyncData(() => monitoringApi.getEfficiency().then(r => r.data).catch(() => null), []);
  // 审核闭环：proposal 待审列表（maturity=draft，与 proposalsPendingReview 计数同库口径）
  const proposalsQ = useAsyncData(() => knowledgeApi.listPendingReview().then(r => r.data.entries).catch(() => null), []);
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());

  const overview = overviewQ.data;
  const evidence = overview?.evidence ?? null;
  const roles = overview?.roles.roles ?? null;
  const intervention = overview?.humanIntervention ?? null;
  const flywheel = flywheelQ.data;
  const overhead = overheadQ.data;
  const efficiency = efficiencyQ.data;
  const cacheHit = efficiency?.cacheHitRate ?? null;
  const proposals = proposalsQ.data;

  const refresh = () => {
    overviewQ.reload();
    flywheelQ.reload();
    overheadQ.reload();
    efficiencyQ.reload();
    proposalsQ.reload();
  };

  // 一键 approve：draft → verified（参与注入）；成功后移出列表
  const approveProposal = async (entryId: string) => {
    setApprovingIds(prev => new Set(prev).add(entryId));
    try {
      await knowledgeApi.promote(entryId);
      proposalsQ.setData(prev => (prev ? prev.filter(p => p.id !== entryId) : prev));
      flywheelQ.reload();
    } catch { /* 保留在列表中，可重试 */ } finally {
      setApprovingIds(prev => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">监控</h1>
            <p className="page-subtitle">Agent Network 运营度量</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={refresh}>刷新</button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>
      </div>

      {/* #180：概览 / 事件检索 Tab（IA：行动信号 > 健康度量 > 参考资料） */}
      <div className="px-8 pt-3 flex gap-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {([['overview', '概览'], ['events', '事件检索']] as Array<[MonitoringTab, string]>).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-4 py-2 text-sm rounded-t-lg transition ${activeTab === id ? 'u-surface u-accent' : 'u-text-3'}`}
            style={{ borderBottom: activeTab === id ? '2px solid var(--accent-primary)' : '2px solid transparent' }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'events' ? (
        <div className="flex-1 overflow-auto px-8 pb-8">
          <div className="max-w-5xl">
            <EventSearchPanel />
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {/* 行动面（§7.2 首屏）：需要处理（#184 独立加载）+ 知识提案待审（全页唯一可操作列表，上移） */}
          <div className="space-y-4 mt-4">
            <NeedsAttentionSection />

            <MonitorSection
              title="知识提案待审"
              subtitle="Agent 提炼的新知识，等你确认"
              stat={proposals === null ? undefined : proposals.length}
              statTestId="proposals-stat"
            >
              {proposals === null ? (
                <div className="text-sm u-text-2">待审列表不可用</div>
              ) : proposals.length === 0 ? (
                <div className="text-sm u-text-2">无待审提案（提取产物以 draft 入库，审核通过后才参与注入）</div>
              ) : (
                <div className="space-y-2">
                  {proposals.map(p => (
                    <div key={p.id} className="flex items-center gap-3 text-sm">
                      <span className="u-text" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.title}
                      </span>
                      <span className="text-xs u-text-3">{formatAge(p.created)}</span>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={approvingIds.has(p.id)}
                        onClick={() => approveProposal(p.id)}
                      >
                        {approvingIds.has(p.id) ? '处理中…' : '通过'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </MonitorSection>
          </div>

          {/* 健康度量（§7.2：度量区降为下方分区，默认折叠） */}
          <div className="mt-6">
            <button
              className="flex items-center gap-2 u-text-2 u-hover-accent"
              aria-expanded={metricsOpen}
              onClick={() => setMetricsOpen(v => !v)}
            >
              <span className="text-xs">{metricsOpen ? '▾' : '▸'}</span>
              <span className="mc-block-label" style={{ margin: 0 }}>健康度量</span>
            </button>

            {metricsOpen && (
            <div className="space-y-4 mt-3">
              {/* F6 证据台账（决策 1）：信任分层达成 + 双轨比对；§7.3 stat 减卡 7→5 */}
              {evidence && (
                <MonitorSection
                  title="证据台账（信任分层）"
                  subtitle="每个任务有多少人/机器确认过"
                  stat={evidence.engaged > 0 ? `${Math.round((evidence.l3Approved / evidence.engaged) * 100)}%` : 'N/A'}
                  statTestId="evidence-stat"
                >
                  <div className="grid grid-cols-4 gap-3">
                    <StatCard label="L1 自动验证" value={evidence.l1Approved} color="u-ok" />
                    <StatCard label="L2 agent 评审" value={evidence.l2Approved} color="u-ok" />
                    <StatCard label="L3 人工确认" value={evidence.l3Approved} color="u-ok" />
                    <StatCard label="待人工确认" value={evidence.needsHuman} color="u-err" />
                    <StatCard label="双轨偏差" value={evidence.derivedMismatch} color="u-warn" />
                  </div>
                  <p className="text-xs u-text-3 mt-2">
                    主数字 = 已验收任务占比（L3 人工确认 ÷ 已介入 {evidence.engaged} 个任务）；
                    双轨偏差 = 派生列与存储状态不一致的 WU 数（验证期指标，持续为 0 才可停止手写 in_review）
                  </p>
                </MonitorSection>
              )}

              {/* M1: 飞轮指标；§7.3 stat 减卡到 hitRate / improvement / 待审 */}
              <MonitorSection
                title="飞轮指标"
                subtitle="系统有没有越用越聪明"
                stat={flywheel ? `${flywheel.hitRate}%` : undefined}
                statTestId="flywheel-stat"
              >
                {flywheel ? (
                  <>
                    <div className="grid grid-cols-4 gap-3">
                      <StatCard label="知识命中率" value={`${flywheel.hitRate}%`} color="u-accent" />
                      <StatCard
                        label="成功率变化"
                        value={`${flywheel.improvement > 0 ? '+' : ''}${flywheel.improvement}pp`}
                        color={flywheel.improvement > 0 ? 'u-ok' : flywheel.improvement < 0 ? 'u-err' : 'u-text-3'}
                      />
                      <StatCard
                        label="proposal 待审"
                        value={flywheel.proposalsPendingReview}
                        color={flywheel.proposalsPendingReview > 0 ? 'u-warn' : 'u-text-3'}
                      />
                    </div>
                    {flywheel.source === 'insufficient-data' && (
                      <div className="mt-2 text-xs u-text-2">事件数据不足：hitRate / 成功率变化为 0 占位而非实测</div>
                    )}
                  </>
                ) : (
                  <div className="text-sm u-text-2">飞轮指标不可用</div>
                )}
              </MonitorSection>

              {/* M2: 封装开销 → §7.3 图表化为预算用量条（承 §5.4 Token 面板模式） */}
              <MonitorSection
                title="注入预算占用"
                subtitle="每次执行任务，背景注入占了多少上下文预算"
                stat={overhead && overhead.source === 'events' ? `${overhead.injectedBudgetUsedPct}%` : undefined}
                statTestId="overhead-stat"
              >
                {overhead && overhead.source === 'events' ? (
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

              {/* #120: 输入缓存命中率；§7.3 图表化 = byDay 柱 + byRole 横条（时间序列仅 byDay 一组可用，§7.1） */}
              {cacheHit && (
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
              )}

              {/* §7.3 新引入：角色效率表格（claims/完成/均时/NEED_INPUT 拆分） */}
              {roles && roles.length > 0 && (
                <MonitorSection title="角色效率" subtitle="每个角色认领、完成了多少任务、平均多久">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs u-text-3 text-left">
                        <th className="py-1 font-normal">角色</th>
                        <th className="py-1 font-normal">认领</th>
                        <th className="py-1 font-normal">完成</th>
                        <th className="py-1 font-normal">平均时长</th>
                        <th className="py-1 font-normal">提问（澄清/执行）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map(r => (
                        <tr key={r.profileId} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td className="py-1 u-text">{r.profileName}</td>
                          <td className="py-1 font-mono">{r.claims}</td>
                          <td className="py-1 font-mono">{r.completions}</td>
                          <td className="py-1 font-mono">{r.avgDurationHours !== null ? `${Math.round(r.avgDurationHours * 10) / 10}h` : 'N/A'}</td>
                          <td className="py-1 font-mono">{r.needInputClarify} / {r.needInputExecution}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </MonitorSection>
              )}

              {/* §7.3 新引入：人工干预北极星卡 */}
              {intervention && (
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
              )}
            </div>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`font-bold ${color}`} style={{ fontSize: 'var(--fs-title)' }}>{value}</span>
      <span className="text-sm u-text-2">{label}</span>
    </div>
  );
}
