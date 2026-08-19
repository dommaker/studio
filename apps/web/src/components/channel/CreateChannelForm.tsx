// #272（决策 #251 Q3/Q7）：创建频道表单单一实现 —— ChannelListPage 与 ChannelRail 共用。
// 可选「默认工程」（本地 repo，/projects/discover 候选，可留空 → 落 channel.defaultPath）；
// 「默认执行机器」（远程 Workspace，Admin 概念）不进创建表单。
// 提交中 loading 防连点（工单 38 行为保留）；失败内联报错。
import { useEffect, useState } from 'react';
import { channelApi, type LocalProject } from '../../api/channel';
import type { ChannelListItem, CreateChannelInput } from '../../hooks/useChannelList';
import { Select, Button } from '../ui';

const TYPE_LABELS: Record<string, string> = {
  rnd: '研发',
  decision: '决策',
  system: '系统',
};

interface CreateChannelFormProps {
  /** 来自 useChannelList 的创建动作（单源：频道列表缓存同步在 hook 内） */
  createChannel: (input: CreateChannelInput) => Promise<ChannelListItem>;
  onCreated: (channel: ChannelListItem) => void;
  onCancel: () => void;
}

export function CreateChannelForm({ createChannel, onCreated, onCancel }: CreateChannelFormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState('rnd');
  const [agents, setAgents] = useState('');
  const [defaultPath, setDefaultPath] = useState('');
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // 默认工程候选 = 本地工程发现（非 Admin-only 接口，创建表单可用）
  useEffect(() => {
    let alive = true;
    channelApi.discoverProjects()
      .then(res => { if (alive) setProjects(res.data.data || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setError('');
    setCreating(true);
    try {
      const agentNames = agents.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      const ch = await createChannel({
        name: name.trim(),
        type,
        agents: agentNames,
        ...(defaultPath ? { defaultPath } : {}),
      });
      onCreated(ch);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e?.response?.data?.error || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mc-newchan">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleCreate()}
        placeholder="#频道名称"
        aria-label="频道名称"
        autoFocus
      />
      <textarea
        value={agents}
        onChange={e => setAgents(e.target.value)}
        placeholder="初始 Agent（可选，逗号分隔）"
        aria-label="初始 Agent"
        rows={2}
      />
      <Select
        value={defaultPath}
        onChange={setDefaultPath}
        options={[
          { value: '', label: '默认工程：无（可选）' },
          ...projects.map(p => ({ value: p.path, label: p.name })),
        ]}
        aria-label="默认工程"
      />
      <div className="mc-newchan-row">
        <Select
          value={type}
          onChange={setType}
          options={Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
          aria-label="频道类型"
        />
        <Button size="sm" loading={creating} loadingLabel="创建中..." onClick={handleCreate}>创建</Button>
        <button className="mc-btn" onClick={onCancel}>取消</button>
      </div>
      {error && <div className="mc-newchan-error">{error}</div>}
    </div>
  );
}
