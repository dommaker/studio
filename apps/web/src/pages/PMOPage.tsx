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

interface OKR {
  id: string;
  title: string;
  quarter: string;
  status: string;
  progress: number;
  projectCount: number;
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
  const [okrs, setOKRs] = useState<OKR[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  
  // 🆕 AS-016: OKR 创建弹窗
  const [showOKRDialog, setShowOKRDialog] = useState(false);
  const [newOKRTitle, setNewOKRTitle] = useState('');
  const [newOKRQuarter, setNewOKRQuarter] = useState(getCurrentQuarter());
  
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

  // 🆕 AS-016: 创建 OKR
  const handleCreateOKR = async () => {
    if (!newOKRTitle.trim()) {
      toast.warning('请输入 OKR 标题');
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
        objectives: [{ id: '1', title: '季度目标' }],
        keyResults: [],
      });

      setShowOKRDialog(false);
      setNewOKRTitle('');
      loadData(); // 刷新列表
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
                  <div className="flex items-center justify-between">
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
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 🆕 AS-016: 创建 OKR 弹窗 */}
      {showOKRDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="text-lg font-semibold mb-4">创建 OKR</h3>
            
            <div className="space-y-4">
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
                  placeholder="2026 Q3 OKR"
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setShowOKRDialog(false)}
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