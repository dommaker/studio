// Channel Member Manager — AC-B frontend gap
// 2026-07 视觉重构（方向 A Mission Control）：深色变量重绘；成员管理逻辑零变更
import React, { useEffect, useState, useRef } from 'react';
import { channelApi, type AgentProfile } from '../../api/channel';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { Select } from '../ui';

interface ChannelMemberManagerProps {
  channelId: string;
  membersJson?: string;
}

export const ChannelMemberManager: React.FC<ChannelMemberManagerProps> = ({
  channelId,
  membersJson = '[]',
}) => {
  const [memberIds, setMemberIds] = useState<string[]>(() => {
    try { return JSON.parse(membersJson); } catch { return []; }
  });
  const [members, setMembers] = useState<AgentProfile[]>([]);
  const [allAgents, setAllAgents] = useState<AgentProfile[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  // 用户显式选择的 CLI；空 = 未选过（或选择已失效），由下方派生值回退默认
  const [providerOverride, setProviderOverride] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders();
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  // membersJson 是异步加载的 — 初始 '[]' 只是占位，props 到达/切换频道时必须重新同步，
  // 否则刷新页面或切换频道后成员列表停留在初始空值（state 初始化器只跑一次）。
  // 渲染期调整模式：membersJson 变化时同步重解析，避免一帧旧值闪烁
  const [prevMembersJson, setPrevMembersJson] = useState(membersJson);
  if (prevMembersJson !== membersJson) {
    setPrevMembersJson(membersJson);
    try { setMemberIds(JSON.parse(membersJson)); } catch { setMemberIds([]); }
  }

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

  // Load member profiles and all available agents
  useEffect(() => {
    if (memberIds.length > 0) {
      channelApi.listAgents().then((res) => {
        const agents = res.data.data;
        setAllAgents(agents);
        setMembers(agents.filter((a) => memberIds.includes(a.id)));
      });
    } else {
      channelApi.listAgents().then((res) => {
        setAllAgents(res.data.data);
      });
    }
  }, [memberIds]);

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

  const handleAdd = async (agentId: string) => {
    try {
      await channelApi.updateMembers(channelId, { add: [agentId] });
      setMemberIds((prev) => [...new Set([...prev, agentId])]);
    } catch (e) {
      console.error('Failed to add member', e);
    }
  };

  const handleRemove = async (agentId: string) => {
    try {
      await channelApi.updateMembers(channelId, { remove: [agentId] });
      setMemberIds((prev) => prev.filter((id) => id !== agentId));
      setMembers((prev) => prev.filter((m) => m.id !== agentId));
    } catch (e) {
      console.error('Failed to remove member', e);
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
      setMemberIds((prev) => [...new Set([...prev, newAgent.id])]);
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

  const availableAgents = allAgents.filter((a) => !memberIds.includes(a.id));
  const memberCount = memberIds.length;

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="mc-btn"
        title="Channel 成员管理"
      >
        成员 <span>{memberCount > 0 ? `${memberCount} agents` : 'All'}</span>
      </button>

      {isOpen && (
        <div className="mc-mention-popup" style={{ left: 'auto', right: 0, bottom: 'auto', top: '100%', marginTop: 4, width: 288, maxHeight: 'none' }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
            <h3 className="mc-card-body" style={{ fontWeight: 600 }}>频道成员</h3>
            {memberCount === 0 && (
              <p className="mc-drawer-note">空 = 所有 Agent 可见</p>
            )}
          </div>

          {/* Current members */}
          <div style={{ maxHeight: 160, overflowY: 'auto', padding: '4px 6px' }}>
            {members.length === 0 && memberCount === 0 && (
              <p className="mc-drawer-note" style={{ textAlign: 'center', padding: '8px 0' }}>未配置成员，显示所有 Agent</p>
            )}
            {members.map((m) => (
              <div key={m.id} className="mc-mention-item" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>@{m.name}</span>
                  {m.lastError && (
                    <span className="mc-status mc-status-running" title={m.lastError}>! 不可用</span>
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
            <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '4px 6px' }}>
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
          <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 8 }}>
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
