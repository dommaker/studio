// PublishProjectDialog - 发起需求讨论弹窗（选择目标频道；自 PMOPage 抽出，工单 33）
import { useState, useEffect } from 'react';
import { projectApi } from '../../api';
import { channelApi, type Channel, type AgentProfile } from '../../api/channel';
import { toast } from '../../utils/toast';
import { Select } from '../ui';
import { parseIdArray } from './okrMetric';

interface PublishProjectDialogProps {
  open: boolean;
  projectId: string | null;
  channels: Channel[];
  onClose: () => void;
  onPublished: (channelId: string) => void;
}

export function PublishProjectDialog({ open, projectId, channels, onClose, onPublished }: PublishProjectDialogProps) {
  // AC-6: Publish dialog state
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [publishing, setPublishing] = useState(false);
  // 发起弹窗：所选频道可响应的 Agent 成员（谁会认领一目了然；空 → 提前警示）
  const [channelAgents, setChannelAgents] = useState<AgentProfile[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  // 打开弹窗时默认选中第一个频道（原 handlePublishClick 行为）
  useEffect(() => {
    if (open) setSelectedChannelId(channels.length > 0 ? channels[0].id : '');
  }, [open, channels]);

  // 弹窗打开/切换频道时解析「谁会响应」：与 AgentLoop.observe 同一口径 ——
  // channel.members 非空 → 仅成员；为空（历史频道未回填）→ 回退 profile.channels（空 = 全频道可见）
  useEffect(() => {
    if (!open || !selectedChannelId) return;
    let cancelled = false;
    setAgentsLoading(true);
    channelApi.listAllAgents()
      .then(res => {
        if (cancelled) return;
        const active = (res.data?.data || []).filter(p => p.status === 'active' && p.name !== 'studio');
        const ch = channels.find(c => c.id === selectedChannelId);
        const memberIds = parseIdArray(ch?.members);
        const responders = memberIds.length > 0
          ? active.filter(p => memberIds.includes(p.id))
          : active.filter(p => {
              const chs = parseIdArray(typeof p.channels === 'string' ? p.channels : JSON.stringify(p.channels ?? []));
              return chs.length === 0 || chs.includes(selectedChannelId);
            });
        setChannelAgents(responders);
      })
      .catch(() => { if (!cancelled) setChannelAgents([]); })
      .finally(() => { if (!cancelled) setAgentsLoading(false); });
    return () => { cancelled = true; };
  }, [open, selectedChannelId, channels]);

  const handlePublishConfirm = async () => {
    if (!projectId || !selectedChannelId) return;
    setPublishing(true);
    try {
      await projectApi.publish(projectId, selectedChannelId);
      toast.success('已发起需求讨论');
      onClose();
      // 闭环：发起后直达频道，可看到需求消息与 agent 的实时回复
      onPublished(selectedChannelId);
    } catch (err) {
      const msg = (err as Error).message || '发起失败';
      toast.error(msg);
    } finally {
      setPublishing(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">发起需求讨论</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          {channels.length === 0 ? (
            <p className="u-text-3 text-sm">无可用 Channel，请先创建</p>
          ) : (
            <>
              <Select
                value={selectedChannelId}
                onChange={setSelectedChannelId}
                options={channels.map(ch => ({ value: ch.id, label: ch.name }))}
                className="input"
                style={{ width: '100%' }}
              />
              {agentsLoading ? (
                <p className="u-text-3 text-sm" style={{ marginTop: 8 }}>加载频道成员…</p>
              ) : channelAgents.length > 0 ? (
                <p className="u-text-3 text-sm" style={{ marginTop: 8 }}>
                  会响应的 Agent（{channelAgents.length}）：{channelAgents.map(a => a.name).join('、')}
                  ——需求发到频道后由 TA 们认领并开始分析
                </p>
              ) : (
                <p className="u-warn text-sm" style={{ marginTop: 8 }}>
                  ⚠ 该频道没有可响应的 Agent 成员，发起后需求可能无人认领；请先在频道里添加成员
                </p>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-secondary">
            取消
          </button>
          <button
            onClick={handlePublishConfirm}
            disabled={publishing || channels.length === 0}
            className="btn btn-primary"
          >
            {publishing ? '发起中...' : '确认发起'}
          </button>
        </div>
      </div>
    </div>
  );
}
