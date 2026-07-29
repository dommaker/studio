// ChannelRail — Mission Control 左栏：频道列表（未读 badge + agent 在线数）+ Agent 状态
// 数据：useChannelList（与 ChannelListPage 同源）+ monitoringApi.getAgentSummary（真实 API）
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannelList } from '../../hooks/useChannelList';
import { monitoringApi, type AgentSummary } from '../../api/monitoring';
import { Select } from '../ui';

const TYPE_LABELS: Record<string, string> = {
  rnd: '研发',
  decision: '决策',
  system: '系统',
};

/** agent 状态 → 状态点修饰类（active=执行中 pulse / idle=在线 / error=故障 / 其余=离线） */
export function agentDotClass(status: string): string {
  if (status === 'active') return 'mc-dot mc-dot-busy';
  if (status === 'idle') return 'mc-dot mc-dot-online';
  if (status === 'error') return 'mc-dot mc-dot-error';
  return 'mc-dot mc-dot-offline';
}

interface Props {
  activeChannelId?: string;
}

export function ChannelRail({ activeChannelId }: Props) {
  const { channels, loading, unreadCounts, clearUnread, createChannel } = useChannelList();
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('rnd');
  const [newAgents, setNewAgents] = useState('');
  const [createError, setCreateError] = useState('');
  const navigate = useNavigate();

  // Agent 状态：挂载加载 + 30s 刷新（只读展示，与监控页同源）
  useEffect(() => {
    let alive = true;
    const load = () => {
      monitoringApi.getAgentSummary()
        .then(r => { if (alive) setAgentSummary(r.data); })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const agentStatusById = useMemo(() => {
    const m = new Map<string, string>();
    agentSummary?.agents.forEach(a => m.set(a.id, a.status));
    return m;
  }, [agentSummary]);

  // 频道 agent 在线数：members ∩ 非 terminated agent（无 members 配置则不显示，不编造）
  const chanCounts = (membersJson?: string): { online: number; total: number } | null => {
    if (!membersJson) return null;
    try {
      const ids = JSON.parse(membersJson) as string[];
      if (!Array.isArray(ids) || ids.length === 0) return null;
      const online = ids.filter(id => {
        const s = agentStatusById.get(id);
        return !!s && s !== 'terminated';
      }).length;
      return { online, total: ids.length };
    } catch {
      return null;
    }
  };

  const handleSelect = (id: string) => {
    clearUnread(id);
    if (id !== activeChannelId) navigate(`/channels/${id}`);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreateError('');
    try {
      const agents = newAgents.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      const ch = await createChannel({ name: newName.trim(), type: newType, agents });
      setShowNewForm(false);
      setNewName('');
      setNewAgents('');
      navigate(`/channels/${ch.id}`);
    } catch (err: any) {
      setCreateError(err?.response?.data?.error || '创建失败');
    }
  };

  return (
    <aside className="mc-rail" aria-label="频道栏">
      <div className="mc-rail-head">
        <div className="mc-sec-label" style={{ padding: 0 }}>频道</div>
        <button
          className="mc-rail-new"
          onClick={() => setShowNewForm(v => !v)}
          aria-expanded={showNewForm}
        >
          {showNewForm ? '− 收起' : '+ 新频道'}
        </button>
      </div>

      {showNewForm && (
        <div className="mc-newchan">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="#频道名称"
            aria-label="频道名称"
            autoFocus
          />
          <textarea
            value={newAgents}
            onChange={e => setNewAgents(e.target.value)}
            placeholder="初始 Agent（可选，逗号分隔）"
            aria-label="初始 Agent"
            rows={2}
          />
          <div className="mc-newchan-row">
            <Select
              value={newType}
              onChange={setNewType}
              options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
              aria-label="频道类型"
            />
            <button className="mc-btn mc-btn-primary" onClick={handleCreate}>创建</button>
            <button className="mc-btn" onClick={() => { setShowNewForm(false); setNewName(''); setNewAgents(''); }}>
              取消
            </button>
          </div>
          {createError && <div className="mc-newchan-error">{createError}</div>}
        </div>
      )}

      <nav className="mc-rail-list" aria-label="频道列表">
        {loading && <div className="mc-rail-empty">加载中…</div>}
        {!loading && channels.length === 0 && (
          <div className="mc-rail-empty">暂无频道，点击「+ 新频道」创建</div>
        )}
        {channels.map(ch => {
          const counts = chanCounts(ch.members);
          const unread = unreadCounts[ch.id] || 0;
          return (
            <button
              key={ch.id}
              className={ch.id === activeChannelId ? 'mc-chan mc-chan-active' : 'mc-chan'}
              onClick={() => handleSelect(ch.id)}
            >
              <span className="mc-chan-hash">#</span>
              <span className="mc-chan-name">{ch.name}</span>
              <span className="mc-chan-meta">
                {counts ? `${counts.online}/${counts.total}` : (TYPE_LABELS[ch.type] || ch.type)}
              </span>
              {unread > 0 && (
                <span className="mc-chan-badge">{unread > 99 ? '99+' : unread}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mc-agents">
        <div className="mc-sec-label">
          Agents{agentSummary ? ` · ${agentSummary.summary.idle + agentSummary.summary.active}/${agentSummary.summary.total}` : ''}
        </div>
        {!agentSummary && <div className="mc-rail-empty">加载中…</div>}
        {agentSummary?.agents.map(a => (
          <div className="mc-agent" key={a.id} title={a.lastError || undefined}>
            <span className={agentDotClass(a.status)} />
            <span className="mc-agent-name">@{a.name}</span>
            <span className="mc-agent-role">{a.status}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
