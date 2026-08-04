/**
 * B2-008: Wiki 文档详情页
 *
 * 功能：Markdown 内容渲染（§10 任务 4b 起统一走 MarkdownBody，含 [[链接]] 内链）、反向链接、编辑模式
 */
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { wikiApi } from '../api';

const MarkdownBody = lazy(() => import('../components/knowledge/MarkdownBody'));

interface WikiDocDetail {
  id: string;
  title: string;
  content: string;
  tags: string;
  status: string;
  goalId?: string;
  projectId?: string;
  sourceChannelId: string;
  linkedDocIds: string;
  executionSummary?: string;
  createdAt: string;
  updatedAt: string;
  linkedDocs?: { id: string; title: string }[];
  wikiLinks?: { id: string; title: string }[];
  backlinks?: { id: string; title: string }[];
}

const statusLabels: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  done: '已完成',
};

const statusColors: Record<string, string> = {
  draft: 'u-warn-dim',
  confirmed: 'u-ok-dim',
  done: 'u-surface-2 u-text-3',
};

export function WikiDocPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<WikiDocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editTags, setEditTags] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchDoc = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await wikiApi.getDoc(id);
      setDoc(res.data?.data || null);
    } catch (err) {
      console.error('[WikiDoc] Failed to fetch', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDoc();
  }, [fetchDoc]);

  const handleEdit = () => {
    if (!doc) return;
    setEditContent(doc.content);
    setEditTitle(doc.title);
    setEditTags(doc.tags);
    setEditMode(true);
  };

  const handleSave = async () => {
    if (!doc || !id) return;
    setSaving(true);
    try {
      const linkedDocIds = editTags
        ? editTags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
      await wikiApi.updateDoc(id, {
        content: editContent,
        title: editTitle,
        linkedDocIds,
      });
      setEditMode(false);
      await fetchDoc();
    } catch (err) {
      console.error('[WikiDoc] Failed to save', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditMode(false);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 u-border-2" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full u-text-3">
        <p className="text-lg mb-4">文档未找到</p>
        <button
          onClick={() => navigate('/wiki')}
          className="btn btn-primary"
        >
          返回列表
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => navigate('/wiki')}
            className="btn btn-ghost btn-sm"
          >
            ← 返回
          </button>
        </div>

        {editMode ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="input w-full"
            style={{ fontSize: 'var(--fs-title)', fontWeight: 600 }}
          />
        ) : (
          <h1 className="page-title">
            {doc.title}
          </h1>
        )}

        <div className="flex items-center gap-3 mt-4 flex-wrap">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${statusColors[doc.status] || 'u-surface-2 u-text-3'}`}
          >
            {statusLabels[doc.status] || doc.status}
          </span>
          <span className="text-xs u-text-3">
            更新于 {formatDate(doc.updatedAt)}
          </span>
        </div>

        {!editMode && (
          <button
            onClick={handleEdit}
            className="btn btn-secondary btn-sm mt-4"
          >
            编辑
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 pb-8 pt-6">
        <div className="flex gap-6" style={{ maxWidth: '900px' }}>
          {/* Main content */}
          <div className="flex-1 min-w-0">
            {editMode ? (
              <div className="space-y-4">
                <div>
                  <label className="text-sm mb-1 block u-text-3">
                    标签（逗号分隔的 RequirementsDoc ID）
                  </label>
                  <textarea
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    rows={2}
                    className="input w-full"
                    style={{ resize: 'vertical' }}
                    placeholder="doc-id-1, doc-id-2"
                  />
                </div>

                <div>
                  <label className="text-sm mb-1 block u-text-3">
                    内容（Markdown）
                  </label>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={20}
                    className="input w-full font-mono"
                    style={{ resize: 'vertical' }}
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="btn btn-primary"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                  <button
                    onClick={handleCancel}
                    className="btn btn-secondary"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <Suspense
                fallback={
                  <div
                    className="max-w-none whitespace-pre-wrap u-text"
                    style={{ lineHeight: 1.8 }}
                  >
                    {doc.content}
                  </div>
                }
              >
                <MarkdownBody content={doc.content} className="max-w-none" />
              </Suspense>
            )}
          </div>

          {/* Sidebar: links */}
          {!editMode && (
            <div className="w-64 flex-shrink-0 space-y-4">
              {/* Linked Docs */}
              {(doc.linkedDocs || []).length > 0 && (
                <div className="card p-3">
                  <h3 className="mc-block-label" style={{ margin: '0 0 8px' }}>
                    链接的文档
                  </h3>
                  <div className="space-y-1">
                    {doc.linkedDocs?.map((ld) => (
                      <Link
                        key={ld.id}
                        to={`/wiki/${ld.id}`}
                        className="block text-sm truncate u-accent"
                      >
                        {ld.title}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* Backlinks */}
              <div className="card p-3">
                <h3 className="mc-block-label" style={{ margin: '0 0 8px' }}>
                  反向链接
                </h3>
                {(doc.backlinks || []).length === 0 ? (
                  <p className="text-xs u-text-3">
                    暂无反向链接
                  </p>
                ) : (
                  <div className="space-y-1">
                    {doc.backlinks?.map((bl) => (
                      <Link
                        key={bl.id}
                        to={`/wiki/${bl.id}`}
                        className="block text-sm truncate u-accent"
                      >
                        {bl.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Wiki Links from [[ ]] syntax */}
              {(doc.wikiLinks || []).length > 0 && (
                <div className="card p-3">
                  <h3 className="mc-block-label" style={{ margin: '0 0 8px' }}>
                    文档内引用
                  </h3>
                  <div className="space-y-1">
                    {doc.wikiLinks?.map((wl) => (
                      <Link
                        key={wl.id}
                        to={`/wiki/${wl.id}`}
                        className="block text-sm truncate u-accent"
                      >
                        {wl.title}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WikiDocPage;
