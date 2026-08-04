// MultiStanceReviewPanel.tsx - 多立场审核面板
import { useState } from 'react';
import { ReviewOpinionCard } from './ReviewOpinionCard';
import { StanceBadge } from './StanceBadge';

// 立场配置（与 DiscussionDriver 统一）
// 颜色按立场分组归并到语义 token（同 StanceBadge：赞成方=success / 反对方=error / 中立=text-secondary）
const STANCES = {
  advocate: { name: '倡导者', color: 'var(--success)', icon: '📢', desc: '论证方案可行性，提供证据' },
  skeptic: { name: '质疑者', color: 'var(--error)', icon: '🔍', desc: '找出潜在问题，提出替代方案' },
  neutral: { name: '中立者', color: 'var(--text-secondary)', icon: '⚖️', desc: '客观分析各方观点，指出风险' },
  pragmatist: { name: '实用主义者', color: 'var(--success)', icon: '🔧', desc: '关注实施成本、时间线' },
  visionary: { name: '远见者', color: 'var(--success)', icon: '🚀', desc: '关注长期影响、战略价值' },
  executor: { name: '执行者', color: 'var(--success)', icon: '⚙️', desc: '关注任务分配、验收标准' },
  reviewer: { name: '审查者', color: 'var(--error)', icon: '📋', desc: '确保质量合规性' },
  architect: { name: '架构师', color: 'var(--error)', icon: '🏗️', desc: '评估技术方案架构影响' },
};

// 审核结果配置
const REVIEW_RESULTS = {
  approve: { label: '支持', icon: '✅', color: 'var(--success)' },
  reject: { label: '反对', icon: '❌', color: 'var(--error)' },
  neutral: { label: '中立', icon: '⚖️', color: 'var(--text-secondary)' },
  conditional: { label: '有条件支持', icon: '⚠️', color: 'var(--warning)' },
};

export interface ReviewOpinion {
  id: string;
  roleId: string;
  roleName: string;
  roleType: string;
  stance: keyof typeof STANCES;
  result: keyof typeof REVIEW_RESULTS;
  opinion: string;
  suggestions?: string[];
  timestamp: string;
}

export interface MultiStanceReview {
  id: string;
  contentId: string;
  contentType: 'plan' | 'code' | 'design' | 'contract' | 'architecture';
  content: string;
  title?: string;
  opinions: ReviewOpinion[];
  status: 'pending' | 'reviewing' | 'decided' | 'modified';
  decision?: 'adopt' | 'adopt-with-mods' | 'reject' | 'continue';
  createdAt: string;
}

interface MultiStanceReviewPanelProps {
  review: MultiStanceReview;
  onDecide?: (decision: string) => void;
  onAddReviewer?: () => void;
  onModify?: () => void;
  onClose?: () => void;
}

export function MultiStanceReviewPanel({
  review,
  onDecide,
  onAddReviewer,
  onModify,
  onClose,
}: MultiStanceReviewPanelProps) {
  const [selectedOpinion, setSelectedOpinion] = useState<ReviewOpinion | null>(null);
  const [showDecisionModal, setShowDecisionModal] = useState(false);
  const [decisionComment, setDecisionComment] = useState('');

  // 计算审核统计
  const stats = {
    total: review.opinions.length,
    approve: review.opinions.filter(o => o.result === 'approve').length,
    reject: review.opinions.filter(o => o.result === 'reject').length,
    neutral: review.opinions.filter(o => o.result === 'neutral').length,
    conditional: review.opinions.filter(o => o.result === 'conditional').length,
  };

  // 判断是否可以采纳
  const canAdopt = stats.reject === 0 && stats.approve > 0;
  const hasIssues = stats.reject > 0;

  // 处理决策
  const handleDecision = (decision: string) => {
    if (onDecide) {
      onDecide(decision);
    }
    setShowDecisionModal(false);
  };

  // 获取内容类型图标
  const contentIcons = {
    plan: '📋',
    code: '💻',
    design: '🎨',
    contract: '📜',
    architecture: '🏗️',
  };

  return (
    <div className="multi-stance-review-panel" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-primary)',
    }}>
      {/* 头部 */}
      <div className="review-header" style={{
        padding: '16px 24px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div>
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {contentIcons[review.contentType]} 多立场审核
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {review.title || `审核 ${review.contentType} - ${review.contentId.slice(0, 8)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="px-3 py-1 rounded text-sm"
            style={{
              background: review.status === 'reviewing' ? 'var(--warning-dim)' : 'var(--success-dim)',
              color: review.status === 'reviewing' ? 'var(--warning)' : 'var(--success)',
            }}
          >
            {review.status === 'reviewing' ? '审核中' : review.status === 'decided' ? '已决策' : '待审核'}
          </span>
          {onClose && (
            <button onClick={onClose} className="btn btn-ghost">✕</button>
          )}
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="review-stats" style={{
        padding: '12px 24px',
        display: 'flex',
        gap: '16px',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div className="stat-card" style={{
          padding: '8px 16px',
          borderRadius: '8px',
          background: 'var(--bg-secondary)',
        }}>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>审核数: </span>
          <span className="font-bold">{stats.total}</span>
        </div>
        <div className="stat-card" style={{ background: 'var(--success-dim)' }}>
          <span className="text-sm" style={{ color: 'var(--success)' }}>✅ 支持: {stats.approve}</span>
        </div>
        <div className="stat-card" style={{ background: 'var(--error-dim)' }}>
          <span className="text-sm" style={{ color: 'var(--error)' }}>❌ 反对: {stats.reject}</span>
        </div>
        <div className="stat-card" style={{ background: 'var(--bg-tertiary)' }}>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>⚖️ 中立: {stats.neutral}</span>
        </div>
        <div className="stat-card" style={{ background: 'var(--warning-dim)' }}>
          <span className="text-sm" style={{ color: 'var(--warning)' }}>⚠️ 有条件: {stats.conditional}</span>
        </div>
      </div>

      {/* 主内容区域 */}
      <div className="review-body" style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
      }}>
        {/* 左侧：待审核内容 */}
        <div className="review-content" style={{
          width: '40%',
          padding: '16px',
          overflow: 'auto',
          borderRight: '1px solid var(--border-subtle)',
        }}>
          <div className="text-sm font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            待审核内容
          </div>
          <div
            className="content-viewer p-4 rounded"
            style={{
              background: 'var(--bg-secondary)',
              minHeight: '200px',
              maxHeight: 'calc(100vh - 300px)',
              overflow: 'auto',
            }}
          >
            <pre style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '14px',
              color: 'var(--text-primary)',
            }}>
              {review.content}
            </pre>
          </div>
        </div>

        {/* 右侧：审核意见列表 */}
        <div className="review-opinions" style={{
          width: '60%',
          padding: '16px',
          overflow: 'auto',
        }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              审核意见 ({review.opinions.length})
            </div>
            {onAddReviewer && (
              <button onClick={onAddReviewer} className="btn btn-ghost text-sm">
                ➕ 添加审核角色
              </button>
            )}
          </div>

          {/* 按立场分组 */}
          {Object.keys(STANCES).map(stance => {
            const opinions = review.opinions.filter(o => o.stance === stance);
            if (opinions.length === 0) return null;

            return (
              <div key={stance} className="stance-group mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <StanceBadge stance={stance as keyof typeof STANCES} />
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {opinions.length} 条意见
                  </span>
                </div>
                <div className="space-y-2">
                  {opinions.map(opinion => (
                    <ReviewOpinionCard
                      key={opinion.id}
                      opinion={opinion}
                      selected={selectedOpinion?.id === opinion.id}
                      onClick={() => setSelectedOpinion(opinion)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {/* 无意见提示 */}
          {review.opinions.length === 0 && (
            <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
              暂无审核意见
              {onAddReviewer && (
                <button onClick={onAddReviewer} className="btn btn-primary mt-4">
                  开始审核
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 决策区域 */}
      <div className="review-footer" style={{
        padding: '16px 24px',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        {/* 决策提示 */}
        <div>
          {hasIssues && (
            <div className="text-sm" style={{ color: 'var(--error)' }}>
              ⚠️ 存在反对意见，请谨慎决策
            </div>
          )}
          {canAdopt && (
            <div className="text-sm" style={{ color: 'var(--success)' }}>
              ✅ 所有审核者支持，可以采纳
            </div>
          )}
        </div>

        {/* 决策按钮 */}
        <div className="flex gap-3">
          {onModify && (
            <button onClick={onModify} className="btn btn-ghost">
              修改方案
            </button>
          )}
          {onAddReviewer && (
            <button onClick={onAddReviewer} className="btn btn-ghost">
              继续审核
            </button>
          )}
          <button
            onClick={() => setShowDecisionModal(true)}
            className="btn btn-primary"
            disabled={review.opinions.length === 0}
          >
            提交决策
          </button>
        </div>
      </div>

      {/* 决策弹窗 */}
      {showDecisionModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h3 className="font-bold">提交审核决策</h3>
            </div>
            <div className="modal-body">
              <div className="mb-4">
                <label className="text-sm font-bold">选择决策</label>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button
                    onClick={() => handleDecision('adopt')}
                    className="p-3 rounded flex items-center gap-2"
                    style={{ background: 'var(--success-dim)', border: '2px solid var(--success)' }}
                    disabled={hasIssues}
                  >
                    <span>✅</span>
                    <span>采纳方案</span>
                  </button>
                  <button
                    onClick={() => handleDecision('adopt-with-mods')}
                    className="p-3 rounded flex items-center gap-2"
                    style={{ background: 'var(--warning-dim)', border: '2px solid var(--warning)' }}
                  >
                    <span>⚠️</span>
                    <span>修改后采纳</span>
                  </button>
                  <button
                    onClick={() => handleDecision('reject')}
                    className="p-3 rounded flex items-center gap-2"
                    style={{ background: 'var(--error-dim)', border: '2px solid var(--error)' }}
                  >
                    <span>❌</span>
                    <span>拒绝方案</span>
                  </button>
                  <button
                    onClick={() => handleDecision('continue')}
                    className="p-3 rounded flex items-center gap-2"
                    style={{ background: 'var(--accent-dim)', border: '2px solid var(--accent-primary)' }}
                  >
                    <span>🔍</span>
                    <span>继续审核</span>
                  </button>
                </div>
              </div>
              <div className="mb-4">
                <label className="text-sm font-bold">决策说明（可选）</label>
                <textarea
                  value={decisionComment}
                  onChange={(e) => setDecisionComment(e.target.value)}
                  className="input w-full mt-1"
                  rows={3}
                  placeholder="输入决策原因或说明..."
                />
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowDecisionModal(false)} className="btn btn-ghost">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}