// AC-E3: Convert to Task dialog — LLM suggestion + form
import { useState, useEffect } from 'react';
import { channelApi, type AgentProfile, type ConvertSuggestion, type LocalProject } from '../../api/channel';

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

  // Fetch agents + projects + LLM suggestion on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTitle('');
    setDescription('');
    setAssigneeId('');
    setProjectPath('');

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
    } catch {
      // TODO: error toast
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">转为任务</h2>

        {/* Source message preview */}
        <div className="text-xs text-gray-500 border-l-2 border-gray-300 pl-2 mb-4 italic truncate">
          {messageContent}
        </div>

        {loading && (
          <div className="text-center text-gray-400 text-sm mb-4">正在获取建议...</div>
        )}

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">标题</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="任务标题"
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">描述</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="任务描述"
              rows={3}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">分配给</label>
            <select
              value={assigneeId}
              onChange={e => setAssigneeId(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">未分配</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">项目</label>
            <select
              value={projectPath}
              onChange={e => setProjectPath(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">无</option>
              {projects.map(p => (
                <option key={p.path} value={p.path}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-800"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || loading}
            className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
          >
            {submitting ? '创建中...' : '创建任务'}
          </button>
        </div>
      </div>
    </div>
  );
}
