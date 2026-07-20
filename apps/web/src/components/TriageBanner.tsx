// Triage Global Banner — B2-005: 页面顶部常驻告警横幅
import { useState, useEffect } from 'react';
import { useWebSocketContext } from '../api/websocket';

interface TriageAlert {
  id: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  time: string;
}

export function TriageBanner() {
  const [alerts, setAlerts] = useState<TriageAlert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const { onEvent } = useWebSocketContext();

  useEffect(() => {
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'incident.created' || msg.event_type === 'incident.escalated') {
        const data = msg.data as any;
        setAlerts(prev => [{
          id: data.incidentId || data.id || msg.event_id,
          type: data.type || 'unknown',
          severity: data.severity || 'warning',
          message: data.message || data.resolution || '系统告警',
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        }, ...prev.slice(0, 9)]);
      }
    });
    return unsub;
  }, [onEvent]);

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  const hasCritical = visible.some(a => a.severity === 'critical');

  return (
    <div className={`px-4 py-2 text-sm text-center ${
      hasCritical ? 'u-err-bg u-on-accent' : 'u-warn-dim u-warn border-b u-warn-border'
    }`}>
      <div className="flex items-center justify-center gap-2 max-w-3xl mx-auto">
        <span>{hasCritical ? '🚨' : '⚠️'}</span>
        <span className="truncate">
          {visible.length > 1
            ? `${visible.length} 条告警`
            : visible[0].message
          }
        </span>
        <button
          onClick={() => setDismissed(new Set(visible.map(a => a.id)))}
          className="ml-2 text-xs underline opacity-70 hover:opacity-100 flex-shrink-0"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
