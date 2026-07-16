/**
 * B2-008: Wiki 文档详情页
 *
 * 功能：Markdown 内容渲染、[[链接]] 渲染、反向链接、编辑模式
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { wikiApi } from '../api';

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

/**
 * 渲染 Markdown 内容，将 [[链接]] 转为可点击的 Link 组件
 */
function renderContent(content: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(content)) !== null) {
    // Text before the link
    if (match.index > lastIndex) {
      parts.push(<span key={key++}>{content.slice(lastIndex, match.index)}</span>);
    }
    // The [[link]]
    const linkText = match[1].trim();
    parts.push(
      <Link
        key={key++}
        to={`/wiki/${linkText}`}
        className="wiki-link"
        style={{ color: '#3b82f6', textDecoration: 'underline', cursor: 'pointer' }}
      >
        {linkText}
      </Link>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(<span key={key++}>{content.slice(lastIndex)}</span>);
  }

  return parts;
}

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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400" />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full" style={{ color: 'var(--text-muted)' }}>
        <p className="text-lg mb-4">文档未找到</p>
        <button
          onClick={() => navigate('/wiki')}
          className="px-4 py-2 rounded-lg"
          style={{
            background: 'var(--accent-primary)',
            color: 'white',
            border: 'none',
          }}
        >
          返回列表
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="p-6 pb-0">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => navigate('/wiki')}
            className="text-sm"
            style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            ← 返回
          </button>
        </div>

        {editMode ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="w-full text-2xl font-bold px-3 py-2 rounded-lg mb-4"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
            }}
          />
        ) : (
          <h1 className="text-2xl font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
            {doc.title}
          </h1>
        )}

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{
              background: doc.status === 'confirmed' ? '#10b98120' : doc.status === 'done' ? '#6b728020' : '#f59e0b20',
              color: doc.status === 'confirmed' ? '#10b981' : doc.status === 'done' ? '#6b7280' : '#f59e0b',
            }}
          >
            {statusLabels[doc.status] || doc.status}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            更新于 {formatDate(doc.updatedAt)}
          </span>
        </div>

        {!editMode && (
          <button
            onClick={handleEdit}
            className="px-4 py-1.5 rounded-lg text-sm mb-4"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
              cursor: 'pointer',
            }}
          >
            编辑
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 pt-0">
        <div className="flex gap-6" style={{ maxWidth: '900px' }}>
          {/* Main content */}
          <div className="flex-1 min-w-0">
            {editMode ? (
              <div className="space-y-4">
                <div>
                  <label className="text-sm mb-1 block" style={{ color: 'var(--text-muted)' }}>
                    标签（逗号分隔的 RequirementsDoc ID）
                  </label>
                  <textarea
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg text-sm"
                    style={{
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-subtle)',
                      resize: 'vertical',
                    }}
                    placeholder="doc-id-1, doc-id-2"
                  />
                </div>

                <div>
                  <label className="text-sm mb-1 block" style={{ color: 'var(--text-muted)' }}>
                    内容（Markdown）
                  </label>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={20}
                    className="w-full px-3 py-2 rounded-lg font-mono text-sm"
                    style={{
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-subtle)',
                      resize: 'vertical',
                    }}
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 rounded-lg text-sm font-medium"
                    style={{
                      background: 'var(--accent-primary)',
                      color: 'white',
                      border: 'none',
                      opacity: saving ? 0.6 : 1,
                      cursor: saving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                  <button
                    onClick={handleCancel}
                    className="px-4 py-2 rounded-lg text-sm"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="prose prose-invert max-w-none whitespace-pre-wrap"
                style={{ color: 'var(--text-primary)', lineHeight: 1.8 }}
              >
                {renderContent(doc.content)}
              </div>
            )}
          </div>

          {/* Sidebar: links */}
          {!editMode && (
            <div className="w-64 flex-shrink-0 space-y-4">
              {/* Linked Docs */}
              {(doc.linkedDocs || []).length > 0 && (
                <div
                  className="p-3 rounded-lg"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                    链接的文档
                  </h3>
                  <div className="space-y-1">
                    {doc.linkedDocs?.map((ld) => (
                      <Link
                        key={ld.id}
                        to={`/wiki/${ld.id}`}
                        className="block text-sm truncate"
                        style={{ color: '#3b82f6' }}
                      >
                        {ld.title}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* Backlinks */}
              <div
                className="p-3 rounded-lg"
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                  反向链接
                </h3>
                {(doc.backlinks || []).length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    暂无反向链接
                  </p>
                ) : (
                  <div className="space-y-1">
                    {doc.backlinks?.map((bl) => (
                      <Link
                        key={bl.id}
                        to={`/wiki/${bl.id}`}
                        className="block text-sm truncate"
                        style={{ color: '#3b82f6' }}
                      >
                        {bl.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* Wiki Links from [[ ]] syntax */}
              {(doc.wikiLinks || []).length > 0 && (
                <div
                  className="p-3 rounded-lg"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                    文档内引用
                  </h3>
                  <div className="space-y-1">
                    {doc.wikiLinks?.map((wl) => (
                      <Link
                        key={wl.id}
                        to={`/wiki/${wl.id}`}
                        className="block text-sm truncate"
                        style={{ color: '#3b82f6' }}
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
