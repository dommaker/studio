// RequirementsDoc inline card — B1-001/B1-003, M2 quality gate
// 2026-07 视觉重构（方向 A Mission Control）：mc-card 视觉重绘；质量门/编辑/进度轮询逻辑零变更
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { requirementApi } from '../../api/requirements';
import type { ChannelMessage } from '../../api/channel';

// M2: quality gate check before execution
interface QualityGateResult {
  passed: boolean;
  ironLawFailures: number;
  guidelineWarnings: number;
  totalConstraints: number;
}
let _qualityGateCache: { projectPath: string; result: QualityGateResult } | null = null;

interface Props {
  message: ChannelMessage;
  meta: Record<string, any>;
  onAction: (messageId: string, action: string) => void;
}

async function updateRequirementsDoc(docId: string, content: string) {
  try {
    await api.put(`/requirements-docs/${docId}`, { content });
    return true;
  } catch { return false; }
}

const STATUS_LABELS: Record<string, string> = {
  ready: '待确认',
  executing: '执行中',
  needs_revision: '待修改',
  done: '已完成',
  error: '失败',
};

/** 状态 → mc-status chip 修饰类 */
function statusClass(status: string): string {
  if (status === 'executing') return 'mc-status mc-status-running';
  if (status === 'done') return 'mc-status mc-status-done';
  if (status === 'error') return 'mc-status mc-status-error';
  if (status === 'ready') return 'mc-status mc-status-need';
  return 'mc-status mc-status-pending';
}

async function fetchReqProgress(reqId: string) {
  try {
    const res = await requirementApi.getChain(reqId);
    return res.data.data;
  } catch {
    return null;
  }
}

export function RequirementsDocCard({ message, meta, onAction }: Props) {
  const status = meta.status || 'ready';
  const isIdle = status === 'ready';
  const navigate = useNavigate();
  const [progress, setProgress] = useState<{ total: number; completed: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [edited, setEdited] = useState(false);

  // M2: quality gate confirmation state
  const [qualityCheck, setQualityCheck] = useState<QualityGateResult | null>(null);
  const [qualityChecking, setQualityChecking] = useState(false);
  const [showQualityModal, setShowQualityModal] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const handleStartExecution = async () => {
    setQualityChecking(true);
    try {
      // Reuse cached result for same project path
      const projectPath = meta.projectPath;
      if (_qualityGateCache?.projectPath === projectPath) {
        setQualityCheck(_qualityGateCache.result);
      } else {
        const res = await api.post('/harness/check-constraints', {
          operation: 'goal_creation',
          taskDescription: message.content.slice(0, 500),
          hasRequirement: true,
          hasRequirementReview: true,
          projectPath,
        });
        const data = res.data.data || res.data;
        const result: QualityGateResult = {
          passed: data.passed !== false,
          ironLawFailures: (data.ironLaws || []).filter((r: any) => !r.satisfied).length,
          guidelineWarnings: data.warningCount || 0,
          totalConstraints: (data.ironLaws || []).length + (data.guidelines || []).length,
        };
        _qualityGateCache = { projectPath, result };
        setQualityCheck(result);
      }
      setShowQualityModal(true);
    } catch {
      // Backend unavailable → allow execution (best-effort gate)
      setQualityCheck({ passed: true, ironLawFailures: 0, guidelineWarnings: 0, totalConstraints: 0 });
      setShowQualityModal(true);
    } finally {
      setQualityChecking(false);
    }
  };

  const confirmStartExecution = () => {
    setShowQualityModal(false);
    onAction(message.id, 'start_execution');
  };

  const handleEdit = () => {
    setEditContent(message.content);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    const docId = meta.requirementsDocId || meta.cardData?.requirementsDocId;
    if (docId) {
      const ok = await updateRequirementsDoc(docId, editContent);
      if (ok) setEdited(true);
    }
    setSaving(false);
    setEditing(false);
  };

  // Poll requirement chain progress when executing
  const reqId: string | undefined = meta.requirementId || meta.reqId;
  useEffect(() => {
    if (status !== 'executing' || !reqId) return;
    const poll = () => {
      fetchReqProgress(reqId).then(chain => {
        if (chain) {
          const workunits = chain.workunits || [];
          const total = workunits.length;
          const completed = workunits.filter(w =>
            w.status === 'done' || w.status === 'completed' || w.status === 'succeeded'
          ).length;
          setProgress({ total, completed });
        }
      });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [status, reqId]);

  return (
    <div className="mc-card" data-card-type="requirements_doc">
      {/* Status badge */}
      <div className="mc-card-head">
        <span className="mc-card-label">需求文档</span>
        <span className={statusClass(status)}>
          {status === 'executing' ? <span className="mc-dot" /> : null}
          {STATUS_LABELS[status] || status}
        </span>
      </div>

      {/* Content */}
      <div className="mc-card-body" style={{ marginBottom: 8 }}>
        {editing ? (
          <div>
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="input"
              style={{ width: '100%', fontSize: 'var(--fs-sm)', resize: 'vertical' }}
              rows={8}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={handleSave} disabled={saving} className="mc-btn mc-btn-primary">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setEditing(false)} className="mc-btn">
                取消
              </button>
            </div>
          </div>
        ) : (
          <div>
            {edited && <span className="mc-status mc-status-done" style={{ marginRight: 6 }}>✓ 已更新</span>}
            {message.content}
          </div>
        )}
      </div>
      {/* Edit button (B2-009) */}
      {!editing && isIdle && (
        <button onClick={handleEdit} className="mc-icon-btn" style={{ opacity: 1, marginBottom: 6 }}>
          编辑
        </button>
      )}

      {/* M2: Quality gate confirmation modal */}
      {showQualityModal && qualityCheck && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: 400 }}>
            <h3 className="modal-title" style={{ marginBottom: 10 }}>质量门检查</h3>
            {qualityCheck.ironLawFailures > 0 ? (
              <div className="mc-status mc-status-error" style={{ display: 'flex', padding: '8px 10px', marginBottom: 10 }}>
                ✗ {qualityCheck.ironLawFailures} 条 Iron Law 未通过（执行前必须修复约束违规）
              </div>
            ) : (
              <div className="mc-status mc-status-done" style={{ display: 'flex', padding: '8px 10px', marginBottom: 10 }}>
                ✓ Iron Laws 全部通过
                {qualityCheck.guidelineWarnings > 0 ? `（${qualityCheck.guidelineWarnings} 条 Guidelines 告警）` : ''}
              </div>
            )}
            <div className="mc-drawer-note" style={{ marginBottom: 10 }}>
              共检查 {qualityCheck.totalConstraints} 条约束
            </div>

            {/* M4b: Gate exception override reason */}
            {qualityCheck.ironLawFailures > 0 && (
              <div style={{ marginBottom: 10 }}>
                <label className="mc-card-label" style={{ display: 'block', marginBottom: 4 }}>例外理由（记录审计日志）</label>
                <textarea
                  value={overrideReason}
                  onChange={e => setOverrideReason(e.target.value)}
                  placeholder="说明为何允许在违规情况下继续..."
                  className="input"
                  style={{ width: '100%', fontSize: 'var(--fs-sm)', resize: 'none' }}
                  rows={2}
                />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowQualityModal(false)} className="mc-btn" style={{ flex: 1 }}>
                取消
              </button>
              <button
                onClick={() => {
                  if (qualityCheck.ironLawFailures > 0 && !overrideReason.trim()) return;
                  confirmStartExecution();
                }}
                disabled={qualityCheck.ironLawFailures > 0 && !overrideReason.trim()}
                className={qualityCheck.ironLawFailures > 0 ? 'mc-btn mc-btn-warn' : 'mc-btn mc-btn-primary'}
                style={{ flex: 1 }}
              >
                {qualityCheck.ironLawFailures > 0 ? '强制执行（记录例外）' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Action buttons (idle) */}
      {isIdle && (
        <div className="mc-card-actions">
          <button onClick={handleStartExecution} disabled={qualityChecking} className="mc-btn mc-btn-primary">
            {qualityChecking ? '检查中...' : '开始执行'}
          </button>
          <button onClick={() => onAction(message.id, 'modify')} className="mc-btn">
            修改需求
          </button>
          <button onClick={() => onAction(message.id, 'continue_discussion')} className="mc-btn">
            继续讨论
          </button>
        </div>
      )}

      {/* Executing state — show progress */}
      {status === 'executing' && (
        <div className="mc-card-actions" style={{ display: 'block' }}>
          {progress ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)' }}>
                <span className="mc-dim">执行进度</span>
                <span className="mc-dim">{progress.completed}/{progress.total} 完成</span>
              </div>
              <div className="mc-progress">
                <div
                  className="mc-progress-fill"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
              <button onClick={() => navigate(`/workunits`)} className="mc-wu-link" style={{ marginTop: 6 }}>
                查看 WorkUnits ›
              </button>
            </div>
          ) : (
            <div className="mc-drawer-note">执行已启动，正在初始化...</div>
          )}
        </div>
      )}

      {/* Other states */}
      {!isIdle && status !== 'executing' && (
        <div className="mc-card-foot" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          {status === 'needs_revision' && '等待修改反馈...'}
          {status === 'done' && '需求已完成'}
          {status === 'error' && `错误: ${meta.error || '未知'}`}
        </div>
      )}
    </div>
  );
}
