// WorkspacePage — AC Group 5: runtime list + create role dialog
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { workspaceApi } from '../api';
import { channelApi } from '../api/channel';

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

  if (loading) return <div className="p-4 u-text-2">加载中...</div>;
  if (error) return <div className="p-4 u-err">{error}</div>;
  if (!workspace) return <div className="p-4 u-text-2">Workspace 不存在</div>;

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <h1 className="text-xl font-bold mb-1">{workspace.name}</h1>
      <p className="text-sm u-text-2 mb-4">
        {workspace.workspaceRoot} · {workspace.status}
      </p>

      <h2 className="text-lg font-semibold mb-2">可用 CLI ({workspace.runtimes.length})</h2>

      {workspace.runtimes.length === 0 ? (
        <p className="u-text-3">暂无可用 CLI，请先接入算力</p>
      ) : (
        <div className="space-y-2">
          {workspace.runtimes.map((rt) => (
            <div
              key={rt.id}
              className="flex items-center justify-between p-3 u-surface border u-border rounded-lg"
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
              <div className="flex items-center gap-2">
                <span className="text-xs u-text-3">0 个角色</span>
                <button
                  onClick={() => openDialog(rt)}
                  className="px-3 py-1 text-sm u-accent-bg u-on-accent rounded u-hover-bg"
                >
                  设为角色
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create role dialog */}
      {selectedRuntime && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="u-surface rounded-lg shadow-xl p-6 w-96">
            <h3 className="text-lg font-semibold mb-4">创建角色</h3>

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
                className="w-full px-3 py-2 border u-border rounded  "
              />
            </div>

            <div className="mb-4">
              <input
                type="text"
                placeholder="角色描述（选填）"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                className="w-full px-3 py-2 border u-border rounded  "
              />
            </div>

            {createError && <p className="text-sm u-err mb-3">{createError}</p>}
            {createSuccess && <p className="text-sm u-ok mb-3">角色创建成功</p>}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSelectedRuntime(null)}
                className="px-4 py-2 text-sm u-surface-2 u-text-2 rounded u-hover-bg"
              >
                取消
              </button>
              <button
                onClick={handleCreateRole}
                disabled={creating || !formName.trim()}
                className="px-4 py-2 text-sm u-accent-bg u-on-accent rounded u-hover-bg disabled:opacity-50"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
