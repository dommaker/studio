// OpportunitiesPanel — #163 T8-E2 巡检机会清单卡片（WU 详情页用）
// 每条机会三态：待处理（可采纳/忽略）/ 已开单（采纳后建了跟进工单）/ 已忽略（可附理由）
import { useState } from 'react';
import { workunitApi, type Opportunity } from '../../api/workunit';
import { toast } from '../../utils/toast';

interface Props {
  workUnitId: string;
  opportunities: Opportunity[];
  /** 采纳/忽略成功后由父组件重新加载（清单状态随之刷新） */
  onChanged: () => void;
}

export function OpportunitiesPanel({ workUnitId, opportunities, onChanged }: Props) {
  // busyId：正在处理中的条目 id（防重复点击；同条目的两个按钮一起禁用）
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleAdopt = async (oppId: string) => {
    if (busyId) return;
    setBusyId(oppId);
    try {
      await workunitApi.adoptOpportunity(workUnitId, oppId);
      toast.success('已采纳，跟进工单已创建');
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message ?? '采纳失败，请重试');
    } finally {
      setBusyId(null);
    }
  };

  const handleIgnore = async (oppId: string) => {
    if (busyId) return;
    const reason = window.prompt('忽略理由（可留空）');
    if (reason === null) return; // 取消 = 不操作
    setBusyId(oppId);
    try {
      await workunitApi.ignoreOpportunity(workUnitId, oppId, reason || undefined);
      toast.success('已忽略');
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.message ?? '忽略失败，请重试');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card mt-4 p-3">
      <h3 className="text-sm font-medium u-text-2 mb-2">🔍 巡检发现的机会</h3>
      <ul className="space-y-2">
        {opportunities.map(opp => {
          const busy = busyId === opp.id;
          return (
            <li key={opp.id} className="p-2 rounded u-surface-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm u-text-1">{opp.problem}</div>
                  <div className="text-xs u-text-2 mt-0.5">建议：{opp.suggestion}</div>
                  {opp.estimate && (
                    <div className="text-xs u-text-3 mt-0.5">预估：{opp.estimate}</div>
                  )}
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                  {opp.status === 'pending' && (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => handleAdopt(opp.id)}
                      >
                        {busy ? '处理中…' : '采纳'}
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busy}
                        onClick={() => handleIgnore(opp.id)}
                      >
                        忽略
                      </button>
                    </>
                  )}
                  {opp.status === 'adopted' && (
                    <span className="text-xs px-2 py-0.5 rounded u-ok-dim u-ok">
                      已开单{opp.wuId ? ` ${opp.wuId.slice(0, 8)}` : ''}
                    </span>
                  )}
                  {opp.status === 'ignored' && (
                    <span
                      className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
                      title={opp.ignoreReason || undefined}
                    >
                      已忽略{opp.ignoreReason ? `：${opp.ignoreReason}` : ''}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
