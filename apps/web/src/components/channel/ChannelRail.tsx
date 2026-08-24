// ChannelRail — Mission Control 左栏：频道列表（未读 badge + agent 在线数）+ Agent 状态
// 数据：useChannelList（与 ChannelListPage 同源）+ monitoringApi.getAgentSummary（真实 API）
// #312：agent.instance.status_changed SSE 就地更新状态点/lastError，30s 轮询退位为纯兜底
// #272（决策 #251 Q7）：创建表单与 ChannelListPage 合并为单一实现 CreateChannelForm
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannelList } from '../../hooks/useChannelList';
import { monitoringApi, type AgentSummary } from '../../api/monitoring';
import { useWebSocketContext, type WebSocketMessage } from '../../api/websocketHooks';
import { isForbidden } from '../../utils/http';
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
  const { onEvent } = useWebSocketContext();
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  // #283：monitoring 接口 Admin-only，非 Admin 403 → 「无权限」终态并停止轮询（不再刷 403）
  const [agentsForbidden, setAgentsForbidden] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const navigate = useNavigate();

  // Agent 状态：挂载加载 + 30s 刷新（只读展示，与监控页同源）
  useEffect(() => {
    let alive = true;
    const load = () => {
      monitoringApi.getAgentSummary()
        .then(r => { if (alive) setAgentSummary(r.data); })
        .catch(err => {
          if (!alive) return;
          if (isForbidden(err)) {
            setAgentsForbidden(true);
            clearInterval(timer); // 403 是无权限终态：停止轮询，不再刷 403
          }
        });
    };
    // timer 先赋值再首查：catch 里的 clearInterval 不依赖微任务时序
    const timer = setInterval(load, 30000);
    load();
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // #312：SSE 就地更新（轮询退位为纯兜底）。只更新已加载实例——新实例靠 30s 轮询兜底发现；
  // 计数（online/visible）由 useMemo 从 agents 状态推导，事件落库即自动重算
  useEffect(() => {
    const unsub = onEvent((msg: WebSocketMessage) => {
      if (msg.event_type !== 'agent.instance.status_changed') return;
      const d = (msg.data ?? {}) as {
        profileId?: string;
        instanceId?: string;
        status?: string;
        currentWorkUnitId?: string | null;
        lastError?: string | null;
        lastErrorAt?: string | null;
      };
      if (!d.profileId && !d.instanceId) return;
      setAgentSummary(prev => {
        if (!prev) return prev;
        let touched = false;
        const agents = prev.agents.map(a => {
          // error 事件可能携带新建 error state 的 instanceId（≠列表里的 id），roleId 兜底匹配
          if (a.id !== d.instanceId && a.roleId !== d.profileId) return a;
          touched = true;
          return {
            ...a,
            status: d.status ?? a.status,
            currentWorkUnitId: d.currentWorkUnitId !== undefined ? d.currentWorkUnitId : a.currentWorkUnitId,
            lastError: d.lastError !== undefined ? d.lastError : a.lastError,
            lastErrorAt: d.lastErrorAt !== undefined ? d.lastErrorAt : a.lastErrorAt,
          };
        });
        return touched ? { ...prev, agents } : prev;
      });
    });
    return unsub;
  }, [onEvent]);

  const agentStatusById = useMemo(() => {
    const m = new Map<string, string>();
    agentSummary?.agents.forEach(a => m.set(a.id, a.status));
    return m;
  }, [agentSummary]);

  // 可见 Agent 列表：按 roleId 去重（取最新一条，agents 已按 startedAt 降序）+ 过滤 terminated
  // terminated 是历史运行实例残留，频道侧栏只展示当前活跃角色（与 AgentDashboardPage 同模式）
  const visibleAgents = useMemo(() => {
    const seen = new Set<string>();
    return (agentSummary?.agents ?? []).filter(a => {
      if (a.status === 'terminated') return false;
      const key = a.roleId || a.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [agentSummary]);

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
          Agents{agentSummary ? ` · ${onlineCount}/${visibleAgents.length}` : ''}
        </div>
        {agentsForbidden ? (
          <div className="mc-rail-empty">无权限查看 Agent 状态（需 Admin 权限）</div>
        ) : (
          !agentSummary && <div className="mc-rail-empty">加载中…</div>
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
