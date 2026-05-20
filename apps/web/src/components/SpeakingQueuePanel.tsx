/**
 * SpeakingQueuePanel - 发言队列可视化组件
 * 
 * MR-013: 发言队列面板
 * 
 * 功能：
 * - 显示发言队列（等待中 + 已发言）
 * - 显示投票表决统计
 * - 显示签名确认进度
 * - WebSocket 实时更新
 */

import { useState, useEffect } from 'react';
import '../styles/theme.css';

interface SpeakingQueuePanelProps {
  meetingId: string;
  meetingStatus: string;
}

interface SpeakingQueueData {
  meetingId: string;
  currentRound: number;
  maxRounds: number;
  waitingQueue: Array<{
    order: number;
    roleId: string;
    roleName: string;
    roleLevel: number;
    stance: string;
  }>;
  spokenThisRound: Array<{
    roleId: string;
    roleName: string;
    speakCount: number;
    lastMessageAt: string;
  }>;
  stats: {
    totalMessages: number;
    consensusProgress: number;
  };
  discussionStatus: string;
  voting: {
    votes: { approve: number; reject: number; abstain: number; pending: number };
    pendingVoters: Array<{ roleId: string; roleName: string }>;
    votingRule: { mode: string; minApprovers: number };
    architectVeto: { canVeto: boolean; hasVetoed: boolean };
  } | null;
  signatures: {
    signed: Array<{
      roleId: string;
      roleName: string;
      stance: string;
      signedAt: string;
      verdict: 'approve' | 'reject' | 'abstain';
    }>;
    pending: Array<{ roleId: string; roleName: string }>;
    progress: { signedCount: number; totalCount: number; percentage: number };
  } | null;
}

export function SpeakingQueuePanel({ meetingId, meetingStatus }: SpeakingQueuePanelProps) {
  const [data, setData] = useState<SpeakingQueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载发言队列数据
  const loadData = async () => {
    try {
      const res = await fetch(`/api/v1/meetings/${meetingId}/speaking-queue`);
      if (!res.ok) {
        throw new Error('加载失败');
      }
      const json = await res.json();
      setData(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    }
    setLoading(false);
  };

  // 初始加载
  useEffect(() => {
    loadData();
  }, [meetingId]);

  // 定时刷新（会议进行中时）
  useEffect(() => {
    if (meetingStatus === 'completed') return;
    
    const interval = setInterval(loadData, 10000); // 10秒刷新
    return () => clearInterval(interval);
  }, [meetingStatus, meetingId]);

  // 状态显示
  const getStatusDisplay = (status: string) => {
    switch (status) {
      case 'running':
      case 'discussing':
        return { icon: '🟢', text: '进行中' };
      case 'paused':
        return { icon: '🟡', text: '已暂停' };
      case 'consensus':
      case 'completed':
        return { icon: '✅', text: '达成共识' };
      case 'pending_user':
        return { icon: '🔴', text: '需要决策' };
      default:
        return { icon: '⚪', text: status };
    }
  };

  // 立场图标（与 DiscussionDriver 统一）
  const getStanceIcon = (stance: string) => {
    const icons: Record<string, string> = {
      advocate: '📢',
      skeptic: '🔍',
      neutral: '⚖️',
      pragmatist: '🔧',
      visionary: '🚀',
      executor: '⚙️',
      reviewer: '📋',
      architect: '🏗️',
    };
    return icons[stance] || '👤';
  };

  // 签名状态图标
  const getVerdictIcon = (verdict: string) => {
    switch (verdict) {
      case 'approve':
        return '✅';
      case 'reject':
        return '❌';
      case 'abstain':
        return '⚪';
      default:
        return '📝';
    }
  };

  if (loading) {
    return (
      <div className="speaking-queue-panel">
        <div className="panel-loading">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="speaking-queue-panel">
        <div className="panel-error">{error}</div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const statusDisplay = getStatusDisplay(data.discussionStatus);

  return (
    <div className="speaking-queue-panel">
      {/* 标题 */}
      <div className="panel-header">
        <div className="panel-title">
          <span>🎙️</span>
          <span>发言队列</span>
        </div>
        <div className="panel-status">
          {statusDisplay.icon} {statusDisplay.text}
        </div>
      </div>

      {/* 轮次信息 */}
      <div className="round-info">
        <span>轮次: {data.currentRound}/{data.maxRounds}</span>
        <span>消息: {data.stats.totalMessages}</span>
        <span>进度: {data.stats.consensusProgress}%</span>
      </div>

      {/* 发言队列 */}
      <div className="queue-section">
        {/* 等待发言 */}
        {data.waitingQueue.length > 0 && (
          <div className="waiting-section">
            <div className="section-title">⏳ 等待发言</div>
            <div className="queue-list">
              {data.waitingQueue.map((item) => (
                <div key={item.roleId} className="queue-item waiting">
                  <span className="queue-order">{item.order}.</span>
                  <span className="stance-icon">{getStanceIcon(item.stance)}</span>
                  <span className="role-name">{item.roleName}</span>
                  <span className="role-level">L{item.roleLevel}</span>
                  <span className="stance-label">{item.stance}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 已发言 */}
        {data.spokenThisRound.length > 0 && (
          <div className="spoken-section">
            <div className="section-title">✅ 已发言</div>
            <div className="queue-list">
              {data.spokenThisRound.map((item) => (
                <div key={item.roleId} className="queue-item spoken">
                  <span className="stance-icon">💬</span>
                  <span className="role-name">{item.roleName}</span>
                  <span className="speak-count">{item.speakCount}次</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 投票表决 */}
      {data.voting && (
        <div className="voting-section">
          <div className="section-title">📊 投票表决</div>
          
          {/* 投票统计 */}
          <div className="vote-stats">
            <div className="vote-item approve">
              <span>✅ 同意</span>
              <span>{data.voting.votes.approve}</span>
            </div>
            <div className="vote-item reject">
              <span>❌ 拒绝</span>
              <span>{data.voting.votes.reject}</span>
            </div>
            <div className="vote-item abstain">
              <span>⚪ 弃权</span>
              <span>{data.voting.votes.abstain}</span>
            </div>
            <div className="vote-item pending">
              <span>⏳ 待投票</span>
              <span>{data.voting.votes.pending}</span>
            </div>
          </div>

          {/* 待投票角色 */}
          {data.voting.pendingVoters.length > 0 && (
            <div className="pending-voters">
              <span>待投票: </span>
              {data.voting.pendingVoters.map((v) => v.roleName).join(', ')}
            </div>
          )}

          {/* 通过标准 */}
          <div className="voting-rule">
            通过标准: {data.voting.votingRule.mode} (最少 {data.voting.votingRule.minApprovers} 人)
          </div>

          {/* 架构师否决权 */}
          {data.voting.architectVeto.canVeto && (
            <div className="architect-veto">
              {data.voting.architectVeto.hasVetoed ? (
                <span className="vetoed">⚠️ 架构师已否决</span>
              ) : (
                <span className="can-veto">🏗️ 架构师可否决</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 签名确认 */}
      {data.signatures && (
        <div className="signatures-section">
          <div className="section-title">✍️ 签名确认</div>
          
          {/* 签名进度 */}
          <div className="signature-progress">
            签名进度: {data.signatures.progress.signedCount}/{data.signatures.progress.totalCount} ({data.signatures.progress.percentage}%)
          </div>

          {/* 已签名 */}
          {data.signatures.signed.length > 0 && (
            <div className="signed-list">
              {data.signatures.signed.map((s) => (
                <div key={s.roleId} className="signature-item">
                  <span className="verdict-icon">{getVerdictIcon(s.verdict)}</span>
                  <span className="role-name">{s.roleName}</span>
                  <span className="signed-at">
                    {new Date(s.signedAt).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 待签名 */}
          {data.signatures.pending.length > 0 && (
            <div className="pending-signatures">
              <span>待签名: </span>
              {data.signatures.pending.map((p) => p.roleName).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SpeakingQueuePanel;