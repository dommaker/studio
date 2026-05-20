// 工作流导入导出组件
import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface ImportResult {
  imported: { id: string; name: string; originalId?: string }[];
  skipped: { name: string; reason: string }[];
  errors: { name: string; error: string }[];
}

interface WorkflowImportExportProps {
  onImportComplete?: () => void;
}

export function WorkflowImportExport({ onImportComplete }: WorkflowImportExportProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const [_exportLoading, setExportLoading] = useState(false);

  // 导入工作流
  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportLoading(true);
    setImportResult(null);

    try {
      const content = await file.text();
      const data = JSON.parse(content);

      const res = await fetch('/api/v1/workflows/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) throw new Error('Import failed');

      const result = await res.json();
      setImportResult(result.results);
      setShowImportModal(true);

      if (onImportComplete && result.results.imported.length > 0) {
        onImportComplete();
      }
    } catch (err: any) {
      setImportResult({
        imported: [],
        skipped: [],
        errors: [{ name: 'file', error: err.message }],
      });
      setShowImportModal(true);
    } finally {
      setImportLoading(false);
      // 清空文件输入
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 导出单个工作流
  const _exportWorkflow = async (workflowId: string, workflowName: string) => {
    setExportLoading(true);
    try {
      const res = await fetch(`/api/v1/workflows/${workflowId}/export`);
      if (!res.ok) throw new Error('Export failed');

      const data = await res.json();

      // 创建下载
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workflow-${workflowName.replace(/\s+/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Export failed:', err);
    } finally {
      setExportLoading(false);
    }
  };

  // 导出所有工作流
  const _exportAllWorkflows = async () => {
    setExportLoading(true);
    try {
      const res = await fetch('/api/v1/workflows/export');
      if (!res.ok) throw new Error('Export failed');

      const data = await res.json();

      // 创建下载
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workflows-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Export all failed:', err);
    } finally {
      setExportLoading(false);
    }
  };

  // Silence unused warnings - these functions are kept for future use
  void _exportWorkflow;
  void _exportAllWorkflows;

  return (
    <>
      {/* 导入按钮 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImport}
        style={{ display: 'none' }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={importLoading}
        className="btn btn-secondary"
        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
      >
        <span>📥</span>
        <span>{importLoading ? t('workflowImportExport.importing') : t('workflowImportExport.import')}</span>
      </button>

      {/* 导入结果弹窗 */}
      {showImportModal && importResult && (
        <div className="modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2 className="modal-title">{t('workflowImportExport.importResult')}</h2>
              <button onClick={() => setShowImportModal(false)} className="modal-close">×</button>
            </div>

            <div className="modal-body">
              {/* 统计 */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="stat-card">
                  <div className="stat-value text-green-400">{importResult.imported.length}</div>
                  <div className="stat-label">{t('workflowImportExport.imported')}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value text-yellow-400">{importResult.skipped.length}</div>
                  <div className="stat-label">{t('workflowImportExport.skipped')}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value text-red-400">{importResult.errors.length}</div>
                  <div className="stat-label">{t('workflowImportExport.errors')}</div>
                </div>
              </div>

              {/* 导入成功 */}
              {importResult.imported.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-green-400 mb-2">
                    {t('workflowImportExport.imported')}
                  </h3>
                  <div className="space-y-1">
                    {importResult.imported.map(w => (
                      <div key={w.id} className="text-sm text-primary">
                        ✓ {w.name}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 跳过 */}
              {importResult.skipped.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-yellow-400 mb-2">
                    {t('workflowImportExport.skipped')}
                  </h3>
                  <div className="space-y-1">
                    {importResult.skipped.map(w => (
                      <div key={w.name} className="text-sm text-secondary">
                        ⚠ {w.name}: {w.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 错误 */}
              {importResult.errors.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-red-400 mb-2">
                    {t('workflowImportExport.errors')}
                  </h3>
                  <div className="space-y-1">
                    {importResult.errors.map(w => (
                      <div key={w.name} className="text-sm text-red-400">
                        ✗ {w.name}: {w.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button onClick={() => setShowImportModal(false)} className="btn btn-primary">
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 导出按钮组件
export function WorkflowExportButton({ workflowId, workflowName }: { workflowId: string; workflowName: string }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/workflows/${workflowId}/export`);
      if (!res.ok) throw new Error('Export failed');

      const data = await res.json();

      // 创建下载
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workflow-${workflowName.replace(/\s+/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Export failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={loading}
      className="btn btn-sm btn-secondary"
    >
      {loading ? t('common.loading') : t('workflowImportExport.export')}
    </button>
  );
}

export default WorkflowImportExport;