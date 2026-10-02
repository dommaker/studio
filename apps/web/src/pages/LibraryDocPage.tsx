/**
 * #155 T5: Library 文档详情页 — 只读
 *
 * 功能：MarkdownBody 渲染正文（含 [[链接]] 内链）；
 * legacy 遗产文档展示 requirement/design/task 三段。
 * 无编辑/保存——文档随仓演进，变更历史 = git 历史。
 */
import { lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LIBRARY_DOC_STATUS_COLORS, LIBRARY_DOC_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { libraryApi } from '../api';
import { useAsyncData } from '../hooks/useAsyncData';
import { stripDuplicateH1 } from '../utils/stripDuplicateH1';
import { BackButton, SkeletonText } from '../components/ui';

const MarkdownBody = lazy(() => import('../components/knowledge/MarkdownBody'));

export function LibraryDocPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // P3-b 拉取页收口：一次性拉取统一走 useAsyncData（deps 渲染期重置替代 prevId hack；
  // 失败 error 由 hook 承接，重试 = reload()），自管 useState + useCallback + 裸 useEffect 删除
  const docQ = useAsyncData(async () => {
    if (!id) return null;
    try {
      const res = await libraryApi.getDoc(id);
      return res.data?.data || null;
    } catch (err) {
      console.error('[LibraryDoc] Failed to fetch', err);
      throw new Error('文档加载失败，请重试');
    }
  }, [id]);
  const doc = docQ.data;
  const loading = docQ.loading;
  // 批次 F-1：加载失败 error 上屏（原先 catch 只 console.error，落「文档未找到」假空态）
  const error = docQ.error;

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  if (loading) {
    // 批次 F-3：加载态骨架（批次 E-2 ui/Skeleton 正本）——阅读页标题 + 段落形态
    return (
      <div className="h-full flex flex-col u-page-bg">
        <div className="u-page-head">
          <SkeletonText lines={1} widths={['35%']} />
        </div>
        <div className="flex-1 overflow-auto u-page-px pb-8">
          <div className="max-w-5xl mt-4">
            <SkeletonText lines={10} className="space-y-3" widths={['100%', '100%', '90%', '100%', '75%', '100%', '100%', '85%', '100%', '60%']} />
          </div>
        </div>
      </div>
    );
  }

  // 批次 F-1：加载失败错误条（抄 ProjectDetailPage 模式）+ 重试，不再落「文档未找到」假空态
  if (error) {
    return (
      <div className="h-full u-page-bg u-page-px py-6">
        <div className="max-w-5xl p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={docQ.reload} className="btn btn-secondary btn-sm">重试</button>
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
      <div className="flex-1 overflow-auto u-page-px pb-8 pt-6">
        {/* 阅读页限宽 900px：长文行宽最优，属 §4.7 内容档（max-w-5xl=1024）之外的阅读档例外，勿收 */}
        <div style={{ maxWidth: '900px' }}>
          {sections.map((section, i) => (
            <div key={i} className={i > 0 ? 'mt-8' : ''}>
              {section.label && (
                <h2 className="mc-block-label mc-block-label-gap-2">
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
