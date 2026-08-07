// Channel List Page — B2: 首页 = 频道列表 + Agent 状态栏
// 2026-07 视觉重构（方向 A Mission Control）：数据逻辑收敛到 useChannelList（与 ChannelRail 同源），
// Agent 状态栏改接 monitoringApi 真实数据；路由与创建频道能力保留
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChannelList, type ChannelListItem } from '../hooks/useChannelList';
import { monitoringApi, type AgentSummary } from '../api/monitoring';
import { agentDotClass } from '../components/channel/ChannelRail';
import { Select, ConfirmDialog, Button } from '../components/ui';

const TYPE_LABELS: Record<string, string> = {
  rnd: '研发',
  decision: '决策',
  system: '系统',
};

export function ChannelListPage() {
  const { channels, loading, unreadCounts, clearUnread, createChannel } = useChannelList();
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('rnd');
  const [newAgents, setNewAgents] = useState(''); // comma-separated agent names
  // 创建失败提示（ui/ConfirmDialog 单按钮 alert 模式，替代原生 alert）
  const [createError, setCreateError] = useState<string | null>(null);
  // 工单 38: 创建提交中状态——Button loading 态防连点重复提交
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  // B2-010: 默认展开 #研发
  useEffect(() => {
    if (loading) return;
    const rnd = channels.find((c: ChannelListItem) => c.type === 'rnd');
    if (rnd && window.location.pathname === '/') {
      navigate(`/channels/${rnd.id}`, { replace: true });
    }
  }, [channels, loading, navigate]);

  // Agent 状态栏：真实监控数据（与 Mission Control 左栏同源）
  useEffect(() => {
    let alive = true;
    monitoringApi.getAgentSummary()
      .then(r => { if (alive) setAgentSummary(r.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // B2-007: Create new channel (with optional initial agents)
  const handleCreate = async () => {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const agents = newAgents.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      const ch = await createChannel({ name: newName.trim(), type: newType, agents });
      setShowNewForm(false);
      setNewName('');
      setNewAgents('');
      navigate(`/channels/${ch.id}`);
    } catch (err: any) {
      setCreateError(err?.response?.data?.error || 'Failed to create channel');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Left: Channel list */}
      <div className="flex-1 max-w-lg mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="page-title" style={{ margin: 0 }}>Channels</h1>
          <button onClick={() => setShowNewForm(!showNewForm)} className="mc-btn">
            + 新频道
          </button>
        </div>

        {/* B2-007: New channel form */}
        {showNewForm && (
          <div className="card" style={{ padding: 10, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="#频道名称"
              className="input"
              autoFocus
            />
            <textarea
              value={newAgents}
              onChange={e => setNewAgents(e.target.value)}
              placeholder="初始 Agent（可选，逗号分隔）&#10;例: Analyst, Executor, Reviewer"
              className="input"
              style={{ resize: 'none', fontSize: 'var(--fs-sm)' }}
              rows={2}
            />
            <div className="flex items-center gap-2">
              <Select
                value={newType}
                onChange={setNewType}
                options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
                className="input"
                style={{ padding: '3px 6px' }}
              />
              <Button onClick={handleCreate} loading={creating} loadingLabel="创建中...">
                创建
              </Button>
              <button onClick={() => { setShowNewForm(false); setNewName(''); setNewAgents(''); }} className="mc-btn">
                取消
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="mc-drawer-note" style={{ textAlign: 'center', padding: '48px 0' }}>加载中...</div>
        ) : channels.length === 0 ? (
          <div className="mc-drawer-note" style={{ textAlign: 'center', padding: '48px 0' }}>
            <p style={{ marginBottom: 4 }}>暂无频道</p>
            <p>点击"+ 新频道"创建第一个频道</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {channels.map(ch => (
              <button
                key={ch.id}
                onClick={() => { clearUnread(ch.id); navigate(`/channels/${ch.id}`); }}
                className="mc-chan"
                style={{ padding: '8px 10px' }}
              >
                <span className="mc-chan-hash">#</span>
                <span className="mc-chan-name" style={{ color: 'var(--text-primary)' }}>{ch.name}</span>
                <span className="mc-chan-meta">{TYPE_LABELS[ch.type] || ch.type}</span>
                {/* B2-011: Unread badge */}
                {unreadCounts[ch.id] > 0 && (
                  <span className="mc-chan-badge">
                    {unreadCounts[ch.id] > 99 ? '99+' : unreadCounts[ch.id]}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="card" style={{ marginTop: 24, padding: 12, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>快速开始</p>
          <p>1. 进入 <span style={{ color: 'var(--accent-primary)' }}>#研发</span> 频道</p>
          <p>2. 输入需求 ≥30 字并包含 <span style={{ color: 'var(--accent-primary)' }}>@Analyst</span></p>
          <p>3. 等待 Analyst 分析并生成执行计划</p>
          <p>4. 点击"开始执行"触发自动开发</p>
        </div>
      </div>

      {/* Right: Agent status bar（真实监控数据） */}
      <div style={{ width: 224, borderLeft: '1px solid var(--border-subtle)', padding: '32px 16px', background: 'var(--bg-secondary)' }}>
        <h2 className="mc-sec-label" style={{ padding: '0 0 8px' }}>Agent 状态</h2>
        {!agentSummary && <div className="mc-drawer-note">加载中…</div>}
        {agentSummary?.agents.map(a => (
          <div className="mc-agent" key={a.id} style={{ padding: '4px 0' }} title={a.lastError || undefined}>
            <span className={agentDotClass(a.status)} />
            <span className="mc-agent-name">@{a.name}</span>
            <span className="mc-agent-role">{a.status}</span>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={createError != null}
        title="创建频道失败"
        message={createError ?? ''}
        confirmLabel="知道了"
        cancelLabel={null}
        onConfirm={() => setCreateError(null)}
        onCancel={() => setCreateError(null)}
      />
    </div>
  );
}
