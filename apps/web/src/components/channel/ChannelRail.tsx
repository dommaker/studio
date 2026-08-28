// ChannelRail — Mission Control 左栏：频道列表（未读 badge + agent 在线数）+ Agent 状态
// 数据：useChannelList（与 ChannelListPage 同源，#346 起频道走 rosterStore）+ rosterStore.agents
// #312/#313：agent.instance.status_changed SSE 就地更新与轮询兜底已收敛到 rosterStore +
//   useRosterStoreSync（#346），本组件只订阅 selector 并派生视图（visibleAgents / 在线计数）
// #272（决策 #251 Q7）：创建表单与 ChannelListPage 合并为单一实现 CreateChannelForm
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannelList } from '../../hooks/useChannelList';
import { useRosterStore } from '../../stores/rosterStore';
import { useRosterStoreSync } from '../../hooks/useRosterStoreSync';
import { agentDotClass } from './statusClasses';
import { CreateChannelForm } from './CreateChannelForm';

const TYPE_LABELS: Record<string, string> = {
  rnd: '研发',
  decision: '决策',
  system: '系统',
};

interface Props {
  activeChannelId?: string;
}

export function ChannelRail({ activeChannelId }: Props) {
  const { channels, loading, unreadCounts, clearUnread, createChannel } = useChannelList();
  useRosterStoreSync();
  const agents = useRosterStore((s) => s.agents);
  const agentsLoadedOnce = useRosterStore((s) => s.agentsLoadedOnce);
  const agentsForbidden = useRosterStore((s) => s.forbidden);
  const [showNewForm, setShowNewForm] = useState(false);
  const navigate = useNavigate();

  const agentStatusById = useMemo(() => {
    const m = new Map<string, string>();
    agents.forEach(a => m.set(a.id, a.status));
    return m;
  }, [agents]);

  // 可见 Agent 列表：按 roleId 去重（取最新一条，agents 已按 startedAt 降序）+ 过滤 terminated
  // terminated 是历史运行实例残留，频道侧栏只展示当前活跃角色（与 AgentDashboardPage 同模式）
  const visibleAgents = useMemo(() => {
    const seen = new Set<string>();
    return agents.filter(a => {
      if (a.status === 'terminated') return false;
      const key = a.roleId || a.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [agents]);

  const onlineCount = visibleAgents.filter(a => a.status === 'idle' || a.status === 'active').length;

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
        <CreateChannelForm
          createChannel={createChannel}
          onCreated={ch => { setShowNewForm(false); navigate(`/channels/${ch.id}`); }}
          onCancel={() => setShowNewForm(false)}
        />
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
          Agents{agentsLoadedOnce ? ` · ${onlineCount}/${visibleAgents.length}` : ''}
        </div>
        {agentsForbidden ? (
          <div className="mc-rail-empty">无权限查看 Agent 状态（需 Admin 权限）</div>
        ) : (
          !agentsLoadedOnce && <div className="mc-rail-empty">加载中…</div>
        )}
        {visibleAgents.map(a => (
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
