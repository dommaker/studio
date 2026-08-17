// TranscriptViewer — #174: WU 会话原文（transcript）只读查看器（#60 C5）
// 默认折叠不请求（按需加载）；展开拉第一页，「加载更多」按 offset+limit 翻页，到底隐藏。
// 样式沿用 ExecutionSteps 的 mc-* 类名习惯，不引入新依赖。
import { useState } from 'react';
import { transcriptsApi, type TranscriptEntry } from '../../api/transcript';

const PAGE_SIZE = 20;

export function TranscriptViewer({ workUnitId }: { workUnitId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = (offset: number) => {
    setLoading(true);
    transcriptsApi
      .get(workUnitId, { offset, limit: PAGE_SIZE })
      .then((r) => {
        setEntries((prev) => (offset === 0 ? r.data.entries : [...(prev ?? []), ...r.data.entries]));
        setTotal(r.data.total);
        setError('');
      })
      .catch(() => setError('加载失败'))
      .finally(() => setLoading(false));
  };

  const toggle = () => {
    // 首次展开才拉取；收起再展开用缓存，不重复请求
    if (!expanded && entries === null) load(0);
    setExpanded((v) => !v);
  };

  const hasMore = entries !== null && entries.length < total;

  return (
    <div>
      <button className="mc-block-label" style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0 }} onClick={toggle}>
        {expanded ? '▾' : '▸'} 会话原文 / Transcript
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {entries === null && !error && <div className="mc-drawer-note">加载中…</div>}
          {error && <div className="mc-drawer-note">{error}</div>}
          {entries !== null && entries.length === 0 && (
            <div className="mc-drawer-note">暂无 transcript（仅记录本能力上线后的执行步）</div>
          )}
          {entries?.map((e, i) => (
            <div key={`${e.step}-${i}`} style={{ marginBottom: 8 }}>
              <div className="mc-kv">
                <span className="mc-kv-k">#{e.step}{e.action ? ` · ${e.action}` : ''}</span>
                <span className="mc-kv-v">{formatTime(e.createdAt)}</span>
              </div>
              {e.rawOutput && (
                <div className="mc-drawer-note" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {e.rawOutput}
                </div>
              )}
            </div>
          ))}
          {hasMore && (
            <button className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3 u-hover-bg" disabled={loading} onClick={() => load(entries?.length ?? 0)}>
              {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
