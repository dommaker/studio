// Triage Global Banner — B2-005: 页面顶部常驻告警横幅
// #468 投影化（统一行动中心）：数据源 = notificationStore 中 type==='incident' 且未读的通知
// （SSE incident.created/escalated 订阅与内存 dismissed Set 已删）；
// 「关闭」= 对每条可见 incident 调 markRead（已读墓碑持久化在后端，刷新不复活）。
import { useNotificationStore } from '../stores/notificationStore';

/** incident 通知的 severity 从 content 首行 `severity: <level>` 解析；缺省 warning */
function severityOf(content: string): string {
  return /^severity:\s*(\w+)/m.exec(content)?.[1] ?? 'warning';
}

export function TriageBanner() {
  const notifications = useNotificationStore(s => s.notifications);
  const markRead = useNotificationStore(s => s.markRead);

  const visible = notifications.filter(n => n.type === 'incident' && !n.read);
  if (visible.length === 0) return null;

  const hasCritical = visible.some(n => severityOf(n.content) === 'critical');

  return (
    <div data-visual-ignore className={`px-4 py-2 text-sm text-center ${
      hasCritical ? 'u-err-bg u-on-accent' : 'u-warn-dim u-warn border-b u-warn-border'
    }`}>
      <div className="flex items-center justify-center gap-2 max-w-3xl mx-auto">
        <span>{hasCritical ? '🚨' : '⚠️'}</span>
        <span className="truncate">
          {visible.length > 1
            ? `${visible.length} 条告警`
            : (visible[0].title ?? visible[0].content)
          }
        </span>
        <button
          onClick={() => { for (const n of visible) markRead(n.id); }}
          className="ml-2 text-xs underline opacity-70 hover:opacity-100 flex-shrink-0"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
