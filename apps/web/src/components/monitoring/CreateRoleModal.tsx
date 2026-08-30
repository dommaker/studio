// 创建角色弹框（#397，redesign §6.4：弹框不跳页——上下文不丢）
// 数据流同 RolesSetup 页：GET /workspaces/runtimes 拿 CLI 清单，勾选 + 命名后 channelApi.createAgent 逐个创建；
// 保存 = 创建 → 关弹框 → onCreated（页面就地刷新名册），不再跳频道页。
// 结构走 theme.css modal-*（style-guide §4.3，经 ui/Modal 壳），条目样式在 agent-dashboard.css。
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { channelApi } from '../../api/channel';
import { Modal } from '../ui';

interface RuntimeInfo {
  nodeId: string;
  provider: string;
  version: string;
  workspaceName: string;
}

interface SelectedRole {
  provider: string;
  nodeId: string;
  name: string;
  description: string;
}

export function CreateRoleModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回调（页面侧就地刷新名册） */
  onCreated: () => void;
}) {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, SelectedRole>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开沿渲染期重置表单（prevOpen 上升沿，同 FirstRoleSetupModal 模式；
  // effect 内同步 setState 触发 react-hooks/set-state-in-effect）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setSelected({});
      setError(null);
      setLoading(true);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.get<{ runtimes: RuntimeInfo[] }>('/workspaces/runtimes')
      .then((res) => { if (!cancelled) setRuntimes(res.data.runtimes || []); })
      .catch(() => { if (!cancelled) setError('获取 runtime 清单失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else {
        const [nodeId, provider] = key.split(':');
        next[key] = { provider, nodeId, name: '', description: '' };
      }
      return next;
    });
  };

  const updateField = (key: string, field: 'name' | 'description', value: string) => {
    setSelected((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const namedCount = Object.values(selected).filter((v) => v.name.trim()).length;

  const handleCreate = async () => {
    const entries = Object.entries(selected).filter(([, v]) => v.name.trim());
    if (entries.length === 0) {
      setError('请至少填一个角色名称');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      for (const [, role] of entries) {
        await channelApi.createAgent({
          name: role.name.trim(),
          description: role.description.trim() || undefined,
          provider: role.provider,
        });
      }
      // §6.4：保存 = 关弹框 + 就地刷新，不跳页
      onCreated();
      onClose();
    } catch (e) {
      setError('创建角色失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建角色"
      maxWidth="560px"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={creating || namedCount === 0}
            data-testid="create-role-submit"
          >
            {creating ? '创建中…' : `创建选中角色${namedCount > 0 ? `（${namedCount}）` : ''}`}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="u-text-2 py-6 text-center">加载中…</div>
      ) : runtimes.length === 0 ? (
        <div className="py-3">
          <p className="u-text">未检测到 CLI，请先在节点上安装 claude/kimi/codex/opencode 之一。</p>
          <p className="text-sm u-text-3 mt-1">节点 daemon start 后会自动扫描并上报 runtime 清单。</p>
        </div>
      ) : (
        <div className="agd-cr-list">
          <p className="u-text-3 text-xs m-0">
            检测到 {runtimes.length} 个 runtime，勾选并命名：
          </p>
          {runtimes.map((rt) => {
            const key = `${rt.nodeId}:${rt.provider}`;
            const isSelected = !!selected[key];
            return (
              <div key={key} className={`agd-cr-item${isSelected ? ' agd-cr-item-on' : ''}`}>
                <label className="agd-cr-item-head">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(key)}
                    style={{ accentColor: 'var(--accent-primary)' }}
                  />
                  <span className="u-text font-semibold">{rt.provider}</span>
                  <span className="u-text-2 text-sm">v{rt.version}</span>
                  <span className="u-text-3 text-xs">@ {rt.workspaceName}</span>
                </label>
                {isSelected && (
                  <div className="agd-cr-fields">
                    <input
                      type="text"
                      placeholder="角色名称（如 dev-agent）"
                      value={selected[key].name}
                      onChange={(e) => updateField(key, 'name', e.target.value)}
                      className="input"
                      data-testid={`role-name-${key}`}
                    />
                    <input
                      type="text"
                      placeholder="描述（可选）"
                      value={selected[key].description}
                      onChange={(e) => updateField(key, 'description', e.target.value)}
                      className="input"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && <div className="u-err text-sm mt-2">{error}</div>}
    </Modal>
  );
}
