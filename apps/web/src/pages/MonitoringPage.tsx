// MonitoringPage — Agent Network MVP-6；#180 Tab 化「概览 / 事件检索」（#60 决策 Q3a）
// #398 重构（spec redesign-2026-08 §7）：首屏 = 行动面（需要处理 + 知识提案待审）；
// 度量降下方「健康度量」默认折叠分区。删 WU 状态分布/Agent 状态/最近 24h/段 trim 四区块（§7.3）。
// 文案按 §7.5：术语标题 + 大白话副标题 + 每区一个 22px 主数字。不扩监控 API。
// Phase 3 拆分（2026-10）：提案待审区/六个度量区抽 components/monitoring/ 子组件，
// SectionError 收敛 components/ui/（拆分来源见各子组件头注释），本文件留数据接线 + tab 骨架。
import { useEffect, useState } from 'react';
import { monitoringApi } from '../api/monitoring';
import { knowledgeApi } from '../api/knowledge';
import { SectionError } from '../components/ui';
import { EventSearchPanel, type EventSearchFilters } from '../components/monitoring/EventSearchPanel';
import { NeedsAttentionSection } from '../components/monitoring/NeedsAttentionSection';
import { PendingProposalsSection } from '../components/monitoring/PendingProposalsSection';
import { EvidenceSection } from '../components/monitoring/EvidenceSection';
import { FlywheelSection } from '../components/monitoring/FlywheelSection';
import { OverheadSection } from '../components/monitoring/OverheadSection';
import { CacheEfficiencySection } from '../components/monitoring/CacheEfficiencySection';
import { RolesEfficiencySection } from '../components/monitoring/RolesEfficiencySection';
import { InterventionSection } from '../components/monitoring/InterventionSection';
import { alertSignatureKeyword, type AlertGroup } from '../components/monitoring/alertGrouping';
import { useAsyncData } from '../hooks/useAsyncData';
import { useMonitoringStore } from '../stores/monitoringStore';
import { toast } from '../utils/toast';
import { serverErrorMessage } from '../utils/errorMessage';

type MonitoringTab = 'overview' | 'events';

export function MonitoringPage() {
  const [activeTab, setActiveTab] = useState<MonitoringTab>('overview');
  // E4 告警下钻：点击告警组 → 事件检索 tab 预填该签名过滤（面板随 tab 重挂时经 initialFilters 消费）
  const [eventSeed, setEventSeed] = useState<EventSearchFilters | null>(null);
  // 健康度量分区默认折叠（§7.2：度量区整体降为下方分区）
  const [metricsOpen, setMetricsOpen] = useState(false);
  const overview = useMonitoringStore(s => s.overview);
  const overviewError = useMonitoringStore(s => s.overviewError);
  const overviewLoadedAt = useMonitoringStore(s => s.overviewLoadedAt);
  const overviewInflight = useMonitoringStore(s => s.overviewInflight);
  const loadOverview = useMonitoringStore(s => s.loadOverview);
  useEffect(() => { void loadOverview(); }, [loadOverview]);
  const overviewQ = {
    data: overview,
    error: overviewError?.message ?? null,
    loading: overviewInflight !== null || (overviewLoadedAt === null && !overviewError),
    reload: () => void loadOverview({ maxAgeMs: 0 }),
  };
  const flywheelQ = useAsyncData(() => monitoringApi.getFlywheel().then(r => r.data.data), []);
  const overheadQ = useAsyncData(() => monitoringApi.getOverhead().then(r => r.data.data), []);
  const efficiencyQ = useAsyncData(() => monitoringApi.getEfficiency().then(r => r.data.data), []);
  // 审核闭环：proposal 待审列表（maturity=draft，与 proposalsPendingReview 计数同库口径）
  // 契约驱动迁移（批次 4/7）：响应统一 `{ data }` 壳，r.data.entries → r.data.data.entries
  const proposalsQ = useAsyncData(() => knowledgeApi.listPendingReview().then(r => r.data.data.entries), []);
  // 批次A 项8：通过/拒绝共用 pending 锁存（防连点）+ 失败 toast（原 catch 静默）
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());
  // #473：审批前可见详情（点击标题展开）+ 通过两步确认
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [armedIds, setArmedIds] = useState<Set<string>>(new Set());

  const evidence = overview?.evidence ?? null;
  const roles = overview?.roles.roles ?? null;
  const intervention = overview?.humanIntervention ?? null;
  const flywheel = flywheelQ.data;
  const overhead = overheadQ.data;
  const efficiency = efficiencyQ.data;
  const cacheHit = efficiency?.cacheHitRate ?? null;
  const proposals = proposalsQ.data;
  // 批次A 项8：刷新按钮 loading（任一分区在拉即视为刷新中）
  const refreshing = overviewQ.loading || flywheelQ.loading || overheadQ.loading || efficiencyQ.loading || proposalsQ.loading;

  /** E4 告警下钻：点击告警组 → 事件检索 tab，预填 type=monitor:alert + 签名关键词（告警与收件箱同 warning 级口径） */
  const drillIntoAlert = (g: AlertGroup) => {
    const keyword = alertSignatureKeyword(g.message);
    setEventSeed({ type: 'monitor:alert', level: 'warning', ...(keyword ? { keyword } : {}) });
    setActiveTab('events');
  };

  /** 手动切 tab：回概览时清掉下钻预填，防旧 seed 在下次进事件检索时重放 */
  const switchTab = (t: MonitoringTab) => {
    if (t === 'overview') setEventSeed(null);
    setActiveTab(t);
  };

  const refresh = () => {
    overviewQ.reload();
    flywheelQ.reload();
    overheadQ.reload();
    efficiencyQ.reload();
    proposalsQ.reload();
  };

  /** 提案审批统一入口：approve=promote（draft→verified）/ reject=demote（draft→archived）；成功后移出列表 */
  const actOnProposal = async (entryId: string, action: 'approve' | 'reject') => {
    setActingIds(prev => new Set(prev).add(entryId));
    try {
      if (action === 'approve') await knowledgeApi.promote(entryId);
      else await knowledgeApi.demote(entryId);
      proposalsQ.setData(prev => (prev ? prev.filter(p => p.id !== entryId) : prev));
      flywheelQ.reload();
    } catch (e) {
      // 保留在列表中可重试 + toast 提示（服务端 error.message 优先）
      const m = serverErrorMessage(e);
      const verb = action === 'approve' ? '通过' : '拒绝';
      toast.error(m ? `${verb}失败：${m}` : `${verb}失败，请重试`);
    } finally {
      setActingIds(prev => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
      // #473：结算后解除待确认态（失败可从头重试）
      setArmedIds(prev => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  };

  /** #473 两步确认：首次点击仅进待确认态（按钮改文案），再次点击才执行 */
  const clickApprove = (entryId: string) => {
    if (!armedIds.has(entryId)) {
      setArmedIds(prev => new Set(prev).add(entryId));
      return;
    }
    void actOnProposal(entryId, 'approve');
  };

  /** #473：点击标题展开/收起详情（类型/标签/提交时间），审前先看内容 */
  const toggleExpanded = (entryId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col u-page-bg">
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">监控</h1>
            <p className="page-subtitle">Agent Network 运营度量</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" disabled={refreshing} onClick={refresh}>
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>
      </div>

      {/* #180：概览 / 事件检索 Tab（IA：行动信号 > 健康度量 > 参考资料） */}
      <div className="u-page-px pt-3 flex gap-1 border-b u-border">
        {([['overview', '概览'], ['events', '事件检索']] as Array<[MonitoringTab, string]>).map(([id, label]) => (
          <button
            key={id}
            onClick={() => switchTab(id)}
            className={`u-tab px-4 py-2 text-sm rounded-t-lg transition-colors ${activeTab === id ? 'u-tab-active u-surface u-accent' : 'u-text-3'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'events' ? (
        <div className="flex-1 overflow-auto u-page-px pb-8">
          <div className="max-w-5xl">
            <EventSearchPanel initialFilters={eventSeed ?? undefined} />
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-auto u-page-px pb-8">
        <div className="max-w-5xl">
          {/* 行动面（§7.2 首屏）：需要处理（#184 独立加载）+ 知识提案待审（全页唯一可操作列表，上移） */}
          <div className="space-y-4 mt-4">
            <NeedsAttentionSection onAlertClick={drillIntoAlert} />

            <PendingProposalsSection
              proposals={proposals}
              error={proposalsQ.error}
              onRetry={proposalsQ.reload}
              actingIds={actingIds}
              armedIds={armedIds}
              expandedIds={expandedIds}
              onToggleExpanded={toggleExpanded}
              onApprove={clickApprove}
              onReject={entryId => void actOnProposal(entryId, 'reject')}
            />
          </div>

          {/* 健康度量（§7.2：度量区降为下方分区，默认折叠） */}
          <div className="mt-6">
            <button
              className="u-btn-reset flex items-center gap-2 u-text-2 u-hover-accent"
              aria-expanded={metricsOpen}
              onClick={() => setMetricsOpen(v => !v)}
            >
              <span className="text-xs">{metricsOpen ? '▾' : '▸'}</span>
              <span className="mc-block-label mc-block-label-flush">健康度量</span>
            </button>

            {metricsOpen && (
            <div className="space-y-4 mt-3">
              {/* 概览子拉取失败：证据台账/角色效率/人工干预三区块同源，一条错误行代表（原静默整块消失） */}
              {overviewQ.error && <SectionError error={overviewQ.error} onRetry={overviewQ.reload} />}
              {/* F6 证据台账（决策 1）：信任分层达成 + 双轨比对；§7.3 stat 减卡 7→5 */}
              {!overviewQ.error && evidence && <EvidenceSection evidence={evidence} />}

              <FlywheelSection flywheel={flywheel} error={flywheelQ.error} onRetry={flywheelQ.reload} />

              <OverheadSection overhead={overhead} error={overheadQ.error} onRetry={overheadQ.reload} />

              <CacheEfficiencySection cacheHit={cacheHit} error={efficiencyQ.error} onRetry={efficiencyQ.reload} />

              {/* §7.3 新引入：角色效率表格（claims/完成/均时/NEED_INPUT 拆分） */}
              {roles && roles.length > 0 && <RolesEfficiencySection roles={roles} />}

              {/* §7.3 新引入：人工干预北极星卡 */}
              {intervention && <InterventionSection intervention={intervention} />}
            </div>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
