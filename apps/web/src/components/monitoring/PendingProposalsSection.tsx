// 拆分来源：pages/MonitoringPage.tsx「知识提案待审」MonitorSection 整块（纯 JSX 平移，
// 数据/审批状态仍由页面持有，props 逐字段平移；两步确认/展开详情/锁存语义零变更）
import { MonitorSection } from './MonitorSection';
import { SectionError } from '../ui';
import { KNOWLEDGE_TYPE_LABELS } from '../channel/proposalCardConfigs';
import { formatAge } from '@dommaker/studio-shared/web';
import { formatFullTime } from '../../utils/datetime';
import type { KnowledgeEntryItem } from '../../api/knowledge';

export interface PendingProposalsSectionProps {
  proposals: KnowledgeEntryItem[] | null;
  error: string | null;
  onRetry: () => void;
  /** 批次A 项8：通过/拒绝共用 pending 锁存（防连点） */
  actingIds: Set<string>;
  /** #473：通过两步确认——首次点击仅进待确认态 */
  armedIds: Set<string>;
  /** #473：点击标题展开/收起详情 */
  expandedIds: Set<string>;
  onToggleExpanded: (entryId: string) => void;
  /** #473 两步确认的「通过」入口（首次仅待确认，再次点击才执行） */
  onApprove: (entryId: string) => void;
  onReject: (entryId: string) => void;
}

/** 行动面「知识提案待审」区（MonitoringPage 概览 tab 首屏第二块） */
export function PendingProposalsSection({
  proposals, error, onRetry,
  actingIds, armedIds, expandedIds, onToggleExpanded, onApprove, onReject,
}: PendingProposalsSectionProps) {
  return (
    <MonitorSection
      title="知识提案待审"
      subtitle="Agent 提炼的新知识，等你确认"
      stat={proposals === null ? undefined : proposals.length}
      statTestId="proposals-stat"
    >
      {error ? (
        <SectionError error={error} onRetry={onRetry} />
      ) : proposals === null ? (
        <div className="text-sm u-text-3">加载中…</div>
      ) : proposals.length === 0 ? (
        <div className="empty-state text-sm">无待审提案（提取产物以 draft 入库，审核通过后才参与注入）</div>
      ) : (
        <div className="space-y-2">
          {proposals.map(p => (
            <div key={p.id} className="text-sm">
              <div className="flex items-center gap-3">
                {/* #473：标题即详情开关——审前先看内容（对照频道提案卡条目清单） */}
                <button
                  className="u-btn-reset u-text u-hover-accent text-left flex-1 min-w-0 truncate"
                  aria-expanded={expandedIds.has(p.id)}
                  onClick={() => onToggleExpanded(p.id)}
                >
                  {p.title}
                </button>
                <span className="text-xs u-text-3">{formatAge(p.created)}</span>
                {/* 批次A 项8：补「拒绝」按钮（demote → archived），与通过共用 pending 锁存；
                    #473：通过两步确认（首次仅待确认，再次点击才执行） */}
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={actingIds.has(p.id)}
                  onClick={() => onApprove(p.id)}
                >
                  {actingIds.has(p.id) ? '处理中…' : armedIds.has(p.id) ? '再点一次确认通过' : '通过'}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={actingIds.has(p.id)}
                  onClick={() => onReject(p.id)}
                >
                  {actingIds.has(p.id) ? '处理中…' : '拒绝'}
                </button>
              </div>
              {expandedIds.has(p.id) && (
                <div className="text-xs u-text-2 mt-1 space-y-0.5">
                  <div>类型：{KNOWLEDGE_TYPE_LABELS[p.type || ''] || p.type || '未分类'}</div>
                  {p.tags && p.tags.length > 0 && <div>标签：{p.tags.join('、')}</div>}
                  {p.created && <div>提交时间：{formatFullTime(p.created)}</div>}
                  <div>通过后参与注入；拒绝则归档不再出现。</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </MonitorSection>
  );
}
