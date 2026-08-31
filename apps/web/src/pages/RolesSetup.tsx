/**
 * AC-2.5: 角色初始化向导页
 *
 * 展示节点扫到的 runtime 清单，用户勾选 + 填 name/description -> 批量创建 AgentProfile。
 * 空清单时提示"未检测到 CLI"。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（card / input / btn / tag）与 u-* 语义工具类，禁止写死颜色。
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { channelApi } from '../api/channel';

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

export function RolesSetup() {
  const navigate = useNavigate();
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, SelectedRole>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ runtimes: RuntimeInfo[] }>('/workspaces/runtimes')
      .then(res => {
        setRuntimes(res.data.runtimes || []);
        // AC-2.5: 初始 selected 为空，用户手动勾选
      })
      .catch(() => setError('获取 runtime 清单失败'))
      .finally(() => setLoading(false));
  }, []);

  const toggleSelect = (key: string) => {
    setSelected(prev => {
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
    setSelected(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    const entries = Object.entries(selected).filter(([, v]) => v.name.trim());
    if (entries.length === 0) {
      setError('请至少填一个角色名称');
      setCreating(false);
      return;
    }
    try {
      for (const [, role] of entries) {
        await channelApi.createAgent({
          name: role.name.trim(),
          description: role.description.trim() || undefined,
          provider: role.provider,
        });
      }
      navigate('/');
    } catch (e) {
      setError('创建角色失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center u-text-2" style={{ background: 'var(--bg-primary)' }}>
        加载中...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <h1 className="page-title">角色初始化向导</h1>
        <p className="page-subtitle">从节点上检测到的执行环境批量创建 Agent 角色。</p>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl mt-4">
          {runtimes.length === 0 ? (
            <div className="card p-4 text-center">
              <p className="u-text">未检测到 CLI，请先在节点上安装 claude/kimi/codex/opencode 之一。</p>
              <p className="text-sm u-text-3 mt-1">节点 daemon start 后会自动扫描并上报 runtime 清单。</p>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <p className="u-text font-medium mb-2">检测到 {runtimes.length} 个 runtime：</p>
                {runtimes.map(rt => {
                  const key = `${rt.nodeId}:${rt.provider}`;
                  const isSelected = !!selected[key];
                  return (
                    <div key={key} className="card p-3 mb-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(key)}
                          style={{ accentColor: 'var(--accent-primary)' }}
                        />
                        <span className="u-text font-medium">{rt.provider}</span>
                        <span className="u-text-2 text-sm">v{rt.version}</span>
                        <span className="u-text-3 text-xs">@ {rt.workspaceName}</span>
                      </label>
                      {isSelected && (
                        <div className="ml-6 mt-2 grid gap-2" style={{ gridTemplateColumns: '1fr 2fr' }}>
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

              {error && <div className="u-err mb-3">{error}</div>}

              <div className="flex gap-2">
                <button
                  className="btn btn-secondary"
                  onClick={() => navigate('/')}
                >
                  跳过
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleCreate}
                  disabled={creating || Object.keys(selected).length === 0}
                  data-testid="roles-setup-create"
                >
                  {creating ? '创建中...' : '创建选中角色'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
