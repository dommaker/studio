// 创建角色弹框（#397，redesign §6.4：弹框不跳页——上下文不丢）
// 数据流：GET /workspaces/runtimes 拿**本机** CLI 清单（2026-09-10 起端点只报本机，节点维度随
// 远程方向废弃——见 apps/api/src/modules/workspaces/CONTEXT.md），勾选 + 命名后 channelApi.createAgent
// 逐个创建；保存 = 创建 → 关弹框 → onCreated（页面就地刷新名册），不再跳频道页。
// 结构走 theme.css modal-*（style-guide §4.3，经 ui/Modal 壳），条目样式在 agent-dashboard.css。
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { channelApi } from '../../api/channel';
import { Modal } from '../ui';

interface RuntimeInfo {
  provider: string;
  version: string;
}

interface SelectedRole {
  provider: string;
  name: string;
  description: string;
}

export function CreateRoleModal({ open, onClose, onCreated, presetProvider }: {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回调（页面侧就地刷新名册） */
  onCreated: () => void;
  /** E8-4：调用方已锁定 CLI 时传入（WorkspacePage 行内「设为角色」）——跳过 runtime 清单拉取，单项固定预选、provider 只读展示 */
  presetProvider?: string;
}) {
  // 本机 CLI 清单（按 provider 去重，取首条 — 同 useDetectedProviders 口径）
  const [providers, setProviders] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // 拉取失败 ≠ 一个都没装，两者提示不同（原实现混为一谈）
  const [loadFailed, setLoadFailed] = useState(false);
  // preset 模式懒初始化：覆盖挂载即 open=true（prevOpen 上升沿不触发）的情形
  const [selected, setSelected] = useState<Record<string, SelectedRole>>(() =>
    presetProvider
      ? { [presetProvider]: { provider: presetProvider, name: '', description: '' } }
      : {});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开沿渲染期重置表单（prevOpen 上升沿，同 FirstRoleSetupModal 模式；
  // effect 内同步 setState 触发 react-hooks/set-state-in-effect）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setSelected(presetProvider
        ? { [presetProvider]: { provider: presetProvider, name: '', description: '' } }
        : {});
      setError(null);
      setLoadFailed(false);
      setLoading(!presetProvider);
    }
  }

  useEffect(() => {
    if (!open || presetProvider) return;
    let cancelled = false;
    api.get<{ runtimes: RuntimeInfo[] }>('/workspaces/runtimes')
      .then((res) => {
        if (cancelled) return;
        const byProvider = new Map<string, RuntimeInfo>();
        for (const rt of res.data.runtimes || []) {
          if (!rt?.provider || byProvider.has(rt.provider)) continue;
          byProvider.set(rt.provider, { provider: rt.provider, version: rt.version ?? '' });
        }
        setProviders([...byProvider.values()]);
      })
      .catch(() => {
        if (cancelled) return;
        setProviders([]);
        setLoadFailed(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const toggleSelect = (provider: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[provider]) delete next[provider];
      else next[provider] = { provider, name: '', description: '' };
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
      {presetProvider ? (
        // preset 模式（E8-4，WorkspacePage）：provider 已锁定只读展示，单项命名，不走 agd-cr-* 列表样式
        // （agent-dashboard.css 由 AgentDashboardPage 引入，本页不依赖）
        <div>
          <div className="mb-3">
            <label className="block text-sm u-text-2 mb-1">CLI</label>
            <div className="text-sm font-medium u-text">{presetProvider}</div>
          </div>
          <div className="flex flex-col gap-2">
            <input
              type="text"
              placeholder="角色名称（如 dev-agent）"
              value={selected[presetProvider]?.name ?? ''}
              onChange={(e) => updateField(presetProvider, 'name', e.target.value)}
              className="input"
              data-testid={`role-name-preset:${presetProvider}`}
            />
            <input
              type="text"
              placeholder="描述（可选）"
              value={selected[presetProvider]?.description ?? ''}
              onChange={(e) => updateField(presetProvider, 'description', e.target.value)}
              className="input"
            />
          </div>
        </div>
      ) : loading ? (
        <div className="u-text-2 py-6 text-center">加载中…</div>
      ) : loadFailed ? (
        <div className="py-3">
          <p className="u-err">获取本机 CLI 清单失败，可稍后重试或直接创建（provider 可手填于角色设置页）。</p>
        </div>
      ) : providers.length === 0 ? (
        <div className="py-3">
          <p className="u-text">未检测到 CLI，请先在本机安装 claude/kimi/codex/opencode 之一。</p>
          <p className="text-sm u-text-3 mt-1">清单由服务端扫描本机 PATH 得到，装好后重开弹框即可看到。</p>
        </div>
      ) : (
        <div className="agd-cr-list">
          <p className="u-text-3 text-xs m-0">
            检测到 {providers.length} 个 runtime，勾选并命名：
          </p>
          {providers.map((rt) => {
            const isSelected = !!selected[rt.provider];
            return (
              <div key={rt.provider} className={`agd-cr-item${isSelected ? ' agd-cr-item-on' : ''}`}>
                <label className="agd-cr-item-head">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(rt.provider)}
                    style={{ accentColor: 'var(--accent-primary)' }}
                  />
                  <span className="u-text font-semibold">{rt.provider}</span>
                  <span className="u-text-2 text-sm">v{rt.version}</span>
                </label>
                {isSelected && (
                  <div className="agd-cr-fields">
                    <input
                      type="text"
                      placeholder="角色名称（如 dev-agent）"
                      value={selected[rt.provider].name}
                      onChange={(e) => updateField(rt.provider, 'name', e.target.value)}
                      className="input"
                      data-testid={`role-name-${rt.provider}`}
                    />
                    <input
                      type="text"
                      placeholder="描述（可选）"
                      value={selected[rt.provider].description}
                      onChange={(e) => updateField(rt.provider, 'description', e.target.value)}
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
