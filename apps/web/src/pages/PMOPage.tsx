// PMOPage - PMO 管理主页面（项目 + OKR）
import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api, projectApi } from '../api';
import { channelApi, type Channel } from '../api/channel';
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

// B8 Phase 1.5: metricType 元数据
const METRIC_META: Record<string, { unit: string; upperBound: number; baseline?: number }> = {
  '': { unit: '', upperBound: 100 },
  pipeline_duration_p90: { unit: 'min', upperBound: Infinity, baseline: 23 },
  pipeline_duration_per_phase: { unit: 'min', upperBound: Infinity },
  cache_hit_rate: { unit: '%', upperBound: 99.9, baseline: 94 },
  execution_success_rate: { unit: '%', upperBound: 100, baseline: 12 },
  review_pass_rate: { unit: '%', upperBound: 100 },
  token_saving_ratio: { unit: '%', upperBound: 90 },
};

interface KRValidation {
  status: 'pass' | 'warning' | 'blocked';
  reason: string;
}

function validateKRTarget(kr: KR): KRValidation {
  if (kr.target <= 0) return { status: 'blocked', reason: '目标必须大于 0' };
  if (!kr.metricType) return { status: 'pass', reason: '' };

  const meta = METRIC_META[kr.metricType];
  if (!meta) return { status: 'pass', reason: '' };

  // Baseline check: target below current level
  if (meta.baseline !== undefined && kr.target < meta.baseline) {
    return {
      status: 'blocked',
      reason: `目标 (${kr.target}${meta.unit}) 低于当前水平 (${meta.baseline}${meta.unit})。建议 >= ${Math.ceil(meta.baseline * 1.05)}${meta.unit}`,
    };
  }

  // Upper bound check: target too close to theoretical limit
  if (meta.upperBound !== Infinity && kr.target > meta.upperBound * 0.95) {
    return {
      status: 'warning',
      reason: `接近理论上限 (${meta.upperBound}${meta.unit})，可能不可实现`,
    };
  }

  // Gap check: target too far from baseline
  if (meta.baseline !== undefined && kr.target > meta.baseline * 3) {
    return {
      status: 'warning',
      reason: `距当前水平 (${meta.baseline}${meta.unit}) 差距大，建议分阶段`,
    };
  }

  return { status: 'pass', reason: '' };
}

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
  const navigate = useNavigate();
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

  // AC-6: Publish dialog state
  const [channels, setChannels] = useState<Channel[]>([]);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishProjectId, setPublishProjectId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    loadData();
    loadChannels();
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

  const loadChannels = async () => {
    try {
      const res = await channelApi.list();
      setChannels(res.data?.data || []);
    } catch {
      // best-effort: channels may not be available
    }
  };

  const handlePublishClick = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    setPublishProjectId(projectId);
    setSelectedChannelId(channels.length > 0 ? channels[0].id : '');
    setShowPublishDialog(true);
  };

  const handlePublishConfirm = async () => {
    if (!publishProjectId || !selectedChannelId) return;
    setPublishing(true);
    try {
      await projectApi.publish(publishProjectId, selectedChannelId);
      toast.success('发布成功');
      setShowPublishDialog(false);
      loadData();
    } catch (err) {
      const msg = (err as Error).message || '发布失败';
      toast.error(msg);
    } finally {
      setPublishing(false);
    }
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
                  onClick={() => navigate(`/pmo/project/${project.id}`)}
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
                      {project.status === 'pending' && (
                        <button
                          onClick={(e) => handlePublishClick(e, project.id)}
                          disabled={channels.length === 0}
                          className="text-xs px-3 py-1 rounded font-medium transition-all"
                          style={{
                            background: channels.length === 0 ? 'var(--bg-tertiary)' : 'var(--accent-primary)',
                            color: channels.length === 0 ? 'var(--text-tertiary)' : '#fff',
                            cursor: channels.length === 0 ? 'not-allowed' : 'pointer',
                          }}
                          title={channels.length === 0 ? '无可用 Channel' : '发布到 Channel'}
                        >
                          发布
                        </button>
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
          <div className="u-surface rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6" style={{ maxHeight: '80vh', overflow: 'auto' }}>
            <h3 className="text-lg font-semibold mb-4">创建 OKR</h3>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm u-text-2 mb-1">季度</label>
                  <input
                    type="text"
                    value={newOKRQuarter}
                    onChange={(e) => setNewOKRQuarter(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg"
                    placeholder="2026-Q3"
                  />
                </div>
                <div>
                  <label className="text-sm u-text-2 mb-1">标题</label>
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
                  <label className="text-sm u-text-2">关键结果 (KR)</label>
                  <button
                    onClick={addKR}
                    className="text-xs px-2 py-1 rounded border u-border-2 u-hover-bg"
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
                          className="text-xs u-err u-hover-text"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="text-xs u-text-3">目标值</label>
                        <input
                          type="number"
                          value={kr.target}
                          min={1}
                          onChange={(e) => updateKR(kr.id, 'target', Number(e.target.value))}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                      <div>
                        <label className="text-xs u-text-3">当前值</label>
                        <input
                          type="number"
                          value={kr.current}
                          min={0}
                          onChange={(e) => updateKR(kr.id, 'current', Number(e.target.value))}
                          className="w-full px-2 py-1 text-sm border rounded"
                        />
                      </div>
                      <div>
                        <label className="text-xs u-text-3">单位</label>
                        <input
                          type="text"
                          value={kr.unit}
                          onChange={(e) => updateKR(kr.id, 'unit', e.target.value)}
                          className="w-full px-2 py-1 text-sm border rounded"
                          placeholder="% / min / 次"
                        />
                      </div>
                      <div>
                        <label className="text-xs u-text-3">自动度量</label>
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
                    {/* B8 Phase 1.5: inline validation */}
                    {kr.metricType && (() => {
                      const v = validateKRTarget(kr);
                      const meta = METRIC_META[kr.metricType];
                      if (v.status === 'pass' && !meta?.baseline) return null;
                      const color = v.status === 'blocked' ? '#F44336' : v.status === 'warning' ? '#FF9800' : '#4CAF50';
                      return (
                        <div className="mt-2 text-xs" style={{ color }}>
                          {meta?.baseline !== undefined && `基准: ${meta.baseline}${meta.unit}`}
                          {meta?.baseline !== undefined && v.status !== 'pass' && ' · '}
                          {v.status !== 'pass' ? v.reason : ''}
                          {v.status === 'pass' && meta?.baseline !== undefined && ` ✓ 目标合理`}
                        </div>
                      );
                    })()}
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
                className="px-4 py-2 u-text-2 u-hover-text"
              >
                取消
              </button>
              <button
                onClick={handleCreateOKR}
                className="px-4 py-2 u-accent-bg u-on-accent rounded-lg u-hover-bg"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AC-6: Publish dialog */}
      {showPublishDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="p-6 rounded-xl w-96" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
            <h3 className="text-lg font-bold mb-4" style={{ color: 'var(--text-primary)' }}>发布到 Channel</h3>
            {channels.length === 0 ? (
              <p style={{ color: 'var(--text-tertiary)' }}>无可用 Channel，请先创建</p>
            ) : (
              <select
                value={selectedChannelId}
                onChange={(e) => setSelectedChannelId(e.target.value)}
                className="w-full p-2 rounded mb-4"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
              >
                {channels.map(ch => (
                  <option key={ch.id} value={ch.id}>{ch.name}</option>
                ))}
              </select>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowPublishDialog(false)}
                className="px-4 py-2 rounded"
                style={{ color: 'var(--text-secondary)' }}
              >
                取消
              </button>
              <button
                onClick={handlePublishConfirm}
                disabled={publishing || channels.length === 0}
                className="px-4 py-2 rounded u-on-accent"
                style={{ background: publishing ? 'var(--bg-tertiary)' : 'var(--accent-primary)' }}
              >
                {publishing ? '发布中...' : '确认发布'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PMOPage;