// REQ 全链路面板（vision §5.3）— 展示 GET /requirements/:id/chain
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { requirementApi, type RequirementChain } from '../../api/requirements';

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
  unassigned: 'bg-gray-500/20 text-gray-500',
  active: 'bg-purple-500/20 text-purple-500',
  in_review: 'bg-yellow-500/20 text-yellow-600',
  done: 'bg-green-500/20 text-green-600',
  closed: 'bg-green-500/20 text-green-600',
  blocked: 'bg-red-500/20 text-red-500',
};

interface Props {
  reqId: string | null;
  onClose: () => void;
}

export function RequirementChainPanel({ reqId, onClose }: Props) {
  const [chain, setChain] = useState<RequirementChain | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reqId) return;
    setChain(null);
    setError(null);
    requirementApi.getChain(reqId)
      .then(r => setChain(r.data.data))
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [reqId]);

  if (!reqId) return null;

  const req = chain?.requirement;

  return (
    <Modal open onClose={onClose} title={`REQ 全链路 · ${reqId}`}>
      {error && <div className="text-sm text-red-500">加载失败: {error}</div>}
      {!chain && !error && <div className="text-sm text-gray-400">加载中...</div>}
      {chain && req && (
        <div className="space-y-4">
          {/* Requirement 信息 */}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium" style={{ color: 'var(--text-primary, #111)' }}>{req.title}</span>
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-500">
                {reqStatusLabels[req.status] ?? req.status}
              </span>
            </div>
            <div className="text-xs text-gray-400 mt-1">
              {req.id} · 创建于 {new Date(req.createdAt).toLocaleString('zh-CN')} · 来源 {req.createdBy}
            </div>
            {req.description && <p className="text-sm text-gray-500 mt-2">{req.description}</p>}
            {req.docs && req.docs.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-gray-400 mb-1">关联文档</div>
                <ul className="text-xs text-blue-500 space-y-0.5">
                  {req.docs.map(d => <li key={d} className="truncate">{d}</li>)}
                </ul>
              </div>
            )}
          </div>

          {/* WorkUnit 列表 */}
          <div>
            <div className="text-xs text-gray-400 mb-2">WorkUnit（{chain.workunits.length}）</div>
            {chain.workunits.length === 0 ? (
              <div className="text-sm text-gray-400">暂无关联 WorkUnit</div>
            ) : (
              <ul className="space-y-1.5">
                {chain.workunits.map(wu => (
                  <li key={wu.id} className="flex items-center gap-2 text-sm">
                    <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${wuStatusColors[wu.status] ?? 'bg-gray-500/20 text-gray-500'}`}>
                      {wuStatusLabels[wu.status] ?? wu.status}
                    </span>
                    <span className="truncate" style={{ color: 'var(--text-primary, #111)' }}>{wu.title}</span>
                    {wu.assigneeId && (
                      <span className="text-xs text-gray-400 flex-shrink-0">@{wu.assigneeId.slice(0, 8)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
