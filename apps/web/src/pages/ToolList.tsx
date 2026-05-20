// 工具列表 - 只读（科幻极简风）
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilities } from '../hooks/useCapabilities';
import StageTabs, { type Stage } from '../components/StageTabs';
import '../styles/theme.css';

interface ToolInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  type: 'tool';
  path: string;
}

export function ToolList() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<Stage | 'all'>('all');
  const { data: stageCategories } = useCapabilities();

  useEffect(() => {
    loadTools();
  }, []);

  const filteredTools = activeStage === 'all' ? tools :
    tools.filter(t => stageCategories?.find(s => s.id === activeStage)?.tools?.some(st => st.name === t.name) ?? false);

  const loadTools = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/tools-std');
      if (!response.ok) {
        setTools([]);
        setError('Runtime 服务暂不可用');
        return;
      }
      const data = await response.json();
      setTools(data || []);
      setError(null);
    } catch (err: any) {
      setTools([]);
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6" style={{ background: 'var(--bg-primary)', minHeight: '100vh' }}>
        <div className="flex items-center justify-center h-64">
          <div className="loading-spinner"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6" style={{ background: 'var(--bg-primary)', minHeight: '100vh' }}>
      <div className="mb-6">
        <h1 className="page-title">{t('tools.title', '工具管理')}</h1>
        <p className="page-subtitle">共 {tools.length} 个内置工具</p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded" style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)' }}>
          ⚠️ {error}
          <button onClick={loadTools} className="ml-3 underline">重试</button>
        </div>
      )}

      <StageTabs 
        activeStage={activeStage} 
        setActiveStage={setActiveStage} 
        workflows={tools} 
        stageCategories={stageCategories}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredTools.map((tool) => (
          <div key={tool.id} className="feature-card">
            <div className="flex items-start gap-3">
              <div className="feature-icon">🔧</div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>{tool.name}</h3>
                <p className="text-sm mt-1 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                  {tool.description}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="tag">{tool.category}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {tools.length === 0 && !error && (
        <div className="empty-state">
          <div className="empty-icon">🔧</div>
          <p>{t('tools.empty', '暂无工具')}</p>
        </div>
      )}
    </div>
  );
}

export default ToolList;