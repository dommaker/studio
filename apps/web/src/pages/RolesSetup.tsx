/**
 * AC-2.5: 角色初始化向导页
 *
 * 展示节点扫到的 runtime 清单，用户勾选 + 填 name/description -> 批量创建 AgentProfile。
 * 空清单时提示"未检测到 CLI"。
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

  if (loading) return <div style={{ padding: '24px' }}>加载中...</div>;

  return (
    <div style={{ maxWidth: '720px', margin: '40px auto', padding: '0 24px' }}>
      <h1>角色初始化向导</h1>
      <p style={{ color: '#666' }}>从已注册的节点 runtime 创建 AgentProfile。</p>

      {runtimes.length === 0 ? (
        <div style={{ padding: '24px', background: '#f3f4f6', borderRadius: '8px', textAlign: 'center' }}>
          <p>未检测到 CLI，请先在节点上安装 claude/kimi/codex/opencode 之一。</p>
          <p style={{ fontSize: '14px', color: '#999' }}>节点 daemon start 后会自动扫描并上报 runtime 清单。</p>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '16px' }}>
            <p style={{ fontWeight: 500, marginBottom: '8px' }}>检测到 {runtimes.length} 个 runtime：</p>
            {runtimes.map(rt => {
              const key = `${rt.nodeId}:${rt.provider}`;
              const isSelected = !!selected[key];
              return (
                <div key={key} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '12px', padding: '12px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(key)}
                    />
                    <span style={{ fontWeight: 500 }}>{rt.provider}</span>
                    <span style={{ color: '#666', fontSize: '14px' }}>v{rt.version}</span>
                    <span style={{ color: '#999', fontSize: '12px' }}>@ {rt.workspaceName}</span>
                  </label>
                  {isSelected && (
                    <div style={{ marginLeft: '24px', marginTop: '8px', display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '8px' }}>
                      <input
                        type="text"
                        placeholder="角色名称（如 dev-agent）"
                        value={selected[key].name}
                        onChange={(e) => updateField(key, 'name', e.target.value)}
                        style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: '4px' }}
                        data-testid={`role-name-${key}`}
                      />
                      <input
                        type="text"
                        placeholder="描述（可选）"
                        value={selected[key].description}
                        onChange={(e) => updateField(key, 'description', e.target.value)}
                        style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: '4px' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {error && <div style={{ color: 'red', marginBottom: '12px' }}>{error}</div>}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => navigate('/')}
              style={{ padding: '8px 16px' }}
            >
              跳过
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || Object.keys(selected).length === 0}
              style={{
                padding: '8px 16px',
                background: Object.keys(selected).length > 0 ? '#2563eb' : '#ccc',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
              }}
              data-testid="roles-setup-create"
            >
              {creating ? '创建中...' : '创建选中角色'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
