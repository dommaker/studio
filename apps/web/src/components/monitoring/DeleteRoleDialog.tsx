// 删除角色确认框（#630，ADR 2026-09-23 决策 5）：删除能力服务端早已完整（清频道成员与路由指名、
// 卸载 loop），本组件补 UI 入口的确认层——列出该角色在途任务（标题 + 状态词 + 所属 PMO 项目名，
// 无归属显示「未归属」，点击跳任务详情）；有在途任务仍允许删除（ADR 否决「禁删」备选：系统已有
// 租约过期 + 对账回收兜底），但警告「这些任务会中断，等待系统自动回收」。
// 在途清单数据源：GET /workunits?assigneeId=<roleId>（后端口径 = assigneeId 或 assigneeRoleId
// 任一命中，ADR 决策 7）；「在途」= 非终态（排除 done/completed/closed）。
// PMO 项目名解析复用 utils/wuPmo 共享正本（与 WorkUnitDetailPage 归属条同通路）。
// 清单拉取失败时确认键禁用——不知情删除比不删除更糟（不盲删）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { channelApi } from '../../api/channel';
import { workunitApi, type WorkUnit } from '../../api/workunit';
import { resolveWuPmoBatch, type WuPmoInfo } from '../../utils/wuPmo';
import { Modal, SkeletonText } from '../ui';
import { errorMessage } from '../../utils/errorMessage';

/** WU 终态（与 AgentDetailPage 统计口径一致）——在途 = 非终态 */
const TERMINAL_STATUSES = new Set(['done', 'completed', 'closed']);

interface InFlightItem {
  wu: WorkUnit;
  pmo: WuPmoInfo | null;
}

export function DeleteRoleDialog({ open, profile, onClose, onDeleted }: {
  open: boolean;
  /** 删除目标（null = 未选定，不渲染） */
  profile: { id: string; name: string } | null;
  onClose: () => void;
  /** 删除成功后回调（调用方刷新名册） */
  onDeleted: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<InFlightItem[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profileId = profile?.id ?? null;

  // 打开沿渲染期重置（prevOpen 上升沿，同 RoleFormModal 模式）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setLoading(true);
      setLoadError(null);
      setInFlight([]);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open || !profileId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await workunitApi.list({ assigneeId: profileId, limit: 50 });
        if (cancelled) return;
        const inFlightWus = res.data.data.filter((w) => !TERMINAL_STATUSES.has(w.status));
        const pmoMap = await resolveWuPmoBatch(inFlightWus);
        if (cancelled) return;
        setInFlight(inFlightWus.map((w) => ({ wu: w, pmo: pmoMap.get(w.id) ?? null })));
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, profileId]);

  if (!profile) return null;

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await channelApi.deleteAgent(profile.id);
      onDeleted();
      onClose();
    } catch (e) {
      setError('删除失败：' + errorMessage(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={deleting ? undefined : onClose}
      title={`删除角色 @${profile.name}`}
      maxWidth="480px"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={deleting}>取消</button>
          <button
            className="btn btn-danger"
            onClick={handleDelete}
            disabled={deleting || loading || !!loadError}
            data-testid="delete-role-confirm"
          >
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </>
      }
    >
      {loading ? (
        <SkeletonText lines={3} className="space-y-2 py-2" />
      ) : loadError ? (
        <p className="u-err text-sm">获取在途任务失败：{loadError}</p>
      ) : inFlight.length === 0 ? (
        <p className="u-text-2 text-sm">该角色没有在途任务。删除后会从频道成员与路由表中清除，且不可恢复。</p>
      ) : (
        <>
          <p className="u-err text-sm">
            该角色有 {inFlight.length} 个在途任务，删除后这些任务会中断，等待系统自动回收。
          </p>
          <div className="flex flex-col gap-1 mt-2" data-testid="delete-role-inflight">
            {inFlight.map(({ wu: w, pmo }) => (
              <div key={w.id} className="flex items-center gap-2 text-sm" style={{ minWidth: 0 }}>
                <Link to={`/workunits/${w.id}`} className="u-text u-hover-accent agd-ellipsis">
                  {w.scope || w.id}
                </Link>
                <span className="agd-chip">{WU_STATUS_LABELS[w.status] ?? w.status}</span>
                <span className="u-text-3 text-xs" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  {pmo ? `${pmo.pmoNumber} · ${pmo.title}` : '未归属'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <div className="u-err text-sm mt-2">{error}</div>}
    </Modal>
  );
}
