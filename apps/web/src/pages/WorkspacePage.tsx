// WorkspacePage — AC Group 5: runtime list + create role dialog
// E8-2（2026-09 页面重设计）：骨架合规化——§4.7 标准骨架（u-page-bg/u-page-head/page-title/max-w-5xl），
// runtime 行卡归 .card，「设为角色」归 btn btn-primary btn-sm，删硬编码「0 个角色」假数据
// （无按 runtime 的角色计数现成接口，假数据直接删除）
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { workspaceApi } from '../api';
import { channelApi } from '../api/channel';
import { BackButton } from '../components/ui';

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
  const [creating, setCreating] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState(false);

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

  const handleCreateRole = async () => {
    if (!formName.trim() || !selectedRuntime) return;
    setCreating(true);
    setCreateError(null);
    try {
      await channelApi.createAgent({
        name: formName.trim(),
        description: formDesc.trim() || undefined,
        provider: selectedRuntime.provider,
      });
      setCreateSuccess(true);
      setFormName('');
      setFormDesc('');
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e?.message || '创建失败';
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  const openDialog = (rt: Runtime) => {
    setSelectedRuntime(rt);
    setFormName('');
    setFormDesc('');
    setCreateError(null);
    setCreateSuccess(false);
  };

  if (loading) return <div className="h-full u-page-bg p-4 u-text-2">加载中...</div>;
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

          {/* Create role dialog */}
          {selectedRuntime && (
            <div className="modal-overlay">
              <div className="modal" style={{ maxWidth: '24rem' }}>
                <div className="modal-header">
                  <h3 className="modal-title">创建角色</h3>
                  <button className="modal-close" onClick={() => setSelectedRuntime(null)} aria-label="关闭">×</button>
                </div>
                <div className="modal-body">
                  <div className="mb-3">
                    <label className="block text-sm u-text-2 mb-1">CLI</label>
                    <div className="text-sm font-medium u-text">{selectedRuntime.provider}</div>
                  </div>

                  <div className="mb-3">
                    <input
                      type="text"
                      placeholder="角色名称"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      className="input w-full"
                    />
                  </div>

                  <div className="mb-4">
                    <input
                      type="text"
                      placeholder="角色描述（选填）"
                      value={formDesc}
                      onChange={(e) => setFormDesc(e.target.value)}
                      className="input w-full"
                    />
                  </div>

                  {createError && <p className="text-sm u-err mb-3">{createError}</p>}
                  {createSuccess && <p className="text-sm u-ok mb-3">角色创建成功</p>}
                </div>
                <div className="modal-footer">
                  <button
                    onClick={() => setSelectedRuntime(null)}
                    className="btn btn-secondary"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleCreateRole}
                    disabled={creating || !formName.trim()}
                    className="btn btn-primary"
                  >
                    创建
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
