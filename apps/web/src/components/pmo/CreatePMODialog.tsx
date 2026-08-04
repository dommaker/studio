// 🆕 PMO-a: 新建 PMO 弹窗（style-guide §4.3 标准结构）（从 pages/PMOPage.tsx 抽出，纯代码移动；状态仍由页面持有）
import { Select } from '../ui';
import type { LocalProject } from '../../api/channel';

interface CreatePMODialogProps {
  newTitle: string;
  setNewTitle: (v: string) => void;
  newRequirement: string;
  setNewRequirement: (v: string) => void;
  newGitRepo: string;
  setNewGitRepo: (v: string) => void;
  newDeliveryPolicy: 'branch-only' | 'auto-merge';
  setNewDeliveryPolicy: (v: 'branch-only' | 'auto-merge') => void;
  creating: boolean;
  discoveredProjects: LocalProject[];
  projectsScanning: boolean;
  projectsScanError: boolean;
  loadDiscoveredProjects: () => void;
  setShowCreateForm: (show: boolean) => void;
  handleCreateProject: () => void;
}

export function CreatePMODialog({
  newTitle,
  setNewTitle,
  newRequirement,
  setNewRequirement,
  newGitRepo,
  setNewGitRepo,
  newDeliveryPolicy,
  setNewDeliveryPolicy,
  creating,
  discoveredProjects,
  projectsScanning,
  projectsScanError,
  loadDiscoveredProjects,
  setShowCreateForm,
  handleCreateProject,
}: CreatePMODialogProps) {
  return (
    <div className="modal-overlay" onClick={() => setShowCreateForm(false)}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">新建 PMO</h2>
          <button className="modal-close" onClick={() => setShowCreateForm(false)} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>标题 *</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="input"
                style={{ width: '100%' }}
                placeholder="项目标题"
              />
            </div>
            <div>
              <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>需求描述</label>
              <textarea
                value={newRequirement}
                onChange={(e) => setNewRequirement(e.target.value)}
                className="input"
                style={{ width: '100%', resize: 'none' }}
                rows={3}
                placeholder="需求背景、验收标准等"
              />
            </div>
            <div>
              <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>工程路径 (gitRepo)</label>
              <Select
                value={newGitRepo}
                onChange={setNewGitRepo}
                options={[
                  { value: '', label: '（不关联工程）' },
                  ...discoveredProjects.map(p => ({ value: p.path, label: `${p.name}（${p.path}）` })),
                ]}
                placeholder={projectsScanning ? '正在扫描本地工程…' : '选择扫描到的工程'}
                disabled={projectsScanning}
                aria-label="工程路径"
                className="input"
                style={{ width: '100%' }}
              />
              {projectsScanError && (
                <div className="text-xs mt-1 u-text-3">
                  工程扫描失败（需要管理员权限）。
                  <button
                    onClick={loadDiscoveredProjects}
                    className="u-accent"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' }}
                  >
                    重试
                  </button>
                </div>
              )}
              {!projectsScanning && !projectsScanError && discoveredProjects.length === 0 && (
                <div className="text-xs mt-1 u-text-3">
                  未扫描到本地工程（检查 STUDIO_PROJECTS_ROOT 配置）
                </div>
              )}
            </div>
            <div>
              <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>交付策略</label>
              <Select
                value={newDeliveryPolicy}
                onChange={(v) => setNewDeliveryPolicy(v as 'branch-only' | 'auto-merge')}
                options={[
                  { value: 'branch-only', label: '分支交付（不碰合并/发布）' },
                  { value: 'auto-merge', label: '自动合并（缺证据拒绝）' },
                ]}
                className="input"
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={() => setShowCreateForm(false)} className="btn btn-secondary">
            取消
          </button>
          <button onClick={handleCreateProject} disabled={creating} className="btn btn-primary">
            {creating ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
