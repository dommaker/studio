// 知识库文档阅读器 — PMO 驾驶舱文档区点开的右侧抽屉
// 数据：GET /knowledge/detail/:documentId（后端早已存在，此前端首次接入）
// 正文渲染：MarkdownBody（react-markdown + gfm，§10 任务 4b；lazy 按需加载，fallback 为原 plain-text 形态）
import { useEffect, useState, lazy, Suspense } from 'react';
import { knowledgeApi, type KnowledgeDocDetail } from '../../api/knowledge';

const MarkdownBody = lazy(() => import('./MarkdownBody'));

const TYPE_LABELS: Record<string, string> = {
  requirement: '需求',
  design: '设计',
  spec: '规范',
  execution: '执行',
  archive: '归档',
};

interface Props {
  documentId: string | null;
  onClose: () => void;
}

export function DocReaderDrawer({ documentId, onClose }: Props) {
  const [doc, setDoc] = useState<KnowledgeDocDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!documentId) return;
    let alive = true;
    setDoc(null);
    setError('');
    knowledgeApi.getDetail(documentId)
      .then(r => { if (alive) setDoc(r.data); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [documentId]);

  if (!documentId) return null;

  return (
    // mc-drawer 本为频道页在流式侧栏；此处 fixed 覆盖为页面级阅读抽屉
    <aside
      className="mc-drawer fixed top-0 right-0 h-full z-50"
      style={{ width: 420, boxShadow: 'var(--shadow-lg)' }}
      aria-label="文档阅读器"
    >
      <div className="mc-drawer-head">
        <h3 className="mc-drawer-title">{doc?.title ?? '文档'}</h3>
        <button className="mc-drawer-close" aria-label="关闭抽屉" onClick={onClose}>×</button>
      </div>
      <div className="mc-drawer-body">
        {error && <div className="mc-drawer-note">加载失败: {error}</div>}
        {!doc && !error && <div className="mc-drawer-note">加载中…</div>}
        {doc && (
          <div>
            <div className="flex items-center gap-1 mb-3 flex-wrap">
              <span className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent">
                {TYPE_LABELS[doc.type] ?? doc.type}
              </span>
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">v{doc.version}</span>
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">{doc.status}</span>
            </div>
            <Suspense
              fallback={
                <div className="whitespace-pre-wrap text-sm u-text" style={{ lineHeight: 1.8 }}>
                  {doc.content}
                </div>
              }
            >
              <MarkdownBody content={doc.content} />
            </Suspense>
          </div>
        )}
      </div>
    </aside>
  );
}

export default DocReaderDrawer;
