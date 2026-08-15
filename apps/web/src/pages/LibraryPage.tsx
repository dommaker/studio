/**
 * #155 T5: Library 阅览室 — 跨项目 .studio/ 聚合只读层
 *
 * 功能：搜索、项目筛选、文档列表（legacy 遗产文档打「遗产」徽标）。
 * 只读：无图谱、无编辑——文档随各仓演进，变更历史 = git 历史。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { libraryApi, projectApi } from '../api';
import { companyApi } from '../api/company';
import { maintenanceApi, type TriggerCosts } from '../api/maintenance';
import { ManualTaskButton } from '../components/ui';

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

const statusLabels: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  done: '已完成',
  stale: '已过期',
};

const statusColors: Record<string, string> = {
  draft: 'u-warn-dim',
  confirmed: 'u-ok-dim',
  done: 'u-surface-2 u-text-3',
  stale: 'u-surface-2 u-text-3',
};

export function LibraryPage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [projectId, setProjectId] = useState('');
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
    try {
      const params: { search?: string; project?: string } = {};
      if (searchTerm) params.search = searchTerm;
      if (project) params.project = project;
      const res = await libraryApi.list(params);
      setDocs(res.data?.data || []);
    } catch (err) {
      console.error('[Library] Failed to fetch docs', err);
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

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <h1 className="page-title">阅览室</h1>
          <ManualTaskButton
            label="🔍 语义审查"
            costTokens={costs?.byTrigger['doc-semantic-review']}
            onRun={async () => {
              const r = await maintenanceApi.fireTrigger('doc-semantic-review');
              if (r.workUnit?.id) {
                navigate(`/workunits/${r.workUnit.id}`);
                return '已创建审查任务，可在 WorkUnit 列表查看';
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
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="input"
            style={{ width: 220 }}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.pmoNumber} {p.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 pb-8 pt-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 u-border-2" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <p className="u-text-3">
              {search || projectId ? '没有匹配的文档' : '暂无文档'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {docs.map((doc) => (
              <div
                key={doc.id}
                onClick={() => navigate(`/library/${encodeURIComponent(doc.id)}`)}
                className="card p-4 cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold truncate u-text">
                      {doc.title}
                    </h3>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {doc.legacy ? (
                        <span className="text-xs px-2 py-0.5 rounded-full u-warn-dim">
                          遗产
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full u-surface-2 u-text-3">
                          {kindLabels[doc.kind] || doc.kind}
                        </span>
                      )}
                      <span className="text-xs px-2 py-0.5 rounded-full u-surface-2 u-text-3">
                        {doc.pmoNumber}
                      </span>
                      {doc.status && (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${statusColors[doc.status] || 'u-surface-2 u-text-3'}`}
                        >
                          {statusLabels[doc.status] || doc.status}
                        </span>
                      )}
                      {(doc.tags || []).map((tag, i) => (
                        <span
                          key={i}
                          className="text-xs px-2 py-0.5 rounded-full u-surface-2 u-text-3"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs ml-4 whitespace-nowrap u-text-3">
                    {formatDate(doc.updatedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default LibraryPage;
