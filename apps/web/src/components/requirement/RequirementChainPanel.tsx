// REQ 全链路面板（vision §5.3）— 展示 GET /requirements/:id/chain
import { useEffect, useState } from 'react';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import { Modal } from '../ui/Modal';
import { requirementApi, type RequirementChain } from '../../api/requirements';
import { formatFullTime } from '../../utils/datetime';
import { AssigneeLabel } from '../workunit/AssigneeLabel';

const reqStatusLabels: Record<string, string> = {
  open: '未开始',
  'in-progress': '进行中',
  done: '已完成',
  archived: '已归档',
};

const wuStatusLabels: Record<string, string> = {
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

const wuStatusColors: Record<string, string> = {
  unassigned: 'u-surface-2 u-text-2',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  done: 'u-ok-dim u-ok',
  closed: 'u-ok-dim u-ok',
  blocked: 'u-err-dim u-err',
};

interface Props {
  reqId: string | null;
  onClose: () => void;
}

export function RequirementChainPanel({ reqId, onClose }: Props) {
  const [chain, setChain] = useState<RequirementChain | null>(null);
  const [error, setError] = useState<string | null>(null);

  // reqId 切换时在渲染期同步清空旧链路（替代原 effect 顶部的同步重置）
  const [prevReqId, setPrevReqId] = useState(reqId);
  if (prevReqId !== reqId) {
    setPrevReqId(reqId);
    setChain(null);
    setError(null);
  }

  useEffect(() => {
    if (!reqId) return;
    requirementApi.getChain(reqId)
      .then(r => setChain(r.data.data))
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [reqId]);

  if (!reqId) return null;

  const req = chain?.requirement;

  return (
    <Modal open onClose={onClose} title={`REQ 全链路 · ${reqId}`}>
      {error && <div className="text-sm u-err">加载失败: {error}</div>}
      {!chain && !error && <div className="text-sm u-text-3">加载中...</div>}
      {chain && req && (
        <div className="space-y-4">
          {/* Requirement 信息 */}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{req.title}</span>
              <span className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent">
                {reqStatusLabels[req.status] ?? req.status}
              </span>
            </div>
            <div className="text-xs u-text-3 mt-1">
              <span className="font-mono">{req.id}</span> · 创建于 <span className="font-mono">{formatFullTime(req.createdAt)}</span> · 来源 {req.createdBy}
            </div>
            {req.description && <p className="text-sm u-text-2 mt-2">{req.description}</p>}
            {req.docs && req.docs.length > 0 && (
              <div className="mt-2">
                <div className="text-xs u-text-3 mb-1">关联文档</div>
                <ul className="text-xs u-accent space-y-0.5">
                  {req.docs.map(d => <li key={d} className="truncate">{d}</li>)}
                </ul>
              </div>
            )}
          </div>

          {/* WorkUnit 列表 */}
          <div>
            <div className="text-xs u-text-3 mb-2">WorkUnit（{chain.workunits.length}）</div>
            {chain.workunits.length === 0 ? (
              <div className="text-sm u-text-3">暂无关联 WorkUnit</div>
            ) : (
              <ul className="space-y-1.5">
                {chain.workunits.map(wu => {
                  // F6-b：徽章走派生列（唯一口径）
                  const column = deriveDisplayState({ status: wu.status, metadata: wu.metadata }).column;
                  return (
                  <li key={wu.id} className="flex items-center gap-2 text-sm">
                    <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${wuStatusColors[column] ?? 'u-surface-2 u-text-2'}`}>
                      {wuStatusLabels[column] ?? column}
                    </span>
                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{wu.title}</span>
                    {wu.assigneeId && (
                      <AssigneeLabel assigneeId={wu.assigneeId} className="text-xs u-text-3 flex-shrink-0" />
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
