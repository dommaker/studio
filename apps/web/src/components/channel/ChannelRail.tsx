// ChannelRail — Mission Control 左栏：频道列表（未读 badge + agent 在线数）+ Agent 状态
// 数据：useChannelList（与 ChannelHomeRedirect 同源，#346 起频道走 rosterStore）+ rosterStore.agents
// #312/#313：agent.instance.status_changed SSE 就地更新与轮询兜底已收敛到 rosterStore +
//   useRosterStoreSync（#346），本组件只订阅 selector 并派生视图（visibleAgents / 在线计数）
// #272（决策 #251 Q7）：创建表单合并为单一实现 CreateChannelForm
// F4 渲染边界：频道行抽 memo 子组件 ChannelRow + 行内 per-channel unread selector
//   （s.unreadCounts[ch.id]）——他频道来消息只重渲对应行，不透传整栏；
//   members JSON 解析随 channels 切片 memo（memberIdsByChannel），不再 render 内逐行 parse
import { memo, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatChannelName } from '@dommaker/studio-shared/web';
import { useChannelList, type ChannelListItem } from '../../hooks/useChannelList';
import { useRosterStore } from '../../stores/rosterStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useRosterStoreSync } from '../../hooks/useRosterStoreSync';
import { agentDotClass } from './statusClasses';
import { CreateChannelForm } from './CreateChannelForm';
import { SkeletonText } from '../ui';

const TYPE_LABELS: Record<string, string> = {
  rnd: '研发',
  decision: '决策',
  system: '系统',
};

/** members JSON → agent id 数组（无配置/非法/空数组 → null，调用方回退类型标签，不编造） */
function parseMembers(membersJson?: string): string[] | null {
  if (!membersJson) return null;
  try {
    const ids = JSON.parse(membersJson) as string[];
    return Array.isArray(ids) && ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** F4 频道行 memo 边界：unread 行内 per-channel selector（他频道未读变化不透传本行）；
 *  其余 props（ch / memberIds / agentStatusById / onSelect）引用稳定时父级重渲零重渲 */
const ChannelRow = memo(function ChannelRow({ ch, isActive, memberIds, agentStatusById, onSelect }: {
  ch: ChannelListItem;
  isActive: boolean;
  memberIds: string[] | null;
  agentStatusById: Map<string, string>;
  onSelect: (id: string) => void;
}) {
  const unread = useUnreadStore(s => s.unreadCounts[ch.id] ?? 0);
  // 频道 agent 在线数：members ∩ 非 terminated agent
  const counts = memberIds
    ? { online: memberIds.filter(id => {
        const s = agentStatusById.get(id);
        return !!s && s !== 'terminated';
      }).length, total: memberIds.length }
    : null;
  return (
    <button
      className={isActive ? 'mc-chan mc-chan-active' : 'mc-chan'}
      onClick={() => onSelect(ch.id)}
    >
      <span className="mc-chan-hash">#</span>
      {/* #429：数据本身含前导 #，formatChannelName 归一为单前缀后去掉 glyph 位（# 由上一 span 承担） */}
      <span className="mc-chan-name">{formatChannelName(ch.name).slice(1)}</span>
      <span className="mc-chan-meta">
        {counts ? `${counts.online}/${counts.total}` : (TYPE_LABELS[ch.type] || ch.type)}
      </span>
      {unread > 0 && (
        <span className="mc-chan-badge">{unread > 99 ? '99+' : unread}</span>
      )}
    </button>
  );
});

interface Props {
  activeChannelId?: string;
  // #395：并入全局 Sidebar（<768）时选中频道/创建完成需收起 sidebar overlay——导航后回调
  onNavigate?: () => void;
}

export function ChannelRail({ activeChannelId, onNavigate }: Props) {
  const { channels, loading, clearUnread, createChannel } = useChannelList();
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

  // F4：members JSON 解析随 channels 切片 memo（引用稳定 → ChannelRow memo 生效）
  const memberIdsByChannel = useMemo(() => {
    const m = new Map<string, string[] | null>();
    for (const ch of channels) m.set(ch.id, parseMembers(ch.members));
    return m;
  }, [channels]);

  const handleSelect = useCallback((id: string) => {
    clearUnread(id);
    if (id !== activeChannelId) navigate(`/channels/${id}`);
    onNavigate?.();
  }, [clearUnread, activeChannelId, navigate, onNavigate]);

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
          onCreated={ch => { setShowNewForm(false); navigate(`/channels/${ch.id}`); onNavigate?.(); }}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      <nav className="mc-rail-list" aria-label="频道列表">
        {loading && <SkeletonText lines={3} className="space-y-2 m-3" />}
        {!loading && channels.length === 0 && (
          <div className="mc-rail-empty">暂无频道，点击「+ 新频道」创建</div>
        )}
        {channels.map(ch => (
          <ChannelRow
            key={ch.id}
            ch={ch}
            isActive={ch.id === activeChannelId}
            memberIds={memberIdsByChannel.get(ch.id) ?? null}
            agentStatusById={agentStatusById}
            onSelect={handleSelect}
          />
        ))}
      </nav>

      <div className="mc-agents">
        <div className="mc-sec-label">
          Agents{agentsLoadedOnce ? ` · ${onlineCount}/${visibleAgents.length}` : ''}
        </div>
        {agentsForbidden ? (
          <div className="mc-rail-empty">无权限查看 Agent 状态（需 Admin 权限）</div>
        ) : (
          !agentsLoadedOnce && <SkeletonText lines={2} className="space-y-2 m-3" />
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
