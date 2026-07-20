// Design Lab — 共享三栏原型壳：A/B 两方向共用信息架构，仅 direction class 分化视觉
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  labAgents,
  labChannels,
  labMessages,
  labRequirements,
  labTokenStat,
  findWorkUnit,
  findRequirement,
  formatTokens,
  type LabMessage,
  type LabWorkUnit,
  type LabRequirement,
} from './mock-data';
import './design-lab.css';

export type LabDirection = 'a' | 'b';

type DrawerState = { kind: 'wu'; id: string } | { kind: 'req'; id: string } | null;

interface ThreadGroup {
  anchor: LabMessage;
  replies: LabMessage[];
}

/** 对齐 ChannelDetailPage 的 groupIntoThreads：workUnit 锚点 + replyTo 回复 */
function groupIntoThreads(messages: LabMessage[]): Array<LabMessage | ThreadGroup> {
  const anchorMap = new Map<string, ThreadGroup>();
  const result: Array<LabMessage | ThreadGroup> = [];
  for (const msg of messages) {
    if (msg.workUnitId && !msg.replyToId) {
      const group: ThreadGroup = { anchor: msg, replies: [] };
      anchorMap.set(msg.id, group);
      result.push(group);
    } else if (msg.replyToId && anchorMap.has(msg.replyToId)) {
      anchorMap.get(msg.replyToId)!.replies.push(msg);
    } else {
      result.push(msg);
    }
  }
  return result;
}

function timeOf(iso: string): string {
  return iso.slice(11, 16);
}

const STATUS_META: Record<string, { cls: string; mark: string; label: string }> = {
  running: { cls: 'dl-status-running', mark: '●', label: '执行中' },
  need_input: { cls: 'dl-status-need', mark: '?', label: '待确认' },
  done: { cls: 'dl-status-done', mark: '✓', label: '完成' },
  pending: { cls: 'dl-status-pending', mark: '◇', label: '待审批' },
};

function StatusBadge({ status, onClick }: { status: string; onClick?: () => void }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  const inner = (
    <>
      {status === 'running' ? <span className="dl-dot" /> : <span>{meta.mark}</span>}
      {meta.label}
    </>
  );
  return onClick ? (
    <button className={`dl-status ${meta.cls}`} onClick={onClick} title="打开 WorkUnit 详情">
      {inner}
    </button>
  ) : (
    <span className={`dl-status ${meta.cls}`}>{inner}</span>
  );
}

export function PrototypeShell({ direction }: { direction: LabDirection }) {
  const [activeChannelId, setActiveChannelId] = useState('ch-design');
  const [showCompleted, setShowCompleted] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [needDrafts, setNeedDrafts] = useState<Record<string, string>>({});
  const [needSent, setNeedSent] = useState<Set<string>>(new Set());
  const [approvals, setApprovals] = useState<Record<string, 'approved' | 'rejected'>>({});

  const activeChannel = labChannels.find((c) => c.id === activeChannelId) ?? labChannels[0];

  // 对齐 ChannelDetailPage：已完成折叠（默认只留最近 2 条）
  const { items, hiddenCompleted } = useMemo(() => {
    const completed = labMessages.filter((m) => m.status === 'done');
    const active = labMessages.filter((m) => m.status !== 'done');
    const visible = (showCompleted ? labMessages : [...active, ...completed.slice(-2)])
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      items: groupIntoThreads(visible),
      hiddenCompleted: Math.max(0, completed.length - 2),
    };
  }, [showCompleted]);

  const todayPart = useMemo(
    () => labMessages.map((m) => m.createdAt.slice(0, 10)).sort().at(-1) ?? '',
    [],
  );

  const openWu = (id: string) => setDrawer({ kind: 'wu', id });
  const openReq = (id: string) => setDrawer({ kind: 'req', id });

  const toggleThread = (anchorId: string) =>
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(anchorId)) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });

  const sendNeedInput = (msgId: string) => {
    if (!(needDrafts[msgId] ?? '').trim()) return;
    setNeedSent((prev) => new Set(prev).add(msgId));
  };

  const dateLabel = (iso: string) => (iso.slice(0, 10) === todayPart ? '今天' : '昨天');

  const renderQuote = (msg: LabMessage) => {
    if (!msg.replyToId) return null;
    const quoted = labMessages.find((m) => m.id === msg.replyToId);
    if (!quoted) return null;
    return (
      <div className="dl-quote">
        {quoted.author}：{quoted.title ?? quoted.body}
      </div>
    );
  };

  const renderCardFoot = (msg: LabMessage) => {
    if (!msg.workUnitId && !msg.reqId && !msg.knowledgeHits) return null;
    return (
      <div className="dl-card-foot">
        {msg.workUnitId && (
          <button className="dl-wu-link" onClick={() => openWu(msg.workUnitId!)}>
            {msg.workUnitId} ›
          </button>
        )}
        {msg.reqId && (
          <button className="dl-wu-link" onClick={() => openReq(msg.reqId!)}>
            {msg.reqId} ›
          </button>
        )}
        {msg.knowledgeHits ? <span className="dl-kb-hit">知识命中 ×{msg.knowledgeHits}</span> : null}
        <span>{timeOf(msg.createdAt)}</span>
      </div>
    );
  };

  const renderMessage = (msg: LabMessage) => {
    // 普通文本消息（人/Agent）
    if (msg.cardType === 'text') {
      return (
        <div className="dl-msg" key={msg.id}>
          {renderQuote(msg)}
          <div className="dl-msg-head">
            <span className={msg.authorKind === 'agent' ? 'dl-author dl-author-agent' : 'dl-author'}>
              {msg.authorKind === 'agent' ? `@${msg.author}` : msg.author}
            </span>
            <span className="dl-time">{timeOf(msg.createdAt)}</span>
            {msg.reqId && (
              <button className="dl-req-inline" onClick={() => openReq(msg.reqId!)}>
                {msg.reqId}
              </button>
            )}
          </div>
          <div className="dl-msg-body">{msg.body}</div>
        </div>
      );
    }

    // 任务卡片（消息卡片即任务状态）
    const approval = approvals[msg.id];
    return (
      <div className="dl-card" key={msg.id} data-card-type={msg.cardType}>
        <div className="dl-card-top">
          <StatusBadge
            status={approval === 'approved' ? 'done' : msg.status}
            onClick={msg.workUnitId ? () => openWu(msg.workUnitId!) : undefined}
          />
          <span className="dl-card-title">{msg.title}</span>
          <span className="dl-time">{timeOf(msg.createdAt)}</span>
        </div>
        <div className="dl-card-body">{msg.body}</div>

        {msg.cardType === 'progress' && typeof msg.progress === 'number' && (
          <div className="dl-progress">
            <div className="dl-progress-fill" style={{ width: `${msg.progress}%` }} />
          </div>
        )}

        {msg.cardType === 'need_input' && (
          <>
            <div className="dl-need-q">{msg.question}</div>
            {needSent.has(msg.id) ? (
              <div className="dl-need-sent">✓ 已回复（原型 mock，未真正发送）</div>
            ) : (
              <div className="dl-need-form">
                <input
                  aria-label={`回复 ${msg.workUnitId}`}
                  placeholder="直接在此回复，WorkUnit 将继续执行…"
                  value={needDrafts[msg.id] ?? ''}
                  onChange={(e) => setNeedDrafts((prev) => ({ ...prev, [msg.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && sendNeedInput(msg.id)}
                />
                <button className="dl-btn dl-btn-primary" onClick={() => sendNeedInput(msg.id)}>
                  回复
                </button>
              </div>
            )}
          </>
        )}

        {msg.cardType === 'approval' && (
          approval ? (
            <div className="dl-need-sent">
              {approval === 'approved' ? '✓ 已通过（原型 mock）' : '✗ 已驳回（原型 mock）'}
            </div>
          ) : (
            <div className="dl-approve-actions">
              <button className="dl-btn dl-btn-primary" onClick={() => setApprovals((p) => ({ ...p, [msg.id]: 'approved' }))}>
                通过
              </button>
              <button className="dl-btn" onClick={() => setApprovals((p) => ({ ...p, [msg.id]: 'rejected' }))}>
                驳回
              </button>
            </div>
          )
        )}

        {renderCardFoot(msg)}
      </div>
    );
  };

  const renderStream = () => {
    let lastDate = '';
    const out: React.ReactNode[] = [];
    if (!showCompleted && hiddenCompleted > 0) {
      out.push(
        <button key="collapse" className="dl-collapse-toggle" onClick={() => setShowCompleted(true)}>
          显示 {hiddenCompleted} 条已完成消息
        </button>,
      );
    }
    if (showCompleted) {
      out.push(
        <button key="collapse" className="dl-collapse-toggle" onClick={() => setShowCompleted(false)}>
          收起已完成消息
        </button>,
      );
    }
    for (const item of items) {
      const anchor = 'anchor' in item ? item.anchor : item;
      const day = anchor.createdAt.slice(0, 10);
      if (day !== lastDate) {
        lastDate = day;
        out.push(
          <div className="dl-date" key={`date-${day}`}>
            {dateLabel(anchor.createdAt)} · {day}
          </div>,
        );
      }
      if ('anchor' in item) {
        const expanded = expandedThreads.has(anchor.id);
        out.push(renderMessage(anchor));
        if (item.replies.length > 0) {
          out.push(
            <button key={`${anchor.id}-toggle`} className="dl-thread-toggle" onClick={() => toggleThread(anchor.id)}>
              {expanded ? '▾ 收起线程' : `▸ ${item.replies.length} 条线程回复`}
            </button>,
          );
          if (expanded) {
            out.push(
              <div key={`${anchor.id}-replies`} className="dl-thread-replies">
                {item.replies.map(renderMessage)}
              </div>,
            );
          }
        }
      } else {
        out.push(renderMessage(item));
      }
    }
    return out;
  };

  const drawerWu: LabWorkUnit | null = drawer?.kind === 'wu' ? findWorkUnit(drawer.id) ?? null : null;
  const drawerReq: LabRequirement | null = drawer?.kind === 'req' ? findRequirement(drawer.id) ?? null : null;

  return (
    <div className={`dl dl-${direction}`}>
      <div className="dl-body">
        {/* 左栏：频道列表 */}
        <aside className="dl-rail">
          <div className="dl-rail-head">
            <h1 className="dl-rail-title">Agent Studio</h1>
            <div className="dl-rail-sub">多 Agent 群聊控制台</div>
            <Link to="/design-lab" className="dl-rail-back">‹ 方向稿索引</Link>
          </div>
          <div className="dl-sec-label">频道</div>
          <nav className="dl-rail-list" aria-label="频道列表">
            {labChannels.map((c) => (
              <button
                key={c.id}
                className={c.id === activeChannelId ? 'dl-chan dl-chan-active' : 'dl-chan'}
                onClick={() => setActiveChannelId(c.id)}
              >
                <span className="dl-chan-hash">#</span>
                <span className="dl-chan-name">{c.name}</span>
                <span className="dl-chan-meta">{c.agentsOnline}/{c.agentsTotal}</span>
                {c.unread > 0 && <span className="dl-chan-badge">{c.unread}</span>}
              </button>
            ))}
          </nav>
          <div className="dl-agents">
            <div className="dl-sec-label">Agents</div>
            {labAgents.map((a) => (
              <div className="dl-agent" key={a.id}>
                <span className={`dl-dot dl-dot-${a.status}`} />
                <span>@{a.name}</span>
                <span className="dl-agent-role">{a.role}</span>
              </div>
            ))}
          </div>
        </aside>

        {/* 中栏：对话流 */}
        <main className="dl-main">
          <div className="dl-topbar">
            <h2 className="dl-topbar-name">#{activeChannel.name}</h2>
            <span className="dl-topbar-type">
              {activeChannel.type === 'rnd' ? '研发频道' : activeChannel.type === 'decision' ? '决策频道' : '系统频道'}
            </span>
            <div className="dl-topbar-actions">
              <button className="dl-meta-btn" title="ChannelMemberManager（原型 mock）">
                成员 {activeChannel.agentsTotal} · 在线 {activeChannel.agentsOnline}
              </button>
              <button className="dl-meta-btn" title="ChannelWorkspaceSetting（原型 mock）">
                默认工程：studio
              </button>
            </div>
          </div>

          <div className="dl-reqs">
            <span className="dl-reqs-label">REQ</span>
            {labRequirements.map((r) => (
              <button key={r.id} className="dl-req-chip" onClick={() => openReq(r.id)} title="打开 REQ 全链路">
                {r.id} · {r.title} · <span className="dl-req-status">{r.status}</span>
              </button>
            ))}
          </div>

          <div className="dl-stream">
            <div className="dl-stream-inner">{renderStream()}</div>
          </div>

          <div className="dl-inputbar">
            <div className="dl-inputbar-inner">
              <div className="dl-input-row">
                <input
                  aria-label="发送消息"
                  placeholder={`发送到 #${activeChannel.name}，@ 提及 Agent 创建任务…`}
                />
                <button className="dl-btn dl-btn-primary">发送</button>
              </div>
              <div className="dl-input-hint">@mention Agent · 回复引用 · Enter 发送（原型 mock，不触发真实请求）</div>
            </div>
          </div>
        </main>

        {/* 右栏：抽屉 */}
        {drawer && (
          <aside className="dl-drawer" aria-label="详情抽屉">
            <div className="dl-drawer-head">
              <h3 className="dl-drawer-title">
                {drawerWu ? drawerWu.id : drawerReq ? `${drawerReq.id} 全链路` : ''}
              </h3>
              <button className="dl-drawer-close" aria-label="关闭抽屉" onClick={() => setDrawer(null)}>
                ×
              </button>
            </div>
            <div className="dl-drawer-body">
              {drawerWu && <WuDetail wu={drawerWu} onOpenReq={openReq} />}
              {drawerReq && <ReqChain req={drawerReq} onOpenWu={openWu} />}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function WuDetail({ wu, onOpenReq }: { wu: LabWorkUnit; onOpenReq: (id: string) => void }) {
  const statusMap: Record<LabWorkUnit['status'], string> = {
    running: 'running',
    blocked: 'need_input',
    done: 'done',
    pending: 'pending',
  };
  const business = wu.tokens.total - wu.tokens.injected;
  const max = Math.max(wu.tokens.total, 1);
  return (
    <div>
      <div className="dl-card-top" style={{ marginBottom: 8 }}>
        <StatusBadge status={statusMap[wu.status]} />
        <span className="dl-card-title">{wu.title}</span>
      </div>
      <div className="dl-kv"><span className="dl-kv-k">负责人</span><span className="dl-kv-v">@{wu.owner}</span></div>
      <div className="dl-kv">
        <span className="dl-kv-k">所属 REQ</span>
        <button className="dl-wu-link" onClick={() => onOpenReq(wu.reqId)}>{wu.reqId} ›</button>
      </div>
      <div className="dl-kv"><span className="dl-kv-k">进度</span><span className="dl-kv-v">{wu.progress}%</span></div>

      <div className="dl-block-label">Checkpoints</div>
      {wu.checkpoints.map((c) => (
        <div className={`dl-check dl-check-${c.state}`} key={c.label}>
          <span className="dl-check-mark">{c.state === 'done' ? '✓' : c.state === 'running' ? '●' : '○'}</span>
          <span>{c.label}</span>
        </div>
      ))}

      {wu.knowledge.length > 0 && (
        <>
          <div className="dl-block-label">知识命中</div>
          {wu.knowledge.map((k) => (
            <div className="dl-kb-item" key={k.id}>
              <span className="dl-kb-id">{k.id}</span>
              <span className="dl-kb-title">{k.title}</span>
              <span className="dl-kb-tokens">{formatTokens(k.tokens)}</span>
            </div>
          ))}
        </>
      )}

      <div className="dl-block-label">token 开销</div>
      <div className="dl-tokenbar">
        <div className="dl-tokenbar-row">
          <span className="dl-tokenbar-label">注入</span>
          <span className="dl-tokenbar-track">
            <span className="dl-tokenbar-fill" style={{ display: 'block', width: `${(wu.tokens.injected / max) * 100}%`, background: 'var(--dl-warn)' }} />
          </span>
          <span className="dl-tokenbar-val">{formatTokens(wu.tokens.injected)}</span>
        </div>
        <div className="dl-tokenbar-row">
          <span className="dl-tokenbar-label">业务</span>
          <span className="dl-tokenbar-track">
            <span className="dl-tokenbar-fill" style={{ display: 'block', width: `${(business / max) * 100}%`, background: 'var(--dl-accent)' }} />
          </span>
          <span className="dl-tokenbar-val">{formatTokens(business)}</span>
        </div>
        <div className="dl-tokenbar-row">
          <span className="dl-tokenbar-label">总计</span>
          <span className="dl-tokenbar-track">
            <span className="dl-tokenbar-fill" style={{ display: 'block', width: '100%', background: 'var(--dl-border-strong)' }} />
          </span>
          <span className="dl-tokenbar-val">{formatTokens(wu.tokens.total)}</span>
        </div>
        <div className="dl-redline">
          <span>封装开销 {labTokenStat.overheadRatio}x（直连 1.0x）</span>
          <span className="dl-redline-ok">红线 {labTokenStat.redLine}x ✓</span>
        </div>
      </div>
    </div>
  );
}

function ReqChain({ req, onOpenWu }: { req: LabRequirement; onOpenWu: (id: string) => void }) {
  const statusMap: Record<LabWorkUnit['status'], string> = {
    running: 'running',
    blocked: 'need_input',
    done: 'done',
    pending: 'pending',
  };
  return (
    <div>
      <div className="dl-card-top" style={{ marginBottom: 4 }}>
        <span className="dl-card-title">{req.title}</span>
      </div>
      <div className="dl-kv"><span className="dl-kv-k">状态</span><span className="dl-kv-v">{req.status}</span></div>
      <div className="dl-block-label">WorkUnit 链路（{req.workUnitIds.length}）</div>
      {req.workUnitIds.map((id, i) => {
        const wu = findWorkUnit(id);
        if (!wu) return null;
        return (
          <div key={id}>
            {i > 0 && <div className="dl-chain-arrow">↓</div>}
            <button className="dl-chain-node" onClick={() => onOpenWu(id)}>
              <div className="dl-chain-node-top">
                <StatusBadge status={statusMap[wu.status]} />
                <span className="dl-mono">{wu.id}</span>
                <span className="dl-dim" style={{ marginLeft: 'auto' }}>@{wu.owner}</span>
              </div>
              <div className="dl-chain-node-title">{wu.title}</div>
            </button>
          </div>
        );
      })}
    </div>
  );
}
