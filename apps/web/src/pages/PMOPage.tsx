// PMOPage - PMO 管理主页面（项目 + OKR）
import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { toast } from '../utils/toast';
import '../styles/theme.css';

// 🆕 AS-016: 获取当前季度
function getCurrentQuarter(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

interface KR {
  id: string;
  objectiveId: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  metricType?: string;
}

interface OKRObjective {
  id: string;
  title: string;
  description?: string;
}

interface OKR {
  id: string;
  title: string;
  quarter: string;
  status: string;
  progress: number;
  projectCount: number;
  objectives?: OKRObjective[];
  keyResults?: KR[];
}

const METRIC_TYPE_OPTIONS = [
  { value: '', label: '手动更新' },
  { value: 'pipeline_duration_p90', label: '管线耗时 (p90)' },
  { value: 'pipeline_duration_per_phase', label: '单阶段耗时' },
  { value: 'cache_hit_rate', label: '缓存命中率' },
  { value: 'execution_success_rate', label: '执行成功率' },
  { value: 'review_pass_rate', label: '审查通过率' },
  { value: 'token_saving_ratio', label: 'Token 节省率' },
];

interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  description?: string;
  status: string;
  progress: number;
  createdAt: string;
  OKR?: { id: string; title: string };
}

interface PMOPageProps {
  companyId?: string;
}

export function PMOPage({ companyId }: PMOPageProps) {
  const [searchParams] = useSearchParams();
  const [okrs, setOKRs] = useState<OKR[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  
  // 🆕 B8: OKR 创建弹窗 — 支持 KR 编辑
  const [showOKRDialog, setShowOKRDialog] = useState(false);
  const [newOKRTitle, setNewOKRTitle] = useState('');
  const [newOKRQuarter, setNewOKRQuarter] = useState(getCurrentQuarter());
  const [krs, setKRs] = useState<KR[]>([
    { id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' },
  ]);

  const addKR = () => {
    setKRs(prev => [...prev, {
      id: `kr${Date.now()}`,
      objectiveId: 'o1',
      title: '',
      target: 100,
      current: 0,
      unit: '%',
      metricType: '',
    }]);
  };

  const removeKR = (id: string) => {
    setKRs(prev => prev.filter(kr => kr.id !== id));
  };

  const updateKR = (id: string, field: keyof KR, value: string | number) => {
    setKRs(prev => prev.map(kr => kr.id === id ? { ...kr, [field]: value } : kr));
  };
  
  const tabParam = searchParams.get('tab');
  const defaultTab = tabParam === 'okr' ? 'okr' : 'projects';
  const [activeTab, setActiveTab] = useState<'projects' | 'okr'>(defaultTab);

  useEffect(() => {
    loadData();
  }, [companyId]);

  const loadData = async () => {
    try {
      setLoading(true);

      let actualCompanyId = companyId;
      if (!actualCompanyId) {
        const companiesRes = await api.get('/companies');
        if (companiesRes.data?.data?.length > 0) {
          actualCompanyId = companiesRes.data.data[0].id;
        }
      }

      const [okrRes, projectsRes] = await Promise.all([
        actualCompanyId
          ? api.get(`/pmo/okr?companyId=${actualCompanyId}`)
          : Promise.resolve({ data: { data: [] } }),
        actualCompanyId
          ? api.get(`/pmo/project?companyId=${actualCompanyId}&limit=20`)
          : Promise.resolve({ data: { data: [] } }),
      ]);

      setOKRs(okrRes.data?.data || []);
      setProjects(projectsRes.data?.data || []);
    } catch (err) {
      console.error('Failed to load PMO data:', err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      running: '#2196F3',
      pending: '#FF9800',
      succeeded: '#4CAF50',
      completed: '#4CAF50',
      failed: '#F44336',
      active: '#2196F3',
    };
    return colors[status] || '#9E9E9E';
  };

  // 🆕 B8: 创建 OKR (支持 KR + metricType)
  const handleCreateOKR = async () => {
    if (!newOKRTitle.trim()) {
      toast.warning('请输入 OKR 标题');
      return;
    }
    // 验证 KR target > 0
    const invalidKR = krs.find(kr => kr.target <= 0);
    if (invalidKR) {
      toast.warning(`KR "${invalidKR.title || '未命名'}" 的目标值必须大于 0`);
      return;
    }

    try {
      const actualCompanyId = companyId || localStorage.getItem('companyId');
      if (!actualCompanyId) {
        toast.warning('请先选择公司');
        return;
      }

      await api.post('/pmo/okr', {
        companyId: actualCompanyId,
        title: newOKRTitle,
        quarter: newOKRQuarter,
        objectives: [{ id: 'o1', title: newOKRTitle }],
        keyResults: krs.filter(kr => kr.title.trim() !== ''),
      });

      setShowOKRDialog(false);
      setNewOKRTitle('');
      setKRs([{ id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' }]);
      loadData();
    } catch (err) {
      console.error('Failed to create OKR:', err);
      toast.error('创建 OKR 失败');
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">📊 PMO 管理</h1>
            <p className="page-subtitle">项目组合 + OKR 管理</p>
          </div>
          <Link to="/" className="btn btn-secondary">
            ← 返回首页
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-8 py-4">
        <div className="flex gap-2 p-1 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
          <button
            onClick={() => setActiveTab('projects')}
            className="flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all"
            style={{
              background: activeTab === 'projects' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'projects' ? 'var(--accent-primary)' : 'var(--text-secondary)',
            }}
          >
            📁 项目 ({projects.length})
          </button>
          <button
            onClick={() => setActiveTab('okr')}
            className="flex-1 py-2 px-4 rounded-md text-sm font-medium transition-all"
            style={{
              background: activeTab === 'okr' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'okr' ? 'var(--accent-primary)' : 'var(--text-secondary)',
            }}
          >
            🎯 OKR ({okrs.length})
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-8 pb-8">
        {loading ? (
          <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : activeTab === 'projects' ? (
          <div className="space-y-3">
            {projects.length === 0 ? (
              <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
                暂无项目，在首页下达 CEO 指令创建
              </div>
            ) : (
              projects.map(project => (
                <div
                  key={project.id}
                  className="p-4 rounded-xl transition-all cursor-pointer hover:scale-[1.01]"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                  }}
                  onClick={() => window.location.href = `/pmo/project/${project.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="px-2 py-1 rounded text-sm font-bold"
                        style={{ background: 'var(--accent-primary)', color: '#fff' }}
                      >
                        {project.pmoNumber}
                      </div>
                      <div>
                        <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {project.title}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          {project.description || '无描述'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-16 h-2 rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
                        <div
                          className="h-2 rounded-full"
                          style={{ width: `${project.progress}%`, background: 'var(--success)' }}
                        />
                      </div>
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {project.progress}%
                      </span>
                      {project.OKR && (
                        <span className="text-xs px-2 py-1 rounded" style={{
                          background: 'rgba(99, 102, 241, 0.1)',
                          color: 'var(--accent-primary)',
                        }}>
                          {project.OKR.title}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* 🆕 AS-016: 创建 OKR 按钮 */}
            <button
              onClick={handleCreateOKR}
              className="w-full p-4 rounded-xl transition-all text-left"
              style={{
                background: 'var(--bg-secondary)',
                border: '2px dashed var(--border-default)',
                color: 'var(--text-secondary)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">+ 创建 OKR</span>
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                为新季度设置目标和关键结果
              </div>
            </button>

            {okrs.length === 0 ? (
              <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
                暂无 OKR，点击上方按钮创建
              </div>
            ) : (
              okrs.map(okr => (
                <div
                  key={okr.id}
                  className="p-4 rounded-xl transition-all"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        {okr.title}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {okr.quarter} · {okr.projectCount} 个项目
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div className="text-lg font-bold" style={{ color: 'var(--success)' }}>
                          {Math.round(okr.progress * 100)}%
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          进度
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* 🆕 B8: KR 列表 */}
                  {okr.keyResults && okr.keyResults.length > 0 && (
                    <div className="space-y-1 mt-2 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      {okr.keyResults.map((kr: KR) => (
                        <div key={kr.id} className="flex items-center justify-between text-xs">
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {kr.title}
                            {kr.metricType && (
                              <span className="ml-1 px-1 py-0.5 rounded" style={{
                                background: 'rgba(99, 102, 241, 0.1)',
                                color: 'var(--accent-primary)',
                                fontSize: '10px',
                              }}>
                                auto
                              </span>
                            )}
                          </span>
                          <span className="font-mono" style={{ color: 'var(--text-tertiary)' }}>
                            {kr.current}/{kr.target}{kr.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 🆕 B8: 创建 OKR 弹窗 (支持 KR 编辑) */}
      {showOKRDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6" style={{ maxHeight: '80vh', overflow: 'auto' }}>
            <h3 className="text-lg font-semibold mb-4">创建 OKR</h3>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600 mb-1">季度</label>
                  <input
                    type="text"
                    value={newOKRQuarter}
                    onChange={(e) => setNewOKRQuarter(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg"
                    placeholder="2026-Q3"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600 mb-1">标题</label>
                  <input
                    type="text"
                    value={newOKRTitle}
                    onChange={(e) => setNewOKRTitle(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg"
                    placeholder="管线效率提升 Q2"
                  />
                </div>
              </div>

              {/* 🆕 KR 编辑 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm text-gray-600">关键结果 (KR)</label>
                  <button
                    onClick={addKR}
                    className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
                  >
                    + 添加 KR
                  </button>
                </div>
                {krs.map((kr, idx) => (
                  <div key={kr.id} className="p-3 rounded-lg mb-2" style={{ background: 'var(--bg-secondary)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-bold" style={{ color: 'var(--text-tertiary)' }}>
                        KR{idx + 1}
                      </span>
                      <input
                        type="text"
                        value={kr.title}
                        onChange={(e) => updateKR(kr.id, 'title', e.target.value)}
                        className="flex-1 px-2 py-1 text-sm border rounded"
                        placeholder="关键结果描述"
                      />
                      {krs.length > 1 && (
                        <button
                          onClick={() => removeKR(kr.id)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="text-xs text-gray-400">目标值</label>
                        <input
                          type="number"
                          value={kr.target}
                          min={1}
                          onChange={(e) => updateKR(kr.id, 'target', Number(e.target.value))}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400">当前值</label>
                        <input
                          type="number"
                          value={kr.current}
                          min={0}
                          onChange={(e) => updateKR(kr.id, 'current', Number(e.target.value))}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400">单位</label>
                        <input
                          type="text"
                          value={kr.unit}
                          onChange={(e) => updateKR(kr.id, 'unit', e.target.value)}
                          className="w-full px-2 py-1 text-sm border rounded"
                          placeholder="% / min / 次"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400">自动度量</label>
                        <select
                          value={kr.metricType || ''}
                          onChange={(e) => updateKR(kr.id, 'metricType', e.target.value)}
                          className="w-full px-2 py-1 text-sm border rounded"
                        >
                          {METRIC_TYPE_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => {
                  setShowOKRDialog(false);
                  setKRs([{ id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' }]);
                }}
                className="px-4 py-2 text-gray-600 hover:text-gray-800"
              >
                取消
              </button>
              <button
                onClick={handleCreateOKR}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PMOPage;