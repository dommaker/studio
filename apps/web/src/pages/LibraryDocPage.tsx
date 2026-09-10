/**
 * #155 T5: Library 文档详情页 — 只读
 *
 * 功能：MarkdownBody 渲染正文（含 [[链接]] 内链）；
 * legacy 遗产文档展示 requirement/design/task 三段。
 * 无编辑/保存——文档随仓演进，变更历史 = git 历史。
 */
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LIBRARY_DOC_STATUS_COLORS, LIBRARY_DOC_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { libraryApi } from '../api';
import { stripDuplicateH1 } from '../utils/stripDuplicateH1';
import { BackButton } from '../components/ui';

const MarkdownBody = lazy(() => import('../components/knowledge/MarkdownBody'));

interface LibraryDocDetail {
  id: string;
  title: string;
  kind: 'spec' | 'research' | 'adr' | 'context' | 'legacy';
  legacy: boolean;
  projectId: string;
  pmoNumber: string;
  path: string;
  content: string;
  requirement?: string | null;
  design?: string | null;
  task?: string | null;
  status?: string;
  tags?: string[];
  updatedAt: string;
}

export function LibraryDocPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<LibraryDocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // 批次 F-1：加载失败 error state（原先 catch 只 console.error，落「文档未找到」假空态）
  const [error, setError] = useState<string | null>(null);

  // 切换文档 id 时渲染期置 loading（挂载首帧由 loading 初值 true 覆盖）
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setLoading(true);
    setError(null);
  }

  const fetchDoc = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await libraryApi.getDoc(id);
      setDoc(res.data?.data || null);
    } catch (err) {
      console.error('[LibraryDoc] Failed to fetch', err);
      setError('文档加载失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // 微任务触发：编译器对含 catch 的多语句 async 函数保守告警，推迟一拍时序等价
    void Promise.resolve().then(fetchDoc);
  }, [fetchDoc]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="loading-spinner" />
      </div>
    );
  }

  // 批次 F-1：加载失败错误条（抄 ProjectDetailPage 模式）+ 重试，不再落「文档未找到」假空态
  if (error) {
    return (
      <div className="h-full u-page-bg px-8 py-6">
        <div className="max-w-5xl p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => void fetchDoc()} className="btn btn-secondary btn-sm">重试</button>
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center h-full u-text-3">
        <p className="text-lg mb-4">文档未找到</p>
        <button
          onClick={() => navigate('/library')}
          className="btn btn-primary"
        >
          返回列表
        </button>
      </div>
    );
  }

  // legacy 遗产文档：requirement/design/task 三段；普通文档仅 content 一段
  // #436 C9：页头恒渲染 doc.title，正文首个 H1 与标题重复时剥除，标题全页只出现一次
  const sections: Array<{ label: string; body: string }> = (doc.legacy
    ? [
        { label: '需求', body: doc.requirement ?? doc.content },
        ...(doc.design ? [{ label: '设计', body: doc.design }] : []),
        ...(doc.task ? [{ label: '任务', body: doc.task }] : []),
      ]
    : [{ label: '', body: doc.content }]
  ).map((s) => ({ ...s, body: stripDuplicateH1(s.body, doc.title) }));

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center gap-3 mb-4">
          {/* #393 §4.4：详情页统一左上返回（直开回落 /library） */}
          <BackButton fallback="/library" />
        </div>

        <h1 className="page-title">
          {doc.title}
        </h1>

        <div className="flex items-center gap-3 mt-4 flex-wrap">
          {doc.legacy && (
            <span className="text-xs px-2 py-0.5 rounded-full u-warn-dim">
              遗产（只读归档）
            </span>
          )}
          <span className="text-xs px-2 py-0.5 rounded-full u-surface-2 u-text-3">
            {doc.pmoNumber}
          </span>
          {doc.status && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${LIBRARY_DOC_STATUS_COLORS[doc.status] || 'u-surface-2 u-text-3'}`}
            >
              {LIBRARY_DOC_STATUS_LABELS[doc.status] || doc.status}
            </span>
          )}
          <span className="text-xs u-text-3">
            {doc.path}
          </span>
          {doc.updatedAt && (
            <span className="text-xs u-text-3">
              更新于 <span className="font-mono">{formatDate(doc.updatedAt)}</span>
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 pb-8 pt-6">
        {/* 阅读页限宽 900px：长文行宽最优，属 §4.7 内容档（max-w-5xl=1024）之外的阅读档例外，勿收 */}
        <div style={{ maxWidth: '900px' }}>
          {sections.map((section, i) => (
            <div key={i} className={i > 0 ? 'mt-8' : ''}>
              {section.label && (
                <h2 className="mc-block-label" style={{ margin: '0 0 8px' }}>
                  {section.label}
                </h2>
              )}
              <Suspense
                fallback={
                  <div
                    className="max-w-none whitespace-pre-wrap u-text"
                    style={{ lineHeight: 1.8 }}
                  >
                    {section.body}
                  </div>
                }
              >
                <MarkdownBody content={section.body} className="max-w-none" />
              </Suspense>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default LibraryDocPage;
