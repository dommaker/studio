// Memory proposal card — #101 角色记忆人审闸口
// cardType 'memory_proposal'；action 'memory_proposal_approve' / 'memory_proposal_reject'
// （由 ChannelDetailPage.handleAction 分发到 /role-memory/promote、/role-memory/demote）
// 文案人类可读：不出现「操作型事实/规律/教训」等内部分类词，用「建议沉淀为角色记忆」表达。
// 视觉复用 mc-card 族（仿 KnowledgeProposalCard / AuditorSuggestionCard）。
import { useEffect, useState } from 'react';
import type { ChannelMessage } from '../../api/channel';
import { memoryApi } from '../../api/memory';
import type { CardMeta } from './ChannelMessageItem';

interface Props {
  message: ChannelMessage;
  meta: CardMeta;
  /** approve/reject 由父级分发执行，返回是否成功（undefined 视为成功） */
  onAction: (messageId: string, action: string) => void | Promise<boolean>;
}

/** kind → 人类可读标签（不暴露 execution-knowledge / preference 内部分类词） */
const KIND_LABELS: Record<string, string> = {
  'execution-knowledge': '经验做法',
  preference: '偏好约定',
};

export function MemoryProposalCard({ message, meta, onAction }: Props) {
  const entries = meta.cardData?.entries as Array<{
    draftId: string;
    title: string;
    topicPath?: string;
    kind?: string;
  }> | undefined;
  const workUnitId = meta.cardData?.workUnitId as string | null | undefined;
  const roleId = meta.cardData?.roleId as string | undefined;
  const [reviewed, setReviewed] = useState<'approved' | 'rejected' | null>(
    meta.status === 'approved' || meta.status === 'rejected' ? meta.status : null,
  );
  const [pending, setPending] = useState(false);

  // 已审核态按草稿墓碑状态派生（刷新/重进频道后仍正确；其他入口的审核也会反映），
  // 对齐 KnowledgeProposalCard 按 maturity 派生的机制：
  // 全部 promoted → approved；全部 rejected → rejected；否则保持待审。派生失败静默保持待审。
  useEffect(() => {
    if (reviewed || !entries?.length || !roleId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await memoryApi.draftStatus(roleId, entries.map(e => e.draftId));
        if (cancelled) return;
        const statuses = entries.map(e => data?.statuses?.[e.draftId]);
        if (statuses.every(s => s === 'promoted')) setReviewed('approved');
        else if (statuses.every(s => s === 'rejected')) setReviewed('rejected');
      } catch { /* 派生失败保持待审 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (action: 'memory_proposal_approve' | 'memory_proposal_reject') => {
    setPending(true);
    try {
      const ok = await onAction(message.id, action);
      if (ok !== false) setReviewed(action === 'memory_proposal_approve' ? 'approved' : 'rejected');
    } finally {
      setPending(false);
    }
  };

  if (reviewed) {
    return (
      <div className="mc-card" data-card-type="memory_proposal">
        <div className="mc-card-label" style={{ marginBottom: 4 }}>角色记忆</div>
        <span className={reviewed === 'approved' ? 'mc-status mc-status-done' : 'mc-status mc-status-error'}>
          {reviewed === 'approved' ? '已确认，已写入记忆' : '已丢弃，未写入'}
        </span>
      </div>
    );
  }

  return (
    <div className="mc-card" data-card-type="memory_proposal" style={{ borderColor: 'var(--accent-border)' }}>
      <div className="mc-card-head">
        <span className="mc-card-label">角色记忆提案 — 待确认</span>
        <span className="mc-status mc-status-need">{entries?.length || 0} 条</span>
      </div>

      {/* Entries（一次提取多条聚合一卡；meta 指向文件 + 段落） */}
      {entries?.map(e => (
        <div key={e.draftId} style={{ marginBottom: 6, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
          <span className="mc-card-body" style={{ fontWeight: 600 }}>{e.title}</span>
          <span className="mc-status mc-status-pending" style={{ marginLeft: 6 }}>{KIND_LABELS[e.kind || ''] || e.kind}</span>
          {e.topicPath && (
            <div className="mc-time" style={{ marginBottom: 2 }}>将写入：{e.topicPath}</div>
          )}
        </div>
      ))}

      {workUnitId && (
        <div className="mc-time" style={{ marginBottom: 6 }}>来源 WorkUnit: {workUnitId}</div>
      )}

      {/* Action buttons */}
      <div className="mc-card-actions">
        <button
          onClick={() => act('memory_proposal_approve')}
          disabled={pending}
          className="mc-btn mc-btn-primary"
        >
          确认写入
        </button>
        <button
          onClick={() => act('memory_proposal_reject')}
          disabled={pending}
          className="mc-btn"
        >
          丢弃
        </button>
      </div>
    </div>
  );
}
