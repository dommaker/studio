/**
 * 冷启动导入向导
 *
 * Step 1: 选择项目
 * Step 2: 扫描文件
 * Step 3: 选择导入内容
 * Step 4: 导入结果
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { toast } from '../utils/toast';

interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  status: string;
}

interface ScannedFile {
  path: string;
  name: string;
  relativePath: string;
  size: number;
  ext: string;
  inferredType: string;
  tags: string[];
  modifiedAt: string;
  selected?: boolean;
}

interface ScanResult {
  projectId: string;
  projectTitle: string;
  scanPath: string;
  totalFiles: number;
  byType: Record<string, number>;
  files: ScannedFile[];
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
  results: Array<{ path: string; status: string; documentId?: string; error?: string }>;
}

const TYPE_LABELS: Record<string, { label: string; icon: string }> = {
  requirement: { label: '需求', icon: '📄' },
  design: { label: '设计', icon: '📐' },
  spec: { label: '规范', icon: '📋' },
  execution: { label: '执行', icon: '⚡' },
};

export function KnowledgeImportPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);

  // Step 1: 项目选择
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(true);

  // Step 2: 扫描配置
  const [scanPath, setScanPath] = useState('');
  const [maxDepth, setMaxDepth] = useState(3);
  const [scanning, setScanning] = useState(false);

  // Step 3: 扫描结果
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState('');

  // Step 4: 导入
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // 加载项目列表
  useEffect(() => {
    const loadProjects = async () => {
      try {
        const companyId = localStorage.getItem('companyId') || '';
        const { data } = await api.get('/pmo/project', { params: { companyId, limit: 100 } });
        setProjects(data.data || data || []);
      } catch (err) {
        console.error('Failed to load projects:', err);
      } finally {
        setLoadingProjects(false);
      }
    };
    loadProjects();
  }, []);

  // 扫描文件
  const handleScan = async () => {
    if (!selectedProjectId) return;
    setScanning(true);
    try {
      const { data } = await api.post('/knowledge/import/scan', {
        projectId: selectedProjectId,
        scanPath: scanPath || undefined,
        maxDepth,
      });
      setScanResult(data);
      // 默认全选
      setSelectedFiles(new Set(data.files.map((f: ScannedFile) => f.path)));
      setStep(3);
    } catch (err) {
      console.error('Scan failed:', err);
      toast.error('扫描失败，请检查路径');
    } finally {
      setScanning(false);
    }
  };

  // 切换文件选中
  const toggleFile = (filePath: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  // 全选/取消全选
  const toggleAll = () => {
    if (!scanResult) return;
    const filtered = getFilteredFiles();
    const allSelected = filtered.every(f => selectedFiles.has(f.path));
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (allSelected) {
        filtered.forEach(f => next.delete(f.path));
      } else {
        filtered.forEach(f => next.add(f.path));
      }
      return next;
    });
  };

  // 获取过滤后的文件
  const getFilteredFiles = useCallback(() => {
    if (!scanResult) return [];
    if (!filterType) return scanResult.files;
    return scanResult.files.filter(f => f.inferredType === filterType);
  }, [scanResult, filterType]);

  // 执行导入
  const handleImport = async () => {
    if (!scanResult || selectedFiles.size === 0) return;
    setImporting(true);
    try {
      const filesToImport = scanResult.files
        .filter(f => selectedFiles.has(f.path))
        .map(f => ({ path: f.path, type: f.inferredType, tags: f.tags }));

      const { data } = await api.post('/knowledge/import/execute', {
        projectId: scanResult.projectId,
        files: filesToImport,
      });
      setImportResult(data);
      setStep(4);
    } catch (err) {
      console.error('Import failed:', err);
      toast.error('导入失败');
    } finally {
      setImporting(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto min-h-full">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>📥 冷启动导入</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          从项目代码库和文档中批量导入知识，快速构建知识库
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-2 mb-8">
        {[1, 2, 3, 4].map(s => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              step >= s ? '' : ''
            }`} style={{
              background: step >= s ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
              color: step >= s ? 'white' : 'var(--text-tertiary)',
            }}>
              {step > s ? '✓' : s}
            </div>
            <span className="text-sm" style={{ color: step >= s ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              {s === 1 ? '选择项目' : s === 2 ? '配置扫描' : s === 3 ? '选择内容' : '导入结果'}
            </span>
            {s < 4 && <div className="w-8 h-px" style={{ background: 'var(--border-subtle)' }} />}
          </div>
        ))}
      </div>

      {/* Step 1: 选择项目 */}
      {step === 1 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>选择项目</h2>
          {loadingProjects ? (
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>加载项目列表...</div>
          ) : projects.length === 0 ? (
            <div className="text-center py-8">
              <p style={{ color: 'var(--text-tertiary)' }}>暂无项目</p>
              <button onClick={() => navigate('/pmo')} className="mt-2 text-sm" style={{ color: 'var(--accent-primary)' }}>
                去创建项目 →
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {projects.map(p => (
                <button key={p.id} onClick={() => setSelectedProjectId(p.id)}
                  className="p-4 rounded-xl text-left transition-all"
                  style={{
                    background: selectedProjectId === p.id ? 'var(--bg-elevated)' : 'var(--bg-tertiary)',
                    border: selectedProjectId === p.id ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
                  }}>
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{p.title}</div>
                  <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{p.pmoNumber} • {p.status}</div>
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-4">
            <button onClick={() => setStep(2)} disabled={!selectedProjectId}
              className="btn btn-primary" style={{ opacity: selectedProjectId ? 1 : 0.5 }}>
              下一步
            </button>
          </div>
        </div>
      )}

      {/* Step 2: 配置扫描 */}
      {step === 2 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>配置扫描</h2>
          <div className="p-4 rounded-xl space-y-4" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>扫描路径</label>
              <input type="text" value={scanPath} onChange={e => setScanPath(e.target.value)}
                placeholder="默认：项目关联的仓库路径" className="input w-full" />
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                留空则使用项目的 Git 仓库路径或默认知识库目录
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>扫描深度</label>
              <div className="flex items-center gap-4">
                <input type="range" min="1" max="5" value={maxDepth}
                  onChange={e => setMaxDepth(parseInt(e.target.value))} className="flex-1" />
                <span className="text-sm font-mono w-8 text-center" style={{ color: 'var(--text-primary)' }}>{maxDepth}</span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                深度 1 = 仅当前目录，深度 5 = 递归 5 层子目录
              </p>
            </div>
            <div className="p-3 rounded-lg text-sm" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
              <strong>扫描范围：</strong> .md, .txt, .json, .yaml, .yml, .toml 文件（最大 500KB）
              <br />
              <strong>跳过：</strong> node_modules, dist, build, .git, 隐藏目录
            </div>
          </div>
          <div className="flex justify-between pt-4">
            <button onClick={() => setStep(1)} className="btn btn-secondary">上一步</button>
            <button onClick={handleScan} disabled={scanning}
              className="btn btn-primary">
              {scanning ? '扫描中...' : '开始扫描'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: 选择导入内容 */}
      {step === 3 && scanResult && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              选择导入内容
            </h2>
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {selectedFiles.size} / {scanResult.totalFiles} 个文件已选中
            </span>
          </div>

          {/* 类型统计 */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setFilterType('')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${filterType === '' ? '' : 'opacity-60'}`}
              style={{
                background: filterType === '' ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                color: filterType === '' ? 'white' : 'var(--text-secondary)',
              }}>
              全部 ({scanResult.totalFiles})
            </button>
            {Object.entries(scanResult.byType).map(([type, count]) => {
              const info = TYPE_LABELS[type] || { label: type, icon: '📄' };
              return (
                <button key={type} onClick={() => setFilterType(filterType === type ? '' : type)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${filterType === type ? '' : 'opacity-60'}`}
                  style={{
                    background: filterType === type ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                    color: filterType === type ? 'white' : 'var(--text-secondary)',
                  }}>
                  {info.icon} {info.label} ({count})
                </button>
              );
            })}
          </div>

          {/* 文件列表 */}
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" checked={getFilteredFiles().length > 0 && getFilteredFiles().every(f => selectedFiles.has(f.path))}
                  onChange={toggleAll} className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent-primary)' }} />
                <span style={{ color: 'var(--text-secondary)' }}>全选</span>
              </label>
            </div>
            <div className="max-h-96 overflow-y-auto divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              {getFilteredFiles().map(file => (
                <label key={file.path} className="flex items-start gap-3 p-3 cursor-pointer hover:opacity-80 transition"
                  style={{ background: selectedFiles.has(file.path) ? 'var(--bg-elevated)' : 'transparent' }}>
                  <input type="checkbox" checked={selectedFiles.has(file.path)}
                    onChange={() => toggleFile(file.path)}
                    className="w-4 h-4 rounded mt-0.5 flex-shrink-0" style={{ accentColor: 'var(--accent-primary)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{TYPE_LABELS[file.inferredType]?.icon || '📄'}</span>
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{file.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
                        {file.ext}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {file.relativePath}
                    </div>
                    {file.tags.length > 0 && (
                      <div className="flex gap-1 mt-1">
                        {file.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="text-xs px-1.5 py-0.5 rounded"
                            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                    {formatSize(file.size)}
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-between pt-4">
            <button onClick={() => setStep(2)} className="btn btn-secondary">上一步</button>
            <button onClick={handleImport} disabled={importing || selectedFiles.size === 0}
              className="btn btn-primary" style={{ opacity: selectedFiles.size > 0 ? 1 : 0.5 }}>
              {importing ? '导入中...' : `导入选中的 ${selectedFiles.size} 个文件`}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: 导入结果 */}
      {step === 4 && importResult && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>导入完成</h2>

          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-xl text-center" style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid #22c55e' }}>
              <div className="text-3xl font-bold u-ok">{importResult.imported}</div>
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>已导入</div>
            </div>
            <div className="p-4 rounded-xl text-center" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid #f59e0b' }}>
              <div className="text-3xl font-bold u-warn">{importResult.skipped}</div>
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>已跳过</div>
            </div>
            <div className="p-4 rounded-xl text-center" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444' }}>
              <div className="text-3xl font-bold u-err">{importResult.errors}</div>
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>失败</div>
            </div>
          </div>

          {importResult.errors > 0 && (
            <div className="p-4 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
              <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>错误详情</h3>
              {importResult.results.filter(r => r.status === 'error').map((r, i) => (
                <div key={i} className="text-xs py-1" style={{ color: '#ef4444' }}>
                  {r.path}: {r.error}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between pt-4">
            <button onClick={() => { setStep(1); setScanResult(null); setImportResult(null); setSelectedFiles(new Set()); }}
              className="btn btn-secondary">继续导入</button>
            <button onClick={() => {
              const companyId = localStorage.getItem('companyId') || '';
              navigate(`/knowledge?companyId=${companyId}`);
            }} className="btn btn-primary">查看知识库 →</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default KnowledgeImportPage;
