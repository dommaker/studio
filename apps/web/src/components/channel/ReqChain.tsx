// ReqChain — WorkUnitDrawer 的 REQ 全链路体（拆分来源：components/channel/WorkUnitDrawer.tsx 的「── REQ 全链路 ──」段）
import { useEffect } from 'react';
import { useRequirementChainStore } from '../../stores/requirementChainStore';
import { SkeletonText } from '../ui';
import { WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { AssigneeLabel } from '../workunit/AssigneeLabel';
import { formatShortTime } from '../../utils/datetime';
import { wuStatusClass, deriveWuColumn } from './wuStatus';

const REQ_STATUS_LABELS: Record<string, string> = {
  open: '未开始',
  'in-progress': '进行中',
  done: '已完成',
  archived: '已归档',
};

export function ReqChain({ id, onOpenWu }: { id: string; onOpenWu: (wuId: string) => void }) {
  // #412：链路读 requirementChainStore（与右栏/面板/项目页共享单份缓存；status_changed 就地更新）
  const chain = useRequirementChainStore((s) => s.chains[id]);
  const error = useRequirementChainStore((s) => s.errors[id]);

  useEffect(() => {
    const release = useRequirementChainStore.getState().subscribeChain(id);
    void useRequirementChainStore.getState().ensureChain(id);
    return release;
  }, [id]);

  if (error) return <div className="mc-drawer-note">加载失败: {error}</div>;
  if (!chain) return <SkeletonText lines={3} className="space-y-2" />;

  const req = chain.requirement;
  return (
    <div>
      <div className="mc-drawer-subject">
        <span className="mc-status mc-status-need">{REQ_STATUS_LABELS[req.status] ?? req.status}</span>
        <span className="mc-drawer-subject-title">{req.title}</span>
      </div>
      <div className="mc-kv"><span className="mc-kv-k">编号</span><span className="mc-kv-v">{req.id}</span></div>
      <div className="mc-kv"><span className="mc-kv-k">创建</span><span className="mc-kv-v">{formatShortTime(req.createdAt)}</span></div>
      <div className="mc-kv"><span className="mc-kv-k">来源</span><span className="mc-kv-v">{req.createdBy}</span></div>
      {req.description && <p className="mc-drawer-desc">{req.description}</p>}
      {req.docs && req.docs.length > 0 && (
        <>
          <div className="mc-block-label">关联文档</div>
          <ul className="mc-docs">
            {req.docs.map(d => <li key={d} className="mc-doc-item">{d}</li>)}
          </ul>
        </>
      )}

      <div className="mc-block-label">任务链路（{chain.workunits.length}）</div>
      {chain.workunits.length === 0 && <div className="mc-drawer-note">暂无关联任务</div>}
      {chain.workunits.map((wu, i) => (
        <div key={wu.id}>
          {i > 0 && <div className="mc-chain-arrow">↓</div>}
          <button className="mc-chain-node" onClick={() => onOpenWu(wu.id)}>
            <div className="mc-chain-node-top">
              <span className={wuStatusClass(deriveWuColumn(wu))}>
                {deriveWuColumn(wu) === 'active' ? <span className="mc-dot" /> : null}
                {WU_STATUS_LABELS[deriveWuColumn(wu)] ?? deriveWuColumn(wu)}
              </span>
              <span className="mc-mono">{wu.id}</span>
              {wu.assigneeId && <AssigneeLabel assigneeId={wu.assigneeId} assigneeRoleId={wu.assigneeRoleId} className="mc-dim ml-auto" />}
            </div>
            <div className="mc-chain-node-title">{wu.title}</div>
          </button>
        </div>
      ))}
    </div>
  );
}
