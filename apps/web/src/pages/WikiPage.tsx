/**
 * B2-008: Wiki 主页面 — RequirementsDoc 档案馆
 *
 * 功能：搜索、文档列表、图谱视图切换
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { wikiApi } from '../api';
import { maintenanceApi, type TriggerCosts } from '../api/maintenance';
import { ManualTaskButton } from '../components/ui';
import KnowledgeGraphView from '../components/KnowledgeGraphView';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeEdge } from '../components/KnowledgeGraphView';

interface WikiDoc {
  id: string;
  title: string;
  tags: string;
  status: string;
  goalId?: string;
  projectId?: string;
  sourceChannelId: string;
  updatedAt: string;
  createdAt: string;
}

const statusLabels: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  done: '已完成',
};

const statusColors: Record<string, string> = {
  draft: '#f59e0b',
  confirmed: '#10b981',
  done: '#6b7280',
};

export function WikiPage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<WikiDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');
  const [graphData, setGraphData] = useState<KnowledgeGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 手动任务成本（近 30 天 token；失败静默，不阻塞页面）
  const [costs, setCosts] = useState<TriggerCosts | null>(null);
  useEffect(() => {
    maintenanceApi.getCosts().then(setCosts).catch(() => setCosts(null));
  }, []);

  const fetchDocs = useCallback(async (searchTerm: string) => {
    setLoading(true);
    try {
      const params: any = {};
      if (searchTerm) params.search = searchTerm;
      const res = await wikiApi.list(params);
      setDocs(res.data?.data || []);
    } catch (err) {
      console.error('[Wiki] Failed to fetch docs', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchDocs('');
  }, [fetchDocs]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchDocs(search);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, fetchDocs]);

  const handleToggleGraph = async () => {
    if (viewMode === 'graph') {
      setViewMode('list');
      return;
    }
    setViewMode('graph');
    if (!graphData) {
      setGraphLoading(true);
      try {
        const res = await wikiApi.getGraph();
        const raw = res.data?.data;
        if (raw) {
          const nodes: KnowledgeNode[] = (raw.nodes || []).map((n: any) => ({
            id: n.id,
            type: 'concept' as const,
            name: n.name,
            summary: n.status || '',
            tags: [],
            complexity: 'simple' as const,
          }));
          const edges: KnowledgeEdge[] = (raw.edges || []).map((e: any) => ({
            source: e.source,
            target: e.target,
            type: 'related' as const,
            weight: 1,
          }));
          setGraphData({ nodes, edges, layers: [] });
        }
      } catch (err) {
        console.error('[Wiki] Failed to load graph', err);
      } finally {
        setGraphLoading(false);
      }
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="p-6 pb-0">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            文档
          </h1>
          <div className="flex gap-2">
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
            <button
              onClick={handleToggleGraph}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: viewMode === 'graph' ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                color: viewMode === 'graph' ? 'white' : 'var(--text-primary)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {viewMode === 'graph' ? '列表' : '图谱'}
            </button>
          </div>
        </div>

        {/* Search bar (only in list mode) */}
        {viewMode === 'list' && (
          <input
            type="text"
            placeholder="搜索文档标题或内容..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-2 rounded-lg mb-4"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)',
              outline: 'none',
            }}
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 pt-0">
        {viewMode === 'graph' ? (
          graphLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 u-border-2" />
            </div>
          ) : graphData ? (
            <div className="h-full rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
              <KnowledgeGraphView graph={graphData} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p style={{ color: 'var(--text-muted)' }}>暂无图谱数据</p>
            </div>
          )
        ) : loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 u-border-2" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <p style={{ color: 'var(--text-muted)' }}>
              {search ? '没有匹配的文档' : '暂无需求文档'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {docs.map((doc) => {
              let tags: string[] = [];
              try { tags = JSON.parse(doc.tags); } catch { tags = []; }
              return (
                <div
                  key={doc.id}
                  onClick={() => navigate(`/wiki/${doc.id}`)}
                  className="p-4 rounded-lg cursor-pointer transition-all hover:opacity-80"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {doc.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span
                          className="text-xs px-2 py-0.5 rounded-full"
                          style={{
                            background: `${statusColors[doc.status] || '#6b7280'}20`,
                            color: statusColors[doc.status] || '#6b7280',
                          }}
                        >
                          {statusLabels[doc.status] || doc.status}
                        </span>
                        {tags.map((tag: string, i: number) => (
                          <span
                            key={i}
                            className="text-xs px-2 py-0.5 rounded-full"
                            style={{
                              background: 'var(--bg-tertiary)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="text-xs ml-4 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {formatDate(doc.updatedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default WikiPage;
