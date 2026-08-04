// AC-6: 发起需求讨论弹窗（选择目标频道）（从 pages/PMOPage.tsx 抽出，纯代码移动；状态仍由页面持有）
import { Select } from '../ui';
import type { AgentProfile, Channel } from '../../api/channel';

interface PublishProjectDialogProps {
  channels: Channel[];
  selectedChannelId: string;
  setSelectedChannelId: (v: string) => void;
  agentsLoading: boolean;
  channelAgents: AgentProfile[];
  publishing: boolean;
  setShowPublishDialog: (show: boolean) => void;
  handlePublishConfirm: () => void;
}

export function PublishProjectDialog({
  channels,
  selectedChannelId,
  setSelectedChannelId,
  agentsLoading,
  channelAgents,
  publishing,
  setShowPublishDialog,
  handlePublishConfirm,
}: PublishProjectDialogProps) {
  return (
    <div className="modal-overlay" onClick={() => setShowPublishDialog(false)}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">发起需求讨论</h2>
          <button className="modal-close" onClick={() => setShowPublishDialog(false)} aria-label="关闭">×</button>
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
          <button onClick={() => setShowPublishDialog(false)} className="btn btn-secondary">
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
