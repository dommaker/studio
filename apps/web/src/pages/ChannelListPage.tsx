// Channel List Page — B2: 首页 = 频道列表 + Agent 状态栏
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useWebSocketContext } from '../api/websocket';

interface ChannelItem {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  rnd: '研发',
  decision: '决策',
  system: '系统',
};

export function ChannelListPage() {
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('rnd');
  const [newAgents, setNewAgents] = useState(''); // comma-separated agent names
  // B2-011: per-channel unread counters
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const { onEvent } = useWebSocketContext();
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/channels').then(r => {
      const list = r.data.data || [];
      setChannels(list);
      // B2-010: 默认展开 #研发
      const rnd = list.find((c: ChannelItem) => c.type === 'rnd');
      if (rnd && window.location.pathname === '/') {
        navigate(`/channels/${rnd.id}`, { replace: true });
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [navigate]);

  // B2-011: SSE track unread messages per channel
  useEffect(() => {
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as any;
        if (data?.channelId && data?.message?.authorType !== 'human') {
          setUnreadCounts(prev => ({
            ...prev,
            [data.channelId]: (prev[data.channelId] || 0) + 1,
          }));
        }
      }
    });
    return unsub;
  }, [onEvent]);

  const clearUnread = (channelId: string) => {
    setUnreadCounts(prev => { const next = { ...prev }; delete next[channelId]; return next; });
  };

  // B2-007: Create new channel (with optional initial agents)
  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      // Parse agent names from comma/newline-separated input
      const agentNames = newAgents
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(Boolean);
      const agents = agentNames.map(name => ({ name }));

      const res = await api.post('/channels', {
        name: newName.trim(),
        type: newType,
        ...(agents.length > 0 ? { agents } : {}),
      });
      const ch = res.data.data;
      setChannels(prev => [...prev, ch]);
      setShowNewForm(false);
      setNewName('');
      setNewAgents('');
      navigate(`/channels/${ch.id}`);
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to create channel');
    }
  };

  return (
    <div className="flex h-full">
      {/* Left: Channel list */}
      <div className="flex-1 max-w-lg mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">Channels</h1>
          <button
            onClick={() => setShowNewForm(!showNewForm)}
            className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
          >
            + 新频道
          </button>
        </div>

        {/* B2-007: New channel form */}
        {showNewForm && (
          <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="#频道名称"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1 mb-2"
              autoFocus
            />
            <textarea
              value={newAgents}
              onChange={e => setNewAgents(e.target.value)}
              placeholder="初始 Agent（可选，逗号分隔）&#10;例: Analyst, Executor, Reviewer"
              className="w-full text-xs border border-gray-300 rounded px-2 py-1 mb-2 resize-none"
              rows={2}
            />
            <div className="flex items-center gap-2">
              <select value={newType} onChange={e => setNewType(e.target.value)}
                className="text-xs border border-gray-300 rounded px-1 py-0.5">
                <option value="rnd">研发</option>
                <option value="decision">决策</option>
                <option value="system">系统</option>
              </select>
              <button onClick={handleCreate}
                className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded hover:bg-blue-600">
                创建
              </button>
              <button onClick={() => { setShowNewForm(false); setNewName(''); setNewAgents(''); }}
                className="text-xs text-gray-400 hover:text-gray-600">
                取消
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-gray-400 text-sm py-12 text-center">加载中...</div>
        ) : channels.length === 0 ? (
          <div className="text-gray-400 text-sm py-12 text-center">
            <p className="mb-2">暂无频道</p>
            <p className="text-xs">点击"+ 新频道"创建第一个频道</p>
          </div>
        ) : (
          <div className="space-y-1">
            {channels.map(ch => (
              <button
                key={ch.id}
                onClick={() => { clearUnread(ch.id); navigate(`/channels/${ch.id}`); }}
                className="w-full text-left px-4 py-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200"
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${
                    ch.type === 'system' ? 'bg-orange-400' :
                    ch.type === 'decision' ? 'bg-purple-400' : 'bg-blue-400'
                  }`} />
                  <span className="font-medium text-gray-900">{ch.name}</span>
                  <span className="text-xs text-gray-400">
                    {TYPE_LABELS[ch.type] || ch.type}
                  </span>
                  {/* B2-011: Unread badge */}
                  {unreadCounts[ch.id] > 0 && (
                    <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                      {unreadCounts[ch.id] > 99 ? '99+' : unreadCounts[ch.id]}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-8 p-4 bg-gray-50 rounded-lg text-xs text-gray-500">
          <p className="font-medium text-gray-700 mb-1">快速开始</p>
          <p>1. 进入 <span className="text-blue-500">#研发</span> 频道</p>
          <p>2. 输入需求 ≥30 字并包含 <span className="text-blue-500">@Analyst</span></p>
          <p>3. 等待 Analyst 分析并生成执行计划</p>
          <p>4. 点击"开始执行"触发自动开发</p>
        </div>
      </div>

      {/* Right: Agent status bar */}
      <div className="w-56 border-l border-gray-100 px-4 py-8 bg-gray-50/50">
        <h2 className="text-xs font-semibold text-gray-500 uppercase mb-3">Agent 状态</h2>
        <div className="space-y-2 text-sm">
          <AgentStatus name="Analyst" status="idle" desc="等待 @mention" />
          <AgentStatus name="Executor" status="idle" desc="等待调度" />
          <AgentStatus name="Reviewer" status="idle" desc="等待审查" />
          <AgentStatus name="KK" status="idle" desc="在线" />
          <AgentStatus name="Auditor" status="idle" desc="下次: 每日" />
        </div>
      </div>
    </div>
  );
}

function AgentStatus({ name, status, desc }: { name: string; status: 'idle' | 'busy'; desc: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`w-2 h-2 rounded-full ${status === 'busy' ? 'bg-blue-500 animate-pulse' : 'bg-green-400'}`} />
      <span className="text-gray-700">@{name}</span>
      <span className="text-xs text-gray-400 ml-auto">{desc}</span>
    </div>
  );
}
