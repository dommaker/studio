// CreateProjectDialog - 新建 PMO 弹窗（工程多选 + 交付策略；自 PMOPage 抽出，工单 33）
// #114 T8：工程选择改多选——每个选中工程建一条交付腿（≥2 走 gitRepos 多工程入参，
// 单个选中仍走旧 gitRepo 入参，行为与现状一致）。
import { useState, useEffect, useCallback } from 'react';
import { projectApi } from '../../api';
import { channelApi, type LocalProject } from '../../api/channel';
import { toast } from '../../utils/toast';
import { Select } from '../ui';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateProjectDialog({ open, onClose, onCreated }: CreateProjectDialogProps) {
  // 🆕 PMO-a: 新建 PMO 弹窗（决策 2/4：deliveryPolicy 创建时选定，默认 branch-only）
  const [newTitle, setNewTitle] = useState('');
  const [newRequirement, setNewRequirement] = useState('');
  // 🆕 #114 T8：工程多选（每个选中工程一条交付腿）
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [newDeliveryPolicy, setNewDeliveryPolicy] = useState<'branch-only' | 'auto-merge'>('branch-only');
  const [creating, setCreating] = useState(false);
  // 工程清单：打开弹窗时实时扫描（与角色 CLI 扫描同一交互模式）
  const [discoveredProjects, setDiscoveredProjects] = useState<LocalProject[]>([]);
  const [projectsScanning, setProjectsScanning] = useState(false);
  const [projectsScanError, setProjectsScanError] = useState(false);

  // 工程扫描：打开新建弹窗时调 GET /projects/discover 取最新列表（服务端 60s 缓存）
  //（promise 链写法：setState 全部在回调里，符合 set-state-in-effect 规则的外部同步口径）
  const loadDiscoveredProjects = useCallback(() => {
    channelApi.discoverProjects()
      .then((res) => {
        setDiscoveredProjects(res.data?.data || []);
      })
      .catch(() => {
        setDiscoveredProjects([]);
        setProjectsScanError(true);
      })
      .finally(() => {
        setProjectsScanning(false);
      });
  }, []);

  // 打开弹窗时在渲染期同步置扫描标志（prevOpen 上升沿，替代原 effect 内同步 setState）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setProjectsScanning(true);
      setProjectsScanError(false);
    }
  }

  // 打开弹窗时触发工程扫描（原 handleOpenCreateForm 行为）
  useEffect(() => {
    if (open) loadDiscoveredProjects();
  }, [open, loadDiscoveredProjects]);

  // 🆕 PMO-a: 创建 PMO（companyId 由服务端解析；成功后刷新列表并清空表单）
  // #114 T8：选中 ≥2 个工程走 gitRepos 多工程入参（每工程一条腿）；单个选中走旧 gitRepo 入参
  const handleCreateProject = async () => {
    if (!newTitle.trim()) {
      toast.warning('请输入标题');
      return;
    }
    setCreating(true);
    try {
      await projectApi.create({
        title: newTitle.trim(),
        requirement: newRequirement.trim() || undefined,
        ...(selectedRepos.length === 1
          ? { gitRepo: selectedRepos[0] }
          : selectedRepos.length > 1
            ? { gitRepos: selectedRepos }
            : {}),
        deliveryPolicy: newDeliveryPolicy,
      });
      toast.success('创建成功');
      onClose();
      setNewTitle('');
      setNewRequirement('');
      setSelectedRepos([]);
      setNewDeliveryPolicy('branch-only');
      onCreated();
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err?.message || '创建 PMO 失败';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const toggleRepo = (path: string) => {
    setSelectedRepos(prev =>
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path],
    );
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">新建 PMO</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
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
              <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>
                工程（可多选，每个选中工程建一条交付腿）
              </label>
              <div className="u-surface-2 rounded" style={{ padding: 8, maxHeight: 180, overflowY: 'auto' }}>
                {projectsScanning ? (
                  <div className="text-xs u-text-3">正在扫描本地工程…</div>
                ) : (
                  discoveredProjects.map(p => (
                    <label
                      key={p.path}
                      className="flex items-center gap-2 text-sm u-text-1"
                      style={{ cursor: 'pointer', padding: '4px 0' }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedRepos.includes(p.path)}
                        onChange={() => toggleRepo(p.path)}
                      />
                      <span>{p.name}（{p.path}）</span>
                    </label>
                  ))
                )}
              </div>
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
          <button onClick={onClose} className="btn btn-secondary">
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
