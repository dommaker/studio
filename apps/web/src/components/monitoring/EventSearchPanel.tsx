/**
 * EventSearchPanel — #180 事件检索面板（#60 决策 Q3a）
 *
 * 消费 GET /events 的 level/type/keyword/until 过滤 + 尾部倒读游标分页。
 * UI 文案不用行话：级别 = 信息/警告/调试，游标分页 = 「加载更多」按钮。
 */
import { useState } from 'react';
import { eventsApi, type StudioEventItem, type StudioEventLevel } from '../../api/events';

const LEVEL_OPTIONS: Array<{ value: StudioEventLevel; label: string }> = [
  { value: 'info', label: '信息及以上' },
  { value: 'warning', label: '仅警告和严重' },
  { value: 'debug', label: '全部（含调试）' },
];

const LEVEL_LABELS: Record<string, string> = {
  debug: '调试',
  info: '信息',
  warning: '警告',
  critical: '严重',
};

const PAGE_SIZE = 50;

export function EventSearchPanel() {
  const [type, setType] = useState('');
  const [keyword, setKeyword] = useState('');
  const [level, setLevel] = useState<StudioEventLevel>('info');
  const [until, setUntil] = useState('');
  const [events, setEvents] = useState<StudioEventItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildParams = (cursor?: string) => ({
    limit: PAGE_SIZE,
    level,
    ...(type.trim() ? { type: type.trim() } : {}),
    ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
    ...(until ? { until: new Date(until).toISOString() } : {}),
    ...(cursor ? { cursor } : {}),
  });

  const search = () => {
    setLoading(true);
    setError(null);
    eventsApi.search(buildParams())
      .then((r) => {
        setEvents(r.data.events);
        setNextCursor(r.data.nextCursor);
      })
      .catch(() => setError('查询失败，请重试'))
      .finally(() => setLoading(false));
  };

  const loadMore = () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    eventsApi.search(buildParams(nextCursor))
      .then((r) => {
        setEvents((prev) => [...(prev ?? []), ...r.data.events]);
        setNextCursor(r.data.nextCursor);
      })
      .catch(() => setError('查询失败，请重试'))
      .finally(() => setLoading(false));
  };

  return (
    <div className="space-y-4 mt-4">
      {/* 检索条件 */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="btn btn-secondary"
            value={level}
            onChange={(e) => setLevel(e.target.value as StudioEventLevel)}
            aria-label="级别"
          >
            {LEVEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input
            className="btn btn-secondary"
            style={{ minWidth: 220 }}
            placeholder="类型（可选），如 workunit:failed"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <input
            className="btn btn-secondary"
            style={{ minWidth: 180 }}
            placeholder="关键词（可选）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          />
          <label className="flex items-center gap-2 text-sm u-text-3">
            截止时间（可选）
            <input
              type="datetime-local"
              className="btn btn-secondary"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              aria-label="截止时间（可选）"
            />
          </label>
          <button className="btn btn-primary" disabled={loading} onClick={search}>
            {loading ? '查询中…' : '查询'}
          </button>
        </div>
      </div>

      {error && <div className="p-3 rounded u-err-dim u-err text-sm">{error}</div>}

      {/* 结果列表 */}
      {events !== null && (
        <div className="card p-4">
          {events.length === 0 ? (
            <div className="text-sm u-text-2">没有匹配的事件</div>
          ) : (
            <div className="space-y-2">
              {events.map((ev, i) => (
                <div key={`${ev.createdAt ?? ''}-${i}`} className="text-sm" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs u-text-3">{formatTime(ev.createdAt)}</span>
                    {ev.level && ev.level !== 'info' && (
                      <span className={`text-xs ${ev.level === 'debug' ? 'u-text-3' : ev.level === 'warning' ? 'u-warn' : 'u-err'}`}>
                        {LEVEL_LABELS[ev.level] ?? ev.level}
                      </span>
                    )}
                    <span className="u-text font-medium">{ev.type}</span>
                    {ev.source && <span className="text-xs u-text-3">{ev.source}</span>}
                  </div>
                  {ev.payload && (
                    <div className="text-xs u-text-2 mt-1" style={{ wordBreak: 'break-all' }}>
                      {truncate(ev.payload, 200)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {nextCursor && (
            <div className="mt-3 text-center">
              <button className="btn btn-secondary" disabled={loading} onClick={loadMore}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(iso?: string): string {
  if (!iso) return '时间未知';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
