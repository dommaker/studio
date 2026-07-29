// AC-E3: Convert to Task dialog — LLM suggestion + form
// 2026-07 视觉重构（方向 A Mission Control）：深色变量重绘；交互语义零变更
import { useState, useEffect } from 'react';
import { channelApi, type AgentProfile, type ConvertSuggestion, type LocalProject } from '../../api/channel';
import { Select } from '../ui';

interface Props {
  open: boolean;
  onClose: () => void;
  messageId: string;
  channelId: string;
  messageContent: string;
  onConverted: () => void;
}

export function ConvertToTaskDialog({ open, onClose, messageId, channelId, messageContent, onConverted }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Fetch agents + projects + LLM suggestion on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTitle('');
    setDescription('');
    setAssigneeId('');
    setProjectPath('');
    setError('');

    Promise.all([
      channelApi.listAgents(channelId).then(r => r.data.data).catch(() => []),
      channelApi.discoverProjects().then(r => r.data.data).catch(() => []),
      channelApi.suggestTask(channelId, messageId).then(r => r.data.data).catch(() => ({} as ConvertSuggestion)),
    ]).then(([agentsRes, projectsRes, suggestion]) => {
      setAgents(agentsRes);
      setProjects(projectsRes);
      if (suggestion.title) setTitle(suggestion.title);
      if (suggestion.description) setDescription(suggestion.description);
      if (suggestion.suggestedAssigneeId) setAssigneeId(suggestion.suggestedAssigneeId);
      if (suggestion.suggestedProjectPath) setProjectPath(suggestion.suggestedProjectPath);
    }).finally(() => setLoading(false));
  }, [open, channelId, messageId]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await channelApi.convertToTask(channelId, messageId, {
        title: title || undefined,
        description: description || undefined,
        assigneeId: assigneeId || undefined,
        projectPath: projectPath || undefined,
      });
      onConverted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <h2 className="modal-title" style={{ marginBottom: 12 }}>转为任务</h2>

        {/* Source message preview */}
        <div className="mc-quote" style={{ marginBottom: 12 }}>
          {messageContent}
        </div>

        {loading && (
          <div className="mc-drawer-note" style={{ textAlign: 'center', marginBottom: 12 }}>正在获取建议...</div>
        )}

        {error && (
          <div className="mc-status mc-status-error" style={{ display: 'flex', marginBottom: 12, padding: '6px 10px' }}>{error}</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>标题</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="任务标题"
              className="input"
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>描述</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="任务描述"
              rows={3}
              className="input"
              style={{ width: '100%', resize: 'none' }}
            />
          </div>
          <div>
            <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>分配给</label>
            <Select
              value={assigneeId}
              onChange={setAssigneeId}
              options={[
                { value: '', label: '未分配' },
                ...agents.map(a => ({ value: a.id, label: a.name })),
              ]}
              className="input"
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>项目</label>
            <Select
              value={projectPath}
              onChange={setProjectPath}
              options={[
                { value: '', label: '无' },
                ...projects.map(p => ({ value: p.path, label: p.name })),
              ]}
              className="input"
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} className="mc-btn">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || loading}
            className="mc-btn mc-btn-primary"
          >
            {submitting ? '创建中...' : '创建任务'}
          </button>
        </div>
      </div>
    </div>
  );
}
