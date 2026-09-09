// Channel Member Manager — AC-B frontend gap
// 2026-07 视觉重构（方向 A Mission Control）：深色变量重绘；成员管理逻辑零变更
// #403（ADR 2026-08-31 决策 2/3）：成员 ID 列表读 channelDataStore（页面拉频道记录时写穿水合，
// 面板修改成功后本地写穿，不做多端实时）；agent 档案读 rosterStore 客户端切片
// （listAllAgents 是全量正本，不再打 /agent-profiles?status=active）；两分支合并。
// useDetectedProviders 懒挂载：成员面板首次展开才请求 /workspaces/runtimes（ADR 决策 4）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { channelApi } from '../../api/channel';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { useRosterStore, activeAgentsOf } from '../../stores/rosterStore';
import { useChannelDataStore } from '../../stores/channelDataStore';
import { Select } from '../ui';
import { toast } from '../../utils/toast';
import { serverErrorMessage } from '../../utils/errorMessage';

interface ChannelMemberManagerProps {
  channelId: string;
  /** E1：顶栏 ⋯ 菜单收纳时传入菜单行类（默认 mc-btn 顶栏钮形态不变） */
  triggerClassName?: string;
}

export const ChannelMemberManager: React.FC<ChannelMemberManagerProps> = ({ channelId, triggerClassName }) => {
  // 缺键 = 未拉到（页面水合或 store 兜底拉取到位前短暂为空，对齐旧 membersJson 异步到达语义）
  const memberIds = useChannelDataStore((s) => s.members[channelId]);
  const profiles = useRosterStore((s) => s.profiles);
  const [isOpen, setIsOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  // 用户显式选择的 CLI；空 = 未选过（或选择已失效），由下方派生值回退默认
  const [providerOverride, setProviderOverride] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 懒挂载：面板首次展开才发 /workspaces/runtimes（服务端同步重扫 CLI，进页即扫最坏数十秒）
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders({ enabled: isOpen });
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  // 切换频道时收起弹层与创建表单，避免把上个频道的上下文带过去（渲染期调整）
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (prevChannelId !== channelId) {
    setPrevChannelId(channelId);
    setIsOpen(false);
    setShowCreateForm(false);
    setCreateError(null);
  }

  // 生效的 provider 为渲染期纯派生（替代原 effect 同步回填）：用户显式选择仍有效
  // 则用选择，否则回退第一个可用 CLI——选项异步晚到时自动回填的语义不变，
  // 且不再依赖 buildProviderOptions 每次渲染新建的数组身份触发 effect
  const newAgentProvider = providerOverride && providerOptions.some((o) => o.value === providerOverride && !o.disabled)
    ? providerOverride
    : providerOptions.find((o) => !o.disabled)?.value ?? '';

  // #403：roster 全量正本（TTL/单飞去重）+ 本频道成员面兜底拉取（页面已水合则 TTL 内零请求）
  useEffect(() => {
    void useRosterStore.getState().ensureFresh();
  }, []);

  useEffect(() => {
    if (!channelId) return;
    void useChannelDataStore.getState().ensureMembers(channelId);
  }, [channelId]);

  // 两分支合并：全量 active 为底本（activeAgentsOf 对齐服务端默认排除 studio 语义）；
  // memberIds 空 = 所有 Agent 可见（成员区展示空态）
  const allAgents = useMemo(() => activeAgentsOf(profiles), [profiles]);
  const members = useMemo(
    () => (memberIds && memberIds.length > 0 ? allAgents.filter((a) => memberIds.includes(a.id)) : []),
    [allAgents, memberIds],
  );
  const availableAgents = useMemo(
    () => allAgents.filter((a) => !(memberIds ?? []).includes(a.id)),
    [allAgents, memberIds],
  );
  const memberCount = memberIds?.length ?? 0;

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowCreateForm(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // 写穿以调用完成时刻的 store 最新值为基（不从渲染闭包取 memberIds——await 期间可能已被并发修改）
  // 批次A 项8：增删失败 toast（服务端 error.message 优先），不再 console.error 静默
  const handleAdd = async (agentId: string) => {
    try {
      await channelApi.updateMembers(channelId, { add: [agentId] });
      const cur = useChannelDataStore.getState().members[channelId] ?? [];
      useChannelDataStore.getState().setMembers(channelId, [...new Set([...cur, agentId])]);
    } catch (e) {
      const m = serverErrorMessage(e);
      toast.error(m ? `添加成员失败：${m}` : '添加成员失败，请重试');
    }
  };

  const handleRemove = async (agentId: string) => {
    try {
      await channelApi.updateMembers(channelId, { remove: [agentId] });
      const cur = useChannelDataStore.getState().members[channelId] ?? [];
      useChannelDataStore.getState().setMembers(channelId, cur.filter((id) => id !== agentId));
    } catch (e) {
      const m = serverErrorMessage(e);
      toast.error(m ? `移除成员失败：${m}` : '移除成员失败，请重试');
    }
  };

  const handleCreateAgent = async () => {
    if (!newAgentName.trim() || !newAgentProvider || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await channelApi.createAgent({
        name: newAgentName.trim(),
        description: newAgentDesc.trim() || undefined,
        provider: newAgentProvider,
        channels: [channelId],
      });
      const newAgent = res.data;
      // 创建即加入本频道（成员关系事实源 = channel.members）
      await channelApi.updateMembers(channelId, { add: [newAgent.id] });
      const cur = useChannelDataStore.getState().members[channelId] ?? [];
      useChannelDataStore.getState().setMembers(channelId, [...new Set([...cur, newAgent.id])]);
      setNewAgentName('');
      setNewAgentDesc('');
      setProviderOverride('');
      setShowCreateForm(false);
    } catch (e) {
      console.error('Failed to create agent', e);
      setCreateError(e instanceof Error ? e.message : '创建失败，请重试');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={triggerClassName ?? 'mc-btn'}
        title="Channel 成员管理"
      >
        成员 <span>{memberCount > 0 ? `${memberCount} agents` : 'All'}</span>
      </button>

      {isOpen && (
        <div className="mc-mention-popup" style={{ left: 'auto', right: 0, bottom: 'auto', top: '100%', marginTop: 4, width: 288, maxHeight: 'none' }}>
          <div className="border-b u-border" style={{ padding: '8px 10px' }}>
            <h3 className="mc-card-body" style={{ fontWeight: 600 }}>频道成员</h3>
            {memberCount === 0 && (
              <p className="mc-drawer-note">空 = 所有 Agent 可见</p>
            )}
          </div>

          {/* Current members */}
          <div style={{ maxHeight: 160, overflowY: 'auto', padding: '4px 6px' }}>
            {members.length === 0 && memberCount === 0 && (
              /* #290（清单 #25）：空成员三处文案统一口径「空 = 所有 Agent 可见」（按钮 All / 说明 / 空态） */
              <p className="mc-drawer-note" style={{ textAlign: 'center', padding: '8px 0' }}>未配置成员（空 = 所有 Agent 可见）</p>
            )}
            {members.map((m) => (
              <div key={m.id} className="mc-mention-item" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>@{m.name}</span>
                  {m.lastError && (
                    <span className="mc-status mc-status-error" title={m.lastError}>! 不可用</span>
                  )}
                  {m.description && (
                    <span className="mc-mention-desc">{m.description}</span>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(m.id)}
                  className="mc-icon-btn"
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Add existing agent */}
          {availableAgents.length > 0 && (
            <div className="border-t u-border" style={{ padding: '4px 6px' }}>
              <p className="mc-drawer-note" style={{ padding: '0 4px' }}>添加 Agent</p>
              {availableAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => handleAdd(a.id)}
                  className="mc-mention-item"
                >
                  <span>@{a.name}</span>
                  <span className="mc-mention-desc">+</span>
                </button>
              ))}
            </div>
          )}

          {/* Create new agent */}
          <div className="border-t u-border" style={{ padding: 8 }}>
            {showCreateForm ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder="Agent 名称"
                  className="input"
                  autoFocus
                  disabled={creating}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateAgent()}
                />
                <input
                  type="text"
                  value={newAgentDesc}
                  onChange={(e) => setNewAgentDesc(e.target.value)}
                  placeholder="描述（可选）"
                  className="input"
                  disabled={creating}
                />
                <Select
                  value={newAgentProvider}
                  onChange={setProviderOverride}
                  options={providerOptions}
                  className="input"
                  title="背后的 CLI"
                  disabled={creating}
                />
                {createError && (
                  <p className="mc-drawer-note" style={{ color: 'var(--error)', margin: 0 }}>{createError}</p>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={handleCreateAgent}
                    className="mc-btn mc-btn-primary"
                    style={{ flex: 1 }}
                    disabled={!newAgentName.trim() || !newAgentProvider || creating}
                  >
                    {creating ? '创建中…' : '创建并加入频道'}
                  </button>
                  <button
                    onClick={() => { setShowCreateForm(false); setNewAgentName(''); setNewAgentDesc(''); setProviderOverride(''); setCreateError(null); }}
                    className="mc-btn"
                    style={{ flex: 1 }}
                    disabled={creating}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCreateForm(true)}
                className="mc-icon-btn"
                style={{ opacity: 1, width: '100%', textAlign: 'center', color: 'var(--accent-primary)' }}
              >
                + 创建新 Agent
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
