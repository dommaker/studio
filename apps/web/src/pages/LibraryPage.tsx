/**
 * #155 T5: Library 阅览室 — 跨项目 .studio/ 聚合只读层
 *
 * 功能：搜索、项目/类型筛选、文档列表（legacy 遗产文档打「遗产」徽标）。
 * E6 页面重设计：默认视图按项目分组（组内 updatedAt 降序），搜索/筛选态回退平铺。
 * 只读：无图谱、无编辑——文档随各仓演进，变更历史 = git 历史。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { LIBRARY_DOC_STATUS_COLORS, LIBRARY_DOC_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { libraryApi, projectApi } from '../api';
import { companyApi } from '../api/company';
import { maintenanceApi, type TriggerCosts } from '../api/maintenance';
import { ManualTaskButton, SkeletonText } from '../components/ui';
import { Select } from '../components/ui/Select';
import '../styles/library.css';

interface LibraryDoc {
  id: string;
  title: string;
  kind: 'spec' | 'research' | 'adr' | 'context' | 'legacy';
  legacy: boolean;
  projectId: string;
  pmoNumber: string;
  path: string;
  status?: string;
  tags?: string[];
  updatedAt: string;
}

interface ProjectOption {
  id: string;
  pmoNumber: string;
  title: string;
}

const kindLabels: Record<string, string> = {
  spec: '规格',
  research: '调研',
  adr: 'ADR',
  context: '上下文',
  legacy: '遗产',
};

export function LibraryPage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  // 批次 F-1：加载失败 error state（原先 catch 只 console.error，落「暂无文档」假空态）
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState('');
  // #436 B11：类型筛选（前端过滤已拉取列表，零后端改动）
  const [kind, setKind] = useState('');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 手动任务成本（近 30 天 token；失败静默，不阻塞页面）
  const [costs, setCosts] = useState<TriggerCosts | null>(null);
  useEffect(() => {
    maintenanceApi.getCosts().then(setCosts).catch(() => setCosts(null));
  }, []);

  // 项目筛选下拉数据源：默认公司下的 PMO 项目清单（失败静默，下拉留空仍可全量浏览）
  useEffect(() => {
    void (async () => {
      try {
        const companiesRes = await companyApi.list();
        const companyId = companiesRes.data?.data?.[0]?.id;
        if (!companyId) return;
        const res = await projectApi.list({ companyId, limit: 100 });
        setProjects(res.data?.data || []);
      } catch {
        setProjects([]);
      }
    })();
  }, []);

  const fetchDocs = useCallback(async (searchTerm: string, project: string) => {
    setLoading(true);
    setError(null);
    try {
      const params: { search?: string; project?: string } = {};
      if (searchTerm) params.search = searchTerm;
      if (project) params.project = project;
      const res = await libraryApi.list(params);
      setDocs(res.data?.data || []);
    } catch (err) {
      console.error('[Library] Failed to fetch docs', err);
      setError('加载文档列表失败，请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load（微任务触发：fetchDocs 首行同步置 loading，直接调用会触发
  // set-state-in-effect；微任务推迟一拍，首屏时序与原实现等价——挂载即拉取，不防抖）
  useEffect(() => {
    void Promise.resolve().then(() => fetchDocs('', ''));
  }, [fetchDocs]);

  // Debounced search / project filter（跳过首次运行：初始加载已由上方 effect 立即触发）
  const firstSearchEffectRef = useRef(true);
  useEffect(() => {
    if (firstSearchEffectRef.current) {
      firstSearchEffectRef.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchDocs(search, projectId);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, projectId, fetchDocs]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  // 类型筛选：前端过滤；kind 为空 = 全部
  const visibleDocs = kind ? docs.filter((d) => d.kind === kind) : docs;

  // E6 页面重设计：默认视图按项目分组（组头 = mc-block-label + pmoNumber + 计数，
  // 组内 updatedAt 降序、组间按组内最新文档降序）；文档量小一次全量，分组纯前端。
  // 搜索/任一筛选生效时回退平铺（分组在跨项目结果集无意义）。
  const flatView = Boolean(search || projectId || kind);
  const docGroups: Array<{ projectId: string; pmoNumber: string; docs: LibraryDoc[] }> = (() => {
    if (flatView) return [];
    const byProject = new Map<string, LibraryDoc[]>();
    for (const d of visibleDocs) {
      const arr = byProject.get(d.projectId);
      if (arr) arr.push(d);
      else byProject.set(d.projectId, [d]);
    }
    return [...byProject.entries()]
      .map(([pid, list]) => ({
        projectId: pid,
        pmoNumber: list[0].pmoNumber,
        docs: [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .sort((a, b) => b.docs[0].updatedAt.localeCompare(a.docs[0].updatedAt));
  })();

  const renderDocRow = (doc: LibraryDoc) => (
    <div
      key={doc.id}
      data-kind={doc.kind}
      onClick={() => navigate(`/library/${encodeURIComponent(doc.id)}`)}
      className="lib-row"
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/library/${encodeURIComponent(doc.id)}`)}
      title={doc.path}
    >
      <span className="lib-dot" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="lib-title">{doc.title}</span>
          {doc.legacy ? (
            <span className="text-xs px-2 py-0.5 rounded-full u-warn-dim">遗产</span>
          ) : (
            <span className="lib-kind">{kindLabels[doc.kind] || doc.kind}</span>
          )}
          <span className="lib-chip">{doc.pmoNumber}</span>
          {doc.status && (
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${LIBRARY_DOC_STATUS_COLORS[doc.status] || 'u-surface-2 u-text-3'}`}
            >
              {LIBRARY_DOC_STATUS_LABELS[doc.status] || doc.status}
            </span>
          )}
          {(doc.tags || []).map((tag, i) => (
            <span key={i} className="lib-chip">{tag}</span>
          ))}
        </div>
        <div className="lib-path mt-0.5">{doc.path}</div>
      </div>
      <span className="lib-date">{formatDate(doc.updatedAt)}</span>
    </div>
  );

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <h1 className="page-title">阅览室</h1>
          <ManualTaskButton
            label="语义审查"
            costTokens={costs?.byTrigger['doc-semantic-review']}
            onRun={async () => {
              const r = await maintenanceApi.fireTrigger('doc-semantic-review');
              if (r.workUnit?.id) {
                navigate(`/workunits/${r.workUnit.id}`);
                return '已创建审查任务，可在任务列表查看';
              }
              return '已创建审查任务';
            }}
          />
        </div>

        {/* Search + project filter */}
        <div className="flex gap-2 mt-4">
          <input
            type="text"
            placeholder="搜索文档标题或内容..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input flex-1"
          />
          <Select
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: '', label: '全部项目' },
              ...projects.map((p) => ({ value: p.id, label: `${p.pmoNumber} ${p.title}` })),
            ]}
            style={{ width: 220 }}
            aria-label="项目筛选"
          />
          <Select
            value={kind}
            onChange={setKind}
            options={[
              { value: '', label: '全部类型' },
              ...Object.entries(kindLabels).map(([value, label]) => ({ value, label })),
            ]}
            style={{ width: 140 }}
            aria-label="类型筛选"
          />
        </div>
      </div>

      {/* Content（#436 B11：收 max-w-5xl 对齐 §4.7 内容档） */}
      <div className="flex-1 overflow-auto px-8 pb-8 pt-6">
        <div className="max-w-5xl">
        {/* 批次 F-1：加载失败错误条（抄 PMOPage u-err-dim 错误条 + 重试模式），失败不再落「暂无文档」假空态 */}
        {!loading && error && (
          <div className="mb-3 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => fetchDocs(search, projectId)} className="btn btn-secondary btn-sm">重试</button>
          </div>
        )}
        {loading ? (
          // 批次 F-3：加载态骨架（批次 E-2 ui/Skeleton 正本）——列表行形态
          <SkeletonText lines={8} className="space-y-3" />
        ) : error ? null : visibleDocs.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <p className="u-text-3">
              {search || projectId || kind ? '没有匹配的文档' : '暂无文档'}
            </p>
          </div>
        ) : flatView ? (
          <div className="lib-list">
            {visibleDocs.map(renderDocRow)}
          </div>
        ) : (
          <div className="space-y-6">
            {docGroups.map((group) => (
              <div key={group.projectId}>
                <h2 className="mc-block-label" style={{ margin: '0 0 8px' }}>
                  {group.pmoNumber} · {group.docs.length} 篇
                </h2>
                <div className="lib-list">
                  {group.docs.map(renderDocRow)}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export default LibraryPage;
