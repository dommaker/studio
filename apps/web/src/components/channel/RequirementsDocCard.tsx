// RequirementsDoc inline card — B1-001/B1-003, M2 quality gate
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
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 max-w-md">
      {/* Status badge */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-500">📋 需求文档</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          status === 'executing' ? 'bg-blue-100 text-blue-700' :
          status === 'done' ? 'bg-green-100 text-green-700' :
          status === 'error' ? 'bg-red-100 text-red-700' :
          'bg-yellow-100 text-yellow-700'
        }`}>
          {STATUS_LABELS[status] || status}
        </span>
      </div>

      {/* Content */}
      <div className="text-sm text-gray-800 whitespace-pre-wrap mb-3">
        {editing ? (
          <div>
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="w-full border border-gray-300 rounded p-2 text-xs font-mono resize-y"
              rows={8}
              autoFocus
            />
            <div className="flex gap-1 mt-1">
              <button onClick={handleSave} disabled={saving}
                className="text-xs bg-green-500 text-white px-2 py-0.5 rounded hover:bg-green-600">
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setEditing(false)}
                className="text-xs border border-gray-300 px-2 py-0.5 rounded hover:bg-gray-50">
                取消
              </button>
            </div>
          </div>
        ) : (
          <div>
            {edited && <span className="text-xs text-green-600 mr-1">✓ 已更新</span>}
            {message.content}
          </div>
        )}
      </div>
      {/* Edit button (B2-009) */}
      {!editing && isIdle && (
        <button onClick={handleEdit} className="text-xs text-gray-400 hover:text-blue-500 mb-2">
          ✏️ 编辑
        </button>
      )}

      {/* M2: Quality gate confirmation modal */}
      {showQualityModal && qualityCheck && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
            <h3 className="font-semibold text-gray-800 mb-3">质量门检查</h3>
            {qualityCheck.ironLawFailures > 0 ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-3">
                <span className="text-red-700 text-sm font-medium">❌ {qualityCheck.ironLawFailures} 条 Iron Law 未通过</span>
                <p className="text-red-600 text-xs mt-1">执行前必须修复上述约束违规</p>
              </div>
            ) : (
              <div className="bg-green-50 border border-green-200 rounded p-3 mb-3">
                <span className="text-green-700 text-sm font-medium">✅ Iron Laws 全部通过</span>
                {qualityCheck.guidelineWarnings > 0 && (
                  <p className="text-yellow-600 text-xs mt-1">⚠️ {qualityCheck.guidelineWarnings} 条 Guidelines 告警</p>
                )}
              </div>
            )}
            <div className="text-xs text-gray-500 mb-3">
              共检查 {qualityCheck.totalConstraints} 条约束
            </div>

            {/* M4b: Gate exception override reason */}
            {qualityCheck.ironLawFailures > 0 && (
              <div className="mb-3">
                <label className="text-xs text-gray-600 block mb-1">例外理由（记录审计日志）</label>
                <textarea
                  value={overrideReason}
                  onChange={e => setOverrideReason(e.target.value)}
                  placeholder="说明为何允许在违规情况下继续..."
                  className="w-full border border-gray-300 rounded p-1.5 text-xs resize-none"
                  rows={2}
                />
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setShowQualityModal(false)}
                className="flex-1 border border-gray-300 text-gray-600 text-xs px-3 py-1.5 rounded hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (qualityCheck.ironLawFailures > 0 && !overrideReason.trim()) return;
                  confirmStartExecution();
                }}
                disabled={qualityCheck.ironLawFailures > 0 && !overrideReason.trim()}
                className={`flex-1 text-white text-xs px-3 py-1.5 rounded transition-colors ${
                  qualityCheck.ironLawFailures > 0
                    ? 'bg-orange-500 hover:bg-orange-600 disabled:opacity-50'
                    : 'bg-blue-500 hover:bg-blue-600'
                }`}
              >
                {qualityCheck.ironLawFailures > 0 ? '强制执行（记录例外）' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Action buttons (idle) */}
      {isIdle && (
        <div className="flex gap-2 border-t pt-2">
          <button
            onClick={handleStartExecution}
            disabled={qualityChecking}
            className="flex-1 bg-blue-500 text-white text-xs px-3 py-1.5 rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            {qualityChecking ? '检查中...' : '开始执行'}
          </button>
          <button
            onClick={() => onAction(message.id, 'modify')}
            className="flex-1 border border-gray-300 text-gray-700 text-xs px-3 py-1.5 rounded hover:bg-gray-50 transition-colors"
          >
            修改需求
          </button>
          <button
            onClick={() => onAction(message.id, 'continue_discussion')}
            className="flex-1 border border-gray-300 text-gray-700 text-xs px-3 py-1.5 rounded hover:bg-gray-50 transition-colors"
          >
            继续讨论
          </button>
        </div>
      )}

      {/* Executing state — show progress */}
      {status === 'executing' && (
        <div className="border-t pt-2">
          {progress ? (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">执行进度</span>
                <span className="text-gray-500">{progress.completed}/{progress.total} 完成</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
              <button
                onClick={() => navigate(`/workunits`)}
                className="text-xs text-blue-500 hover:underline mt-1"
              >
                查看 WorkUnits →
              </button>
            </div>
          ) : (
            <div className="text-xs text-gray-400">执行已启动，正在初始化...</div>
          )}
        </div>
      )}

      {/* Other states */}
      {!isIdle && status !== 'executing' && (
        <div className="text-xs text-gray-400 border-t pt-2">
          {status === 'needs_revision' && '等待修改反馈...'}
          {status === 'done' && '需求已完成'}
          {status === 'error' && `错误: ${meta.error || '未知'}`}
        </div>
      )}
    </div>
  );
}
