// memory 域提案卡配置（拆分来源：components/channel/proposalCardConfigs.tsx）
// #101 角色记忆（#353 已切通用端点 /review-proposals/memory/:draftId/*，逐草稿审批）
import axios from 'axios';
import { memoryApi } from '../../../api/memory';
import { fanOut } from '../../../utils/fanOut';
import { entryRowCls, metaStatusReviewed, type ProposalCardConfig } from './shared';

interface MemoryEntry {
  draftId: string;
  title: string;
  topicPath?: string;
  kind?: string;
}

/** memory 卡 kind → 人类可读标签（不暴露 execution-knowledge / preference 内部分类词） */
const MEMORY_KIND_LABELS: Record<string, string> = {
  'execution-knowledge': '经验做法',
  preference: '偏好约定',
};

/** #367 正本 not-pending 闸门判定：对非 pending 提案，approve/reject 回 400
 *  `{ error: { code, message: 'proposal-not-pending:<status>' } }`（批次 4/7 错误壳统一前为
 *  `{ error: string }`）。状态不可逆（failed/executed 永远无法再审），重试时同向终态按「已处理」计，其余算失败。 */
function notPendingAs(e: unknown, status: string): boolean {
  return axios.isAxiosError(e) &&
    (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message === `proposal-not-pending:${status}`;
}

export const memoryProposalConfig: ProposalCardConfig = {
  cardType: 'memory_proposal',
  kind: 'memory',
  approveAction: 'memory_proposal_approve',
  rejectAction: 'memory_proposal_reject',
  approvedState: 'approved',
  exec: async (cardData, decision) => {
    const entries = cardData?.entries;
    const entryIds: string[] = Array.isArray(entries)
      ? entries
          .map((e: { draftId?: unknown }) => e?.draftId)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (entryIds.length === 0) return false;
    // #367 逐草稿结算：同向终态（approve↔executed / reject↔rejected）幂等跳过计成功，
    // 其余失败只判本条——部分失败后重试可审完剩余 pending，不因已审兄弟草稿的 400 崩掉整批
    const doneStatus = decision === 'approve' ? 'executed' : 'rejected';
    const results = await fanOut(entryIds, async id => {
      if (decision === 'approve') {
        const { data } = await memoryApi.approve(id);
        // 契约驱动迁移（批次 4/7）：approve 响应进 `{ data }` 壳
        return !!data?.data?.success;
      }
      await memoryApi.reject(id);
      return true;
    });
    // 失败口径（fanOut 统一）：单条异常经 notPendingAs 分类——同向终态幂等跳过计成功，其余计失败
    // （ok 需显式 === true：repo 非 strict，boolean 判别式 truthy 判断不收窄 false 分支，见 utils/fanOut.ts）
    return results.every(r => (r.ok === true ? r.value : notPendingAs(r.error, doneStatus)));
  },
  // 已审核态按提案状态派生：全部 executed（旧 promoted 读侧归一）→ approved；全部 rejected → rejected；
  // #367 无一 pending 且含 failed → failed 终态收敛（failed 正本不可逆，纯重试无法让卡进 approved）
  fetchReviewed: async cardData => {
    const entries = cardData?.entries as MemoryEntry[] | undefined;
    if (!entries?.length) return null;
    const { data } = await memoryApi.status(entries.map(e => e.draftId));
    const statuses = entries.map(e => data?.statuses?.[e.draftId]);
    if (statuses.every(s => s === 'executed')) return 'approved';
    if (statuses.every(s => s === 'rejected')) return 'rejected';
    if (
      statuses.length > 0 &&
      statuses.some(s => s === 'failed') &&
      statuses.every(s => s === 'executed' || s === 'rejected' || s === 'failed')
    ) {
      return 'failed';
    }
    return null;
  },
  initialReviewed: metaStatusReviewed,
  reviewedTitle: '角色记忆',
  reviewLabels: {
    approved: { text: '已确认，已写入记忆', cls: 'mc-status-done' },
    rejected: { text: '已丢弃，未写入', cls: 'mc-status-error' },
    failed: { text: '部分条目写入失败，需人工跟进', cls: 'mc-status-error' },
  },
  pendingTitle: '角色记忆提案 — 待确认',
  countText: cd => `${(cd?.entries as unknown[] | undefined)?.length || 0} 条`,
  approveLabel: '确认写入',
  rejectLabel: '丢弃',
  renderContent: cd => {
    const entries = cd?.entries as MemoryEntry[] | undefined;
    const workUnitId = cd?.workUnitId as string | null | undefined;
    return (
      <>
        {entries?.map(e => (
          <div key={e.draftId} className={entryRowCls}>
            <span className="mc-card-body font-semibold">{e.title}</span>
            <span className="mc-status mc-status-pending ml-1.5">{MEMORY_KIND_LABELS[e.kind || ''] || e.kind}</span>
            {e.topicPath && (
              <div className="mc-time mb-0.5">将写入：{e.topicPath}</div>
            )}
          </div>
        ))}
        {workUnitId && (
          <div className="mc-time mb-1.5">来源 WorkUnit: {workUnitId}</div>
        )}
      </>
    );
  },
};
