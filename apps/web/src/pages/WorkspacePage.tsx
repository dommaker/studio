// WorkspacePage — AC Group 5: runtime list + create role dialog
// E8-2（2026-09 页面重设计）：骨架合规化——§4.7 标准骨架（u-page-bg/u-page-head/page-title/max-w-5xl），
// runtime 行卡归 .card，「设为角色」归 btn btn-primary btn-sm，删硬编码「0 个角色」假数据
// （无按 runtime 的角色计数现成接口，假数据直接删除）
// E8-4：创建角色表单合一——内嵌 dialog 已删，复用 CreateRoleModal 正本（#397 §6.4，
// presetProvider 锁定行内 runtime 的 CLI；行为归一 = 创建成功关弹框 + onCreated，原「成功留框」差异随之消除）
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { workspaceApi } from '../api';
import { BackButton, SkeletonText, SkeletonCard } from '../components/ui';
import { CreateRoleModal } from '../components/monitoring/CreateRoleModal';

interface Runtime {
  id: string;
  provider: string;
  name: string;
  version: string | null;
  status: string;
}

interface WorkspaceDetail {
  id: string;
  name: string;
  status: string;
  workspaceRoot: string;
  runtimes: Runtime[];
}

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<Runtime | null>(null);

  // id 切换时在渲染期同步置回加载态（替代原 effect 顶部的同步 setLoading）
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setLoading(true);
  }

  useEffect(() => {
    if (!id) return;
    workspaceApi.get(id)
      .then((res) => {
        setWorkspace(res.data.data);
        setError(null);
      })
      .catch(() => setError('加载失败'))
      .finally(() => setLoading(false));
  }, [id]);

  const openDialog = (rt: Runtime) => {
    setSelectedRuntime(rt);
  };

  // 批次 F-3：加载态骨架（批次 E-2 ui/Skeleton 正本）——标题 + 行卡形态
  if (loading) return (
    <div className="h-full flex flex-col u-page-bg">
      <div className="u-page-head">
        <SkeletonText lines={1} widths={['30%']} />
      </div>
      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl mt-4 space-y-2">
          <SkeletonCard height={56} />
          <SkeletonCard height={56} />
          <SkeletonCard height={56} />
        </div>
      </div>
    </div>
  );
  if (error) return <div className="h-full u-page-bg p-4 u-err">{error}</div>;
  if (!workspace) return <div className="h-full u-page-bg p-4 u-text-2">Workspace 不存在</div>;

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* #393 §4.4：详情页统一左上返回（无 workspace 列表页，直开回落 /settings——本页入口 = 设置页「默认执行机器」节机器名直链，E8-1） */}
      <div className="u-page-head">
        <div className="mb-2"><BackButton fallback="/settings" /></div>
        <h1 className="page-title">{workspace.name}</h1>
        <p className="page-subtitle">
          {workspace.workspaceRoot} · {workspace.status}
        </p>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl mt-4">
          <h2 className="mc-block-label mb-2">可用 CLI ({workspace.runtimes.length})</h2>

          {workspace.runtimes.length === 0 ? (
            <p className="u-text-3">暂无可用 CLI，请先接入算力</p>
          ) : (
            <div className="space-y-2">
              {workspace.runtimes.map((rt) => (
                <div
                  key={rt.id}
                  className="card flex items-center justify-between p-3"
                >
                  <div>
                    <span className="font-medium">{rt.name}</span>
                    <span className="ml-2 text-sm u-text-3">
                      {rt.version ? `v${rt.version}` : ''}
                    </span>
                    <span className="ml-2 text-xs u-ok u-ok-dim px-2 py-0.5 rounded">
                      {rt.status}
                    </span>
                  </div>
                  <button
                    onClick={() => openDialog(rt)}
                    className="btn btn-primary btn-sm"
                  >
                    设为角色
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Create role dialog — E8-4：复用 CreateRoleModal 正本（#397 §6.4），presetProvider 锁定行内 CLI；
              本页无名册可刷新，onCreated 为空操作（§6.4 就地刷新契约的退化情形） */}
          <CreateRoleModal
            open={!!selectedRuntime}
            presetProvider={selectedRuntime?.provider}
            onClose={() => setSelectedRuntime(null)}
            onCreated={() => {}}
          />
        </div>
      </div>
    </div>
  );
}
