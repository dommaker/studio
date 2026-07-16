// SpecReviewTab.tsx - Spec 审查 Tab 组件
import { useState, useEffect } from 'react';
import { getApiBase } from '../utils/api';
import { toast } from '../utils/toast';
import '../styles/theme.css';

export interface SpecChange {
  id: string;
  type: 'architecture' | 'api' | 'data-model' | 'workflow' | 'step' | 'skill' | 'other';
  file: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  status: 'pending' | 'approved' | 'rejected';
  diff?: string;
  createdAt: string;
  createdBy: string;
}

export interface SpecReview {
  id: string;
  changes: SpecChange[];
  approvals: {
    architect: { approved: boolean; reviewer?: string; comment?: string; timestamp?: string };
    projectLead: { approved: boolean; reviewer?: string; comment?: string; timestamp?: string };
  };
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

interface SpecReviewTabProps {
  projectId: string;
  workflowName?: string;
}

const CHANGE_TYPE_CONFIG = {
  architecture: { label: '架构变更', icon: '🏗️', color: '#9C27B0' },
  api: { label: 'API 变更', icon: '🔌', color: '#2196F3' },
  'data-model': { label: '数据模型变更', icon: '📊', color: '#FF9800' },
  workflow: { label: '工作流变更', icon: '🔄', color: '#4CAF50' },
  step: { label: '步骤变更', icon: '📝', color: '#00BCD4' },
  skill: { label: 'Skill 变更', icon: '🎯', color: '#E91E63' },
  other: { label: '其他变更', icon: '📄', color: '#9E9E9E' },
};

const IMPACT_CONFIG = {
  high: { label: '高影响', color: '#F44336', bg: 'rgba(244, 67, 54, 0.1)' },
  medium: { label: '中影响', color: '#FF9800', bg: 'rgba(255, 152, 0, 0.1)' },
  low: { label: '低影响', color: '#4CAF50', bg: 'rgba(76, 175, 80, 0.1)' },
};

export function SpecReviewTab({ projectId }: SpecReviewTabProps) {
  const [reviews, setReviews] = useState<SpecReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedReview, setSelectedReview] = useState<SpecReview | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadReviews();
  }, [projectId]);

  const loadReviews = async () => {
    setLoading(true);
    try {
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/spec-reviews`);
      
      if (!response.ok) {
        // 如果 API 不存在，显示模拟数据
        setReviews([]);
        return;
      }
      
      const data = await response.json();
      setReviews(data.reviews || []);
    } catch (err: any) {
      console.error('加载审查列表失败:', err);
      setReviews([]);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickApprove = async (review: SpecReview, role: 'architect' | 'projectLead') => {
    setSubmitting(true);
    try {
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/spec-reviews/${review.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          reviewerId: 'current-user',
          reviewerName: '当前用户',
          approved: true,
        }),
      });
      
      if (!response.ok) throw new Error('批准失败');
      
      await loadReviews();
    } catch (err: any) {
      toast.error(`批准失败: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickReject = async (review: SpecReview, role: 'architect' | 'projectLead') => {
    const reason = prompt('请输入拒绝原因：');
    if (!reason) return;
    
    setSubmitting(true);
    try {
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/spec-reviews/${review.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          reviewerId: 'current-user',
          reviewerName: '当前用户',
          approved: false,
          comment: reason,
        }),
      });
      
      if (!response.ok) throw new Error('拒绝失败');
      
      await loadReviews();
    } catch (err: any) {
      toast.error(`拒绝失败: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // 统计
  const pendingCount = reviews.filter(r => r.status === 'pending').length;
  const approvedCount = reviews.filter(r => r.status === 'approved').length;
  const rejectedCount = reviews.filter(r => r.status === 'rejected').length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="loading-spinner"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold" style={{ color: '#FF9800' }}>{pendingCount}</div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>待审查</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold" style={{ color: '#4CAF50' }}>{approvedCount}</div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>已通过</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold" style={{ color: '#F44336' }}>{rejectedCount}</div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>已拒绝</div>
        </div>
      </div>

      {/* 审查列表 */}
      {reviews.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-4xl mb-2">📋</div>
          <p style={{ color: 'var(--text-secondary)' }}>暂无 Spec 审查记录</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
            当工作流发生关键变更时，会自动创建审查流程
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reviews.map(review => (
            <div
              key={review.id}
              className="card p-4 cursor-pointer hover:border-opacity-50 transition-all"
              style={{
                borderLeft: review.status === 'pending' ? '4px solid #FF9800' :
                           review.status === 'approved' ? '4px solid #4CAF50' : '4px solid #F44336',
              }}
              onClick={() => setSelectedReview(review)}
            >
              {/* 变更概要 */}
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    {review.changes.map((change, idx) => {
                      const config = CHANGE_TYPE_CONFIG[change.type];
                      return (
                        <span
                          key={idx}
                          className="text-xs px-2 py-1 rounded"
                          style={{ background: `${config.color}20`, color: config.color }}
                        >
                          {config.icon} {config.label}
                        </span>
                      );
                    })}
                  </div>
                  
                  <div className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {review.changes.length} 个变更文件
                  </div>
                  
                  {/* 审批状态 */}
                  <div className="flex items-center gap-4 text-xs">
                    <span style={{ color: review.approvals.architect.approved ? '#4CAF50' : 'var(--text-muted)' }}>
                      {review.approvals.architect.approved ? '✅' : '⏳'} 架构师
                    </span>
                    <span style={{ color: review.approvals.projectLead.approved ? '#4CAF50' : 'var(--text-muted)' }}>
                      {review.approvals.projectLead.approved ? '✅' : '⏳'} 项目负责人
                    </span>
                  </div>
                </div>
                
                {/* 快速操作（仅待审查状态显示） */}
                {review.status === 'pending' && (
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleQuickApprove(review, 'architect');
                      }}
                      disabled={submitting}
                      className="btn btn-sm btn-primary"
                    >
                      ✅ 批准
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleQuickReject(review, 'architect');
                      }}
                      disabled={submitting}
                      className="btn btn-sm btn-danger"
                    >
                      ❌ 拒绝
                    </button>
                  </div>
                )}
              </div>
              
              {/* 时间 */}
              <div className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {new Date(review.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 审查详情弹窗 */}
      {selectedReview && (
        <div className="modal-overlay" onClick={() => setSelectedReview(null)}>
          <div
            className="modal-content"
            style={{ maxWidth: '800px', maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">Spec 审查详情</h3>
              <button onClick={() => setSelectedReview(null)} className="modal-close">✕</button>
            </div>
            
            <div className="space-y-4">
              {/* 变更列表 */}
              <div>
                <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                  变更内容
                </h4>
                <div className="space-y-2">
                  {selectedReview.changes.map((change, idx) => {
                    const typeConfig = CHANGE_TYPE_CONFIG[change.type];
                    const impactConfig = IMPACT_CONFIG[change.impact];
                    
                    return (
                      <div key={idx} className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span style={{ color: typeConfig.color }}>{typeConfig.icon}</span>
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {change.file}
                            </span>
                          </div>
                          <span
                            className="text-xs px-2 py-1 rounded"
                            style={{ background: impactConfig.bg, color: impactConfig.color }}
                          >
                            {impactConfig.label}
                          </span>
                        </div>
                        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          {change.description}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
              
              {/* 审批进度 */}
              <div>
                <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                  审批进度
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  {/* 架构师 */}
                  <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        🏗️ 架构师
                      </span>
                      <span style={{ color: selectedReview.approvals.architect.approved ? '#4CAF50' : 'var(--text-muted)' }}>
                        {selectedReview.approvals.architect.approved ? '✅ 已批准' : '⏳ 待审查'}
                      </span>
                    </div>
                    {selectedReview.approvals.architect.comment && (
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        "{selectedReview.approvals.architect.comment}"
                      </p>
                    )}
                  </div>
                  
                  {/* 项目负责人 */}
                  <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        👤 项目负责人
                      </span>
                      <span style={{ color: selectedReview.approvals.projectLead.approved ? '#4CAF50' : 'var(--text-muted)' }}>
                        {selectedReview.approvals.projectLead.approved ? '✅ 已批准' : '⏳ 待审查'}
                      </span>
                    </div>
                    {selectedReview.approvals.projectLead.comment && (
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        "{selectedReview.approvals.projectLead.comment}"
                      </p>
                    )}
                  </div>
                </div>
              </div>
              
              {/* 评论 */}
              <div>
                <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                  添加评论
                </h4>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="输入您的审查意见..."
                  className="w-full p-3 rounded-lg resize-none"
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    minHeight: '80px',
                  }}
                />
              </div>
            </div>
            
            {/* 操作按钮 */}
            <div className="mt-6 flex gap-3">
              {selectedReview.status === 'pending' && (
                <>
                  <button
                    onClick={() => handleQuickApprove(selectedReview, 'architect')}
                    disabled={submitting}
                    className="btn btn-primary flex-1"
                  >
                    ✅ 批准
                  </button>
                  <button
                    onClick={() => handleQuickReject(selectedReview, 'architect')}
                    disabled={submitting}
                    className="btn btn-danger flex-1"
                  >
                    ❌ 拒绝
                  </button>
                </>
              )}
              <button
                onClick={() => setSelectedReview(null)}
                className="btn btn-secondary"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SpecReviewTab;
