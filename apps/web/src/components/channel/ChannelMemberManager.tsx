// Channel Member Manager — AC-B frontend gap
import React, { useEffect, useState, useRef } from 'react';
import { channelApi, type AgentProfile } from '../../api/channel';

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
  const [showCreateForm, setShowCreateForm] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

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
    if (!newAgentName.trim()) return;
    try {
      const res = await channelApi.createAgent({
        name: newAgentName.trim(),
        channels: [channelId],
      });
      const newAgent = res.data;
      await channelApi.updateMembers(channelId, { add: [newAgent.id] });
      setMemberIds((prev) => [...new Set([...prev, newAgent.id])]);
      setNewAgentName('');
      setShowCreateForm(false);
    } catch (e) {
      console.error('Failed to create agent', e);
    }
  };

  const availableAgents = allAgents.filter((a) => !memberIds.includes(a.id));
  const memberCount = memberIds.length;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 bg-gray-50 rounded hover:bg-gray-100"
        title="Channel 成员管理"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <span>{memberCount > 0 ? `${memberCount} agents` : 'All'}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div className="px-3 py-2 border-b border-gray-100">
            <h3 className="text-sm font-medium text-gray-700">频道成员</h3>
            {memberCount === 0 && (
              <p className="text-xs text-gray-400 mt-0.5">空 = 所有 Agent 可见</p>
            )}
          </div>

          {/* Current members */}
          <div className="max-h-40 overflow-y-auto px-2 py-1">
            {members.length === 0 && memberCount === 0 && (
              <p className="text-xs text-gray-400 text-center py-2">未配置成员，显示所有 Agent</p>
            )}
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-1 px-1 rounded hover:bg-gray-50">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-gray-700 truncate">@{m.name}</span>
                  {m.lastError && (
                    <span className="text-xs text-orange-500 flex-shrink-0" title={m.lastError}>⚠ 不可用</span>
                  )}
                  {m.description && (
                    <span className="text-xs text-gray-400 truncate">{m.description}</span>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(m.id)}
                  className="text-gray-400 hover:text-red-500 text-xs flex-shrink-0"
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Add existing agent */}
          {availableAgents.length > 0 && (
            <div className="border-t border-gray-100 px-2 py-1">
              <p className="text-xs text-gray-400 px-1 py-1">添加 Agent</p>
              {availableAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => handleAdd(a.id)}
                  className="w-full text-left px-2 py-1 text-sm text-gray-600 hover:bg-blue-50 hover:text-blue-600 rounded flex items-center justify-between"
                >
                  <span>@{a.name}</span>
                  <span className="text-xs text-gray-400">+</span>
                </button>
              ))}
            </div>
          )}

          {/* Create new agent */}
          <div className="border-t border-gray-100 px-3 py-2">
            {showCreateForm ? (
              <div className="flex flex-col gap-1">
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder="Agent 名称"
                  className="px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:border-blue-400"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateAgent()}
                />
                <div className="flex gap-1">
                  <button
                    onClick={handleCreateAgent}
                    className="flex-1 px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
                  >
                    创建
                  </button>
                  <button
                    onClick={() => { setShowCreateForm(false); setNewAgentName(''); }}
                    className="flex-1 px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCreateForm(true)}
                className="w-full text-center text-xs text-blue-500 hover:text-blue-600 py-1"
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
